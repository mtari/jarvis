import Anthropic from "@anthropic-ai/sdk";
import { redact, type RedactionMatch } from "./redactor.ts";

export type Transport = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface ChatRequest {
  /** Model id; defaults to client.defaultModel. */
  model?: string;
  /** System prompt. When `cacheSystem` is true the block is marked with cache_control. */
  system?: string;
  cacheSystem?: boolean;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Anthropic.ContentBlockParam[];
  }>;
  /** Output cap; defaults to client.defaultMaxTokens. */
  maxTokens?: number;
  temperature?: number;
  tools?: Anthropic.Tool[];
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

export interface ChatResponse {
  text: string;
  blocks: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
  usage: ChatUsage;
  redactions: RedactionMatch[];
}

export interface ClientOptions {
  apiKey?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  /** When set, throws ContextBudgetExceededError if the estimated input exceeds the budget. */
  contextBudget?: number;
  /** Injected for tests; production resolves to the SDK's messages.create. */
  transport?: Transport;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 8192;

export class ContextBudgetExceededError extends Error {
  public readonly estimated: number;
  public readonly budget: number;

  constructor(estimated: number, budget: number) {
    super(
      `Context budget exceeded: estimated ${estimated} tokens, budget ${budget}`,
    );
    this.name = "ContextBudgetExceededError";
    this.estimated = estimated;
    this.budget = budget;
  }
}

export interface AnthropicClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export function createAnthropicClient(
  opts: ClientOptions = {},
): AnthropicClient {
  const transport = opts.transport ?? createSdkTransport(opts.apiKey);
  const defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  const defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async chat(req): Promise<ChatResponse> {
      const allRedactions: RedactionMatch[] = [];
      const redactString = (s: string): string => {
        const r = redact(s);
        for (const m of r.matches) allRedactions.push(m);
        return r.text;
      };

      const messageParams: Anthropic.MessageParam[] = req.messages.map(
        (m) => ({
          role: m.role,
          content:
            typeof m.content === "string"
              ? redactString(m.content)
              : redactBlocks(m.content, redactString),
        }),
      );

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model ?? defaultModel,
        max_tokens: req.maxTokens ?? defaultMaxTokens,
        messages: messageParams,
      };

      if (req.temperature !== undefined) params.temperature = req.temperature;
      if (req.tools !== undefined) params.tools = req.tools;

      if (req.system !== undefined) {
        const redactedSystem = redactString(req.system);
        if (req.cacheSystem) {
          params.system = [
            {
              type: "text",
              text: redactedSystem,
              cache_control: { type: "ephemeral" },
            },
          ];
        } else {
          params.system = redactedSystem;
        }
      }

      if (opts.contextBudget !== undefined) {
        const estimated = estimateTokens(params);
        if (estimated > opts.contextBudget) {
          throw new ContextBudgetExceededError(estimated, opts.contextBudget);
        }
      }

      const response = await transport(params);

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      return {
        text,
        blocks: response.content,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        redactions: allRedactions,
      };
    },
  };
}

/** Rough token estimate (~4 chars per token). Phase 0 budget guard only — Phase 2 swaps for the real token-count endpoint. */
export function estimateTokens(
  params: Anthropic.MessageCreateParamsNonStreaming,
): number {
  let totalChars = 0;

  if (typeof params.system === "string") {
    totalChars += params.system.length;
  } else if (Array.isArray(params.system)) {
    for (const block of params.system) {
      if ("text" in block && typeof block.text === "string") {
        totalChars += block.text.length;
      }
    }
  }

  for (const m of params.messages) {
    if (typeof m.content === "string") {
      totalChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block && typeof block.text === "string") {
          totalChars += block.text.length;
        }
      }
    }
  }

  return Math.ceil(totalChars / 4);
}

function redactBlocks(
  blocks: Anthropic.ContentBlockParam[],
  redactString: (s: string) => string,
): Anthropic.ContentBlockParam[] {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { ...block, text: redactString(block.text) };
    }
    if (block.type === "tool_result") {
      if (typeof block.content === "string") {
        return { ...block, content: redactString(block.content) };
      }
      if (Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map((c) =>
            c.type === "text"
              ? { ...c, text: redactString(c.text) }
              : c,
          ),
        };
      }
    }
    return block;
  });
}

function createSdkTransport(apiKey: string | undefined): Transport {
  let lazy: Anthropic | null = null;
  return async (params) => {
    if (!lazy) {
      const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!key) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Fill in jarvis-data/.env or pass apiKey to createAnthropicClient.",
        );
      }
      lazy = new Anthropic({ apiKey: key });
    }
    return lazy.messages.create(params);
  };
}
