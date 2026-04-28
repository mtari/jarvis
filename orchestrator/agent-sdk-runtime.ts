import { createAnthropicClient } from "./anthropic-client.ts";
import { redact, type RedactionMatch } from "./redactor.ts";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
  ChatUsage,
} from "./anthropic-client.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 30;

/**
 * Result of one SDK turn, normalised to the same shape Strategist already
 * consumes via the AnthropicClient.chat() contract.
 */
export interface SdkRunResult {
  text: string;
  model: string;
  usage: ChatUsage;
  durationMs: number;
  stopReason: string | null;
  numTurns: number;
  totalCostUsd: number;
}

/**
 * Lower-level transport — replaces the SDK's `query()` for tests.
 * Production resolves to `runWithSdkQuery()` below.
 */
export type SdkTransport = (
  prompt: string,
  options: SdkTransportOptions,
) => Promise<SdkRunResult>;

export interface SdkTransportOptions {
  systemPrompt: string;
  maxTurns: number;
  model: string;
}

export interface SdkClientOptions {
  defaultModel?: string;
  defaultMaxTurns?: number;
  /** Injected for tests; production calls the real SDK via `query()`. */
  transport?: SdkTransport;
}

/**
 * Thrown when the SDK reports the user's Claude Code subscription has hit a
 * rate-limit window (5h, 7d, etc.). Plan-executor catches this and pauses
 * fires until `resetsAt`.
 */
export class RateLimitedError extends Error {
  public readonly resetsAt: Date | undefined;
  public readonly rateLimitType: string | undefined;
  constructor(message: string, resetsAt?: Date, rateLimitType?: string) {
    super(message);
    this.name = "RateLimitedError";
    this.resetsAt = resetsAt;
    this.rateLimitType = rateLimitType;
  }
}

/**
 * Drop-in `AnthropicClient` backed by the Claude Agent SDK driving the local
 * `claude` CLI subprocess. Auth comes from `~/.claude/` — no API key.
 *
 * The SDK's `query()` is its own tool loop. For Strategist + Onboard we use
 * it in single-turn text-completion mode (no tools). Multi-turn conversations
 * (Strategist clarification rounds) are encoded as a labelled transcript in
 * the user prompt — preserves the existing chat() contract without needing
 * the SDK's session machinery.
 */
export function createSdkClient(opts: SdkClientOptions = {}): AnthropicClient {
  const transport = opts.transport ?? defaultSdkTransport;
  const defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  const defaultMaxTurns = opts.defaultMaxTurns ?? DEFAULT_MAX_TURNS;

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const allRedactions: RedactionMatch[] = [];
      const redactString = (s: string): string => {
        const r = redact(s);
        for (const m of r.matches) allRedactions.push(m);
        return r.text;
      };

      const systemPrompt = req.system ? redactString(req.system) : "";
      const prompt = encodeTranscript(req.messages, redactString);

      const result = await transport(prompt, {
        systemPrompt,
        maxTurns: defaultMaxTurns,
        model: req.model ?? defaultModel,
      });

      return {
        text: result.text,
        // The SDK's text result is what Strategist actually parses (looks for
        // <plan>/<clarify>). The blocks array stays minimal — one text block —
        // because that's all consumers read.
        blocks: [{ type: "text", text: result.text, citations: null }],
        stopReason: mapStopReason(result.stopReason),
        model: result.model,
        usage: result.usage,
        redactions: allRedactions,
      };
    },
  };
}

/**
 * Convert a multi-turn ChatRequest.messages into a single labelled transcript
 * for SDK consumption. Single-turn calls (Strategist redraft) pass straight
 * through unchanged.
 */
function encodeTranscript(
  messages: ChatRequest["messages"],
  redactString: (s: string) => string,
): string {
  if (messages.length === 1) {
    const m = messages[0]!;
    const text =
      typeof m.content === "string" ? m.content : blocksToText(m.content);
    return redactString(text);
  }
  const parts: string[] = [];
  for (const m of messages) {
    const label = m.role === "user" ? "[USER]" : "[ASSISTANT]";
    const text =
      typeof m.content === "string" ? m.content : blocksToText(m.content);
    parts.push(`${label}\n${redactString(text)}`);
  }
  parts.push(
    "[YOUR TURN AS ASSISTANT]\nRespond to the most recent user message above.",
  );
  return parts.join("\n\n");
}

