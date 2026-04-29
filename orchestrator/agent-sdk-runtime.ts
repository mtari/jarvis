import { redact, type RedactionMatch } from "./redactor.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 30;

// ---------------------------------------------------------------------------
// Chat-shape types (used by Strategist via createSdkClient.chat()). Lived in
// orchestrator/anthropic-client.ts before plan #3 — moved here when the
// legacy API client was deleted. Strategist + Onboard call createSdkClient,
// which returns an `AnthropicClient`-shaped object backed by the SDK's
// query(). The name is kept for continuity with the existing call sites.
// ---------------------------------------------------------------------------

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

export interface ChatRequest {
  /** Model id; defaults to client.defaultModel. */
  model?: string;
  /** System prompt. `cacheSystem` is accepted for back-compat but ignored — the SDK manages caching. */
  system?: string;
  cacheSystem?: boolean;
  messages: Array<{
    role: "user" | "assistant";
    content: string | TextBlockParam[];
  }>;
  /** Output cap; informational under the SDK runtime. */
  maxTokens?: number;
  temperature?: number;
}

interface TextBlockParam {
  type: "text";
  text: string;
}

export interface ChatResponse {
  text: string;
  /** Block representation of the response. Always one text block; consumers that
   * inspected legacy SDK content blocks now read `text` directly. */
  blocks: Array<{ type: "text"; text: string }>;
  /** Stop reason from the SDK; loose typing because the SDK returns free-form strings. */
  stopReason: string | null;
  /** Model the SDK actually used. */
  model: string;
  usage: ChatUsage;
  redactions: RedactionMatch[];
}

export interface AnthropicClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

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
        blocks: [{ type: "text", text: result.text }],
        stopReason: result.stopReason,
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
// runAgent — tool-loop variant. For Developer (and any future agent that
// needs file/edit/bash tools). The SDK's query() is its own agent loop, so
// runAgent is a thin wrapper that drives query() with the right options,
// streams the message envelope, and returns the result message normalised
// for our event log.
// ---------------------------------------------------------------------------

export type RunAgentToolPreset =
  | { kind: "none" }
  | { kind: "readonly" } // ['Read', 'Glob', 'Grep'] — for Developer's draft-impl mode
  | { kind: "claude_code"; disallow?: string[] }; // full preset for execute mode

export type RunAgentResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_during_execution"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export interface RunAgentResult {
  /** Final assistant text from the SDK's result message. */
  text: string;
  /** SDK result subtype. `success` is the only happy path. */
  subtype: RunAgentResultSubtype;
  numTurns: number;
  durationMs: number;
  totalCostUsd: number;
  usage: ChatUsage;
  permissionDenials: number;
  errors: string[];
  model: string;
  stopReason: string | null;
}

export interface RunAgentOptions {
  systemPrompt: string;
  /** Appended to the chosen system prompt (e.g., our developer-execute.md text on top of the claude_code preset). */
  appendSystemPrompt?: string;
  /** When true, send the systemPrompt as `{ type: 'preset', preset: 'claude_code', append: appendSystemPrompt }`. Otherwise raw string. */
  presetSystemPrompt?: boolean;
  userPrompt: string;
  cwd: string;
  maxTurns: number;
  toolPreset: RunAgentToolPreset;
  model?: string;
  /** Injected for tests; production drives the real SDK via `query()`. */
  transport?: RunAgentTransport;
}

export type RunAgentTransport = (
  resolved: RunAgentResolvedOptions,
) => Promise<RunAgentResult>;

export interface RunAgentResolvedOptions {
  prompt: string;
  systemPrompt:
    | string
    | { type: "preset"; preset: "claude_code"; append?: string };
  cwd: string;
  maxTurns: number;
  tools: string[] | { type: "preset"; preset: "claude_code" };
  disallowedTools?: string[];
  model: string;
  redactions: RedactionMatch[];
}

const DEFAULT_DISALLOWED_FOR_CLAUDE_CODE: ReadonlyArray<string> = [
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
];

