import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatRequest,
  ChatUsage,
} from "./anthropic-client.ts";

export interface ToolResult {
  /** Plain text returned to the model. JSON-stringify structured data yourself. */
  content: string;
  /** When true, the tool_result block is sent with `is_error: true`. */
  isError?: boolean;
}

export interface ToolHandler {
  definition: Anthropic.Tool;
  execute(input: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

export interface AgentLoopRequest {
  client: AnthropicClient;
  system?: string;
  cacheSystem?: boolean;
  initialMessages: Array<{
    role: "user" | "assistant";
    content: string | Anthropic.ContentBlockParam[];
  }>;
  tools: Record<string, ToolHandler>;
  model?: string;
  maxTokens?: number;
  /** Hard ceiling on agent turns (one chat call per iteration). Default 25. */
  maxIterations?: number;
  /** Optional hook fired after every tool execution. */
  onToolCall?: (call: AgentToolCall) => void;
}

export interface AgentToolCall {
  name: string;
  input: unknown;
  result: ToolResult;
  iteration: number;
}

export interface AgentLoopResult {
  finalText: string;
  finalBlocks: Anthropic.ContentBlock[];
  iterations: number;
  totalUsage: ChatUsage;
  toolCalls: AgentToolCall[];
  stopReason: Anthropic.StopReason | null;
}

export class MaxIterationsExceededError extends Error {
  public readonly iterations: number;

  constructor(iterations: number) {
    super(
      `Agent loop exceeded ${iterations} iterations without a final answer`,
    );
    this.name = "MaxIterationsExceededError";
    this.iterations = iterations;
  }
}

const DEFAULT_MAX_ITERATIONS = 25;

export async function runAgentLoop(
  req: AgentLoopRequest,
): Promise<AgentLoopResult> {
  const toolDefinitions = Object.values(req.tools).map((t) => t.definition);
  const conversation: ChatRequest["messages"] = req.initialMessages.map(
    (m) => ({ role: m.role, content: m.content }),
  );
  const totalUsage: ChatUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
  };
  const toolCalls: AgentToolCall[] = [];
  const maxIterations = req.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const chatReq: ChatRequest = {
      messages: conversation,
      ...(req.system !== undefined && { system: req.system }),
      ...(req.cacheSystem !== undefined && { cacheSystem: req.cacheSystem }),
      ...(req.model !== undefined && { model: req.model }),
      ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
      ...(toolDefinitions.length > 0 && { tools: toolDefinitions }),
    };
    const response = await req.client.chat(chatReq);

    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;
    totalUsage.cachedInputTokens += response.usage.cachedInputTokens;
    totalUsage.cacheCreationTokens += response.usage.cacheCreationTokens;

    if (response.stopReason !== "tool_use") {
      return {
        finalText: response.text,
        finalBlocks: response.blocks,
        iterations: iteration,
        totalUsage,
        toolCalls,
        stopReason: response.stopReason,
      };
    }

    conversation.push({
      role: "assistant",
      content: response.blocks as unknown as Anthropic.ContentBlockParam[],
    });

    const toolResults: Anthropic.ContentBlockParam[] = [];
    for (const block of response.blocks) {
      if (block.type !== "tool_use") continue;
      const handler = req.tools[block.name];
      if (!handler) {
        const result: ToolResult = {
          content: `Error: tool "${block.name}" is not registered`,
          isError: true,
        };
        toolCalls.push({
          name: block.name,
          input: block.input,
          result,
          iteration,
        });
        req.onToolCall?.({
          name: block.name,
          input: block.input,
          result,
          iteration,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: true,
        });
        continue;
      }

      let result: ToolResult;
      try {
        result = await handler.execute(
          (block.input ?? {}) as Record<string, unknown>,
        );
      } catch (err) {
        result = {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      toolCalls.push({
        name: block.name,
        input: block.input,
        result,
        iteration,
      });
      req.onToolCall?.({
        name: block.name,
        input: block.input,
        result,
        iteration,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError === true && { is_error: true }),
      });
    }

    conversation.push({ role: "user", content: toolResults });
  }

  throw new MaxIterationsExceededError(maxIterations);
}