function blocksToText(
  blocks: ChatRequest["messages"][number]["content"],
): string {
  if (typeof blocks === "string") return blocks;
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function mapStopReason(
  raw: string | null,
): ChatResponse["stopReason"] {
  // The SDK's stop_reason is a free-form string. Anthropic's typed enum
  // ("end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal")
  // is preserved when the SDK returns one of those — otherwise we pass the
  // raw string through, which the typed alias accepts as a superset.
  return raw as ChatResponse["stopReason"];
}

// ---------------------------------------------------------------------------
// Default transport — real SDK call. Lazy-imports the SDK so unit tests can
// inject a fake transport without resolving the module.
// ---------------------------------------------------------------------------

const defaultSdkTransport: SdkTransport = async (prompt, options) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const handle = query({
    prompt,
    options: {
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      permissionMode: "bypassPermissions",
      // Strategist + Onboard don't use tools — single-shot text completion.
      // Developer's migration (plan #2) introduces the claude_code preset.
      // (No `tools` field here means SDK uses no tools.)
    },
  });

  for await (const message of handle) {
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (info.status === "rejected") {
        const resetsAt =
          info.resetsAt !== undefined ? new Date(info.resetsAt * 1000) : undefined;
        throw new RateLimitedError(
          `Claude subscription rate limit (${info.rateLimitType ?? "unknown"})`,
          resetsAt,
          info.rateLimitType,
        );
      }
      // 'allowed' / 'allowed_warning' — keep going.
      continue;
    }

    if (message.type === "assistant") {
      const errorType = message.error;
      if (errorType === "rate_limit") {
        throw new RateLimitedError(
          "Claude subscription rate limit (assistant message)",
        );
      }
      if (
        errorType === "billing_error" ||
        errorType === "authentication_failed"
      ) {
        throw new Error(
          `Claude SDK error: ${errorType}. Check 'claude' CLI auth (~/.claude).`,
        );
      }
      // server_error / invalid_request / max_output_tokens / unknown surface via
      // the result message — let it run to completion.
      continue;
    }

    if (message.type === "result") {
      if (message.subtype !== "success") {
        const errs = "errors" in message ? message.errors.join("; ") : "";
        throw new Error(
          `SDK query failed (${message.subtype}): ${errs || "no error details"}`,
        );
      }
      const usage = message.usage as unknown as Record<
        string,
        number | null | undefined
      >;
      return {
        text: message.result,
        model: pickModel(message.modelUsage, options.model),
        usage: {
          inputTokens: (usage["input_tokens"] as number) ?? 0,
          outputTokens: (usage["output_tokens"] as number) ?? 0,
          cachedInputTokens:
            (usage["cache_read_input_tokens"] as number) ?? 0,
          cacheCreationTokens:
            (usage["cache_creation_input_tokens"] as number) ?? 0,
        },
        durationMs: message.duration_ms,
        stopReason: message.stop_reason,
        numTurns: message.num_turns,
        totalCostUsd: message.total_cost_usd,
      };
    }
  }

  throw new Error("SDK query stream ended without a result message");
};

function pickModel(
  modelUsage: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!modelUsage) return fallback;
  const keys = Object.keys(modelUsage);
  return keys.length > 0 ? keys[0]! : fallback;
}

// ---------------------------------------------------------------------------
// Top-level factory: reads JARVIS_AGENT_RUNTIME and returns the right client.
// Default: 'sdk' (subscription via local claude CLI, see §18). Override with
// JARVIS_AGENT_RUNTIME=api to fall back to the legacy Anthropic client. The
// flag exists for the migration window (plans #1 → #3); it goes away in plan
// #3 once anthropic-client.ts is removed.
// ---------------------------------------------------------------------------

export type AgentRuntimeMode = "api" | "subscription";

export interface AgentRuntimeFactoryResult {
  client: AnthropicClient;
  mode: AgentRuntimeMode;
}

/**
 * Returns the configured agent runtime client + which mode it's in (so the
 * instrumenter can record `mode: 'api' | 'subscription'` on `agent-call`
 * events). Reads JARVIS_AGENT_RUNTIME from process.env.
 */
export function createAgentRuntime(): AgentRuntimeFactoryResult {
  const flag = (process.env["JARVIS_AGENT_RUNTIME"] ?? "sdk").toLowerCase();
  if (flag === "api") {
    return { client: createAnthropicClient(), mode: "api" };
  }
  return { client: createSdkClient(), mode: "subscription" };
}