const READONLY_TOOLS: ReadonlyArray<string> = ["Read", "Glob", "Grep"];

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const allRedactions: RedactionMatch[] = [];
  const redactString = (s: string): string => {
    const r = redact(s);
    for (const m of r.matches) allRedactions.push(m);
    return r.text;
  };

  const userPrompt = redactString(opts.userPrompt);
  const rawSystem = redactString(opts.systemPrompt);
  const appendSystem = opts.appendSystemPrompt
    ? redactString(opts.appendSystemPrompt)
    : undefined;

  const systemPrompt: RunAgentResolvedOptions["systemPrompt"] = opts.presetSystemPrompt
    ? {
        type: "preset" as const,
        preset: "claude_code" as const,
        ...(appendSystem !== undefined ? { append: appendSystem } : {}),
      }
    : appendSystem !== undefined
      ? `${rawSystem}\n\n${appendSystem}`
      : rawSystem;

  const tools: RunAgentResolvedOptions["tools"] =
    opts.toolPreset.kind === "none"
      ? []
      : opts.toolPreset.kind === "readonly"
        ? [...READONLY_TOOLS]
        : { type: "preset", preset: "claude_code" };

  const disallowedTools =
    opts.toolPreset.kind === "claude_code"
      ? [
          ...DEFAULT_DISALLOWED_FOR_CLAUDE_CODE,
          ...(opts.toolPreset.disallow ?? []),
        ]
      : undefined;

  const resolved: RunAgentResolvedOptions = {
    prompt: userPrompt,
    systemPrompt,
    cwd: opts.cwd,
    maxTurns: opts.maxTurns,
    tools,
    ...(disallowedTools && disallowedTools.length > 0 && { disallowedTools }),
    model: opts.model ?? DEFAULT_MODEL,
    redactions: allRedactions,
  };

  const transport = opts.transport ?? defaultRunAgentTransport;
  return transport(resolved);
}

const defaultRunAgentTransport: RunAgentTransport = async (resolved) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Build SDK options. We use bypassPermissions in the daemon — no TTY for
  // interactive prompts. Tool restrictions come via `tools` + `disallowedTools`
  // and Developer's prompt rules + the assertCleanMain pre-check.
  const sdkOpts: Record<string, unknown> = {
    systemPrompt: resolved.systemPrompt,
    cwd: resolved.cwd,
    maxTurns: resolved.maxTurns,
    permissionMode: "bypassPermissions",
    tools: resolved.tools,
    model: resolved.model,
  };
  if (resolved.disallowedTools && resolved.disallowedTools.length > 0) {
    sdkOpts["disallowedTools"] = resolved.disallowedTools;
  }

  const handle = query({
    prompt: resolved.prompt,
    options: sdkOpts as never,
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
      continue;
    }

    if (message.type === "assistant" && message.error === "rate_limit") {
      throw new RateLimitedError(
        "Claude subscription rate limit (assistant message)",
      );
    }

    if (message.type === "result") {
      const usage = message.usage as unknown as Record<
        string,
        number | null | undefined
      >;
      const errors = "errors" in message ? message.errors : [];
      return {
        text: "result" in message ? message.result : "",
        subtype: message.subtype as RunAgentResultSubtype,
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
        totalCostUsd: message.total_cost_usd,
        usage: {
          inputTokens: (usage["input_tokens"] as number) ?? 0,
          outputTokens: (usage["output_tokens"] as number) ?? 0,
          cachedInputTokens: (usage["cache_read_input_tokens"] as number) ?? 0,
          cacheCreationTokens:
            (usage["cache_creation_input_tokens"] as number) ?? 0,
        },
        permissionDenials: message.permission_denials.length,
        errors,
        model: pickModel(
          message.modelUsage as unknown as Record<string, unknown>,
          resolved.model,
        ),
        stopReason: message.stop_reason,
      };
    }
  }

  throw new Error("SDK query stream ended without a result message");
};
