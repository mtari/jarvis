import Database from "better-sqlite3";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "./anthropic-client.ts";
import { appendEvent } from "./event-log.ts";

export interface AgentCallInfo {
  request: ChatRequest;
  response: ChatResponse;
  durationMs: number;
}

export type CallEmitter = (info: AgentCallInfo) => void;

/**
 * Wraps an AnthropicClient so each chat() call's metadata is forwarded to
 * `emit`. The emitter is wrapped in a try/catch so any telemetry failure is
 * swallowed — telemetry never breaks the agent loop.
 */
export function instrumentClient(
  client: AnthropicClient,
  emit: CallEmitter,
): AnthropicClient {
  return {
    async chat(req) {
      const start = Date.now();
      const response = await client.chat(req);
      try {
        emit({ request: req, response, durationMs: Date.now() - start });
      } catch {
        // Telemetry failures stay silent — never break the agent loop.
      }
      return response;
    },
  };
}

export interface InstrumentationContext {
  app: string;
  vault: string;
  agent: string;
  /** Filled in mid-flight when the agent generates the plan id (e.g., new drafts). */
  planId?: string;
  /**
   * Which runtime produced the call: 'api' (legacy Anthropic API, billed per
   * token) or 'subscription' (Claude Agent SDK driving the local CLI under
   * the user's Pro/MAX subscription). Recorded on every `agent-call` event so
   * `yarn jarvis cost` can distinguish pre/post-pivot rows. See §18.
   */
  mode?: "api" | "subscription";
}

/**
 * Builds an instrumented client + a flush() that writes every captured call as
 * an `agent-call` event to the SQLite event log. Calls are buffered in memory
 * during the agent loop and flushed in a single transaction at the end.
 */
export function buildAgentCallRecorder(
  client: AnthropicClient,
  dbFilePath: string,
  ctx: InstrumentationContext,
): { client: AnthropicClient; flush: () => void; ctx: InstrumentationContext } {
  const buffer: AgentCallInfo[] = [];
  const wrapped = instrumentClient(client, (info) => buffer.push(info));

  const flush = (): void => {
    if (buffer.length === 0) return;
    const db = new Database(dbFilePath);
    try {
      db.transaction(() => {
        for (const info of buffer) {
          appendEvent(db, {
            appId: ctx.app,
            vaultId: ctx.vault,
            kind: "agent-call",
            payload: {
              agent: ctx.agent,
              ...(ctx.planId !== undefined && { planId: ctx.planId }),
              model: info.response.model,
              inputTokens: info.response.usage.inputTokens,
              outputTokens: info.response.usage.outputTokens,
              cachedInputTokens: info.response.usage.cachedInputTokens,
              cacheCreationTokens: info.response.usage.cacheCreationTokens,
              durationMs: info.durationMs,
              stopReason: info.response.stopReason,
              mode: ctx.mode ?? "api",
            },
          });
        }
      })();
      buffer.length = 0;
    } finally {
      db.close();
    }
  };

  return { client: wrapped, flush, ctx };
}
