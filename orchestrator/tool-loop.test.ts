import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "./anthropic-client.ts";
import {
  MaxIterationsExceededError,
  runAgentLoop,
  type ToolHandler,
} from "./tool-loop.ts";

interface FakeResponseSpec {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: Anthropic.StopReason;
  inputTokens?: number;
  outputTokens?: number;
}

function fakeResponse(spec: FakeResponseSpec): ChatResponse {
  const blocks: Anthropic.ContentBlock[] = [];
  if (spec.text) {
    blocks.push({
      type: "text",
      text: spec.text,
      citations: null,
    } as Anthropic.TextBlock);
  }
  for (const t of spec.toolUses ?? []) {
    blocks.push({
      type: "tool_use",
      id: t.id,
      name: t.name,
      input: t.input,
    } as Anthropic.ToolUseBlock);
  }
  return {
    text: spec.text ?? "",
    blocks,
    stopReason: spec.stopReason ?? "end_turn",
    usage: {
      inputTokens: spec.inputTokens ?? 50,
      outputTokens: spec.outputTokens ?? 20,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    redactions: [],
  };
}

interface ScriptedClient {
  client: AnthropicClient;
  calls: ChatRequest[];
}

function scriptedClient(responses: ChatResponse[]): ScriptedClient {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        if (i >= responses.length) {
          throw new Error("Scripted client ran out of responses");
        }
        return responses[i++]!;
      },
    },
  };
}

const ECHO_TOOL: ToolHandler = {
  definition: {
    name: "echo",
    description: "Returns the value field unchanged",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
  execute: ({ value }) => ({ content: String(value) }),
};

const FAILING_TOOL: ToolHandler = {
  definition: {
    name: "fail",
    description: "Always throws",
    input_schema: { type: "object", properties: {} },
  },
  execute: () => {
    throw new Error("nope");
  },
};

describe("runAgentLoop", () => {
  it("returns immediately when the first response is end_turn", async () => {
    const { client, calls } = scriptedClient([
      fakeResponse({ text: "all good" }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: { echo: ECHO_TOOL },
    });
    expect(result.iterations).toBe(1);
    expect(result.finalText).toBe("all good");
    expect(result.toolCalls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toHaveLength(1);
  });

  it("executes a tool and feeds the result back into the next turn", async () => {
    const { client, calls } = scriptedClient([
      fakeResponse({
        toolUses: [
          { id: "use_1", name: "echo", input: { value: "hello" } },
        ],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "done after echo" }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "use the echo tool" }],
      tools: { echo: ECHO_TOOL },
    });
    expect(result.iterations).toBe(2);
    expect(result.finalText).toBe("done after echo");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("echo");
    expect(result.toolCalls[0]?.result.content).toBe("hello");

    // Second call should include the assistant tool_use block + tool_result reply
    const secondCallMessages = calls[1]?.messages;
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages?.[1]?.role).toBe("assistant");
    expect(secondCallMessages?.[2]?.role).toBe("user");
    const lastContent = secondCallMessages?.[2]
      ?.content as Anthropic.ContentBlockParam[];
    expect(lastContent[0]?.type).toBe("tool_result");
  });

  it("handles multiple parallel tool_use blocks in a single response", async () => {
    const { client } = scriptedClient([
      fakeResponse({
        toolUses: [
          { id: "u1", name: "echo", input: { value: "a" } },
          { id: "u2", name: "echo", input: { value: "b" } },
        ],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "got both" }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "use echo twice" }],
      tools: { echo: ECHO_TOOL },
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => c.result.content)).toEqual(["a", "b"]);
  });

  it("returns an is_error tool_result when the model calls an unregistered tool", async () => {
    const { client, calls } = scriptedClient([
      fakeResponse({
        toolUses: [
          { id: "u1", name: "missing", input: {} },
        ],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "recovered" }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "go" }],
      tools: {},
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.result.isError).toBe(true);
    const lastUserMsg = calls[1]?.messages.at(-1);
    const block = (lastUserMsg?.content as Anthropic.ContentBlockParam[])[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type === "tool_result") {
      expect(block.is_error).toBe(true);
    }
  });

  it("captures thrown errors from tool handlers as is_error tool_result", async () => {
    const { client } = scriptedClient([
      fakeResponse({
        toolUses: [{ id: "u1", name: "fail", input: {} }],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "ok" }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "fail" }],
      tools: { fail: FAILING_TOOL },
    });
    expect(result.toolCalls[0]?.result.isError).toBe(true);
    expect(result.toolCalls[0]?.result.content).toContain("nope");
  });

  it("aggregates usage across iterations", async () => {
    const { client } = scriptedClient([
      fakeResponse({
        toolUses: [{ id: "u1", name: "echo", input: { value: "x" } }],
        stopReason: "tool_use",
        inputTokens: 100,
        outputTokens: 30,
      }),
      fakeResponse({
        text: "final",
        inputTokens: 200,
        outputTokens: 10,
      }),
    ]);
    const result = await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "go" }],
      tools: { echo: ECHO_TOOL },
    });
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.outputTokens).toBe(40);
  });

  it("calls onToolCall for every executed tool", async () => {
    const recorded: string[] = [];
    const { client } = scriptedClient([
      fakeResponse({
        toolUses: [
          { id: "u1", name: "echo", input: { value: "first" } },
          { id: "u2", name: "echo", input: { value: "second" } },
        ],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "done" }),
    ]);
    await runAgentLoop({
      client,
      initialMessages: [{ role: "user", content: "go" }],
      tools: { echo: ECHO_TOOL },
      onToolCall: (call) => recorded.push(call.result.content),
    });
    expect(recorded).toEqual(["first", "second"]);
  });

  it("forwards system + cacheSystem to every chat call", async () => {
    const { client, calls } = scriptedClient([
      fakeResponse({
        toolUses: [{ id: "u1", name: "echo", input: { value: "x" } }],
        stopReason: "tool_use",
      }),
      fakeResponse({ text: "done" }),
    ]);
    await runAgentLoop({
      client,
      system: "You are a tester.",
      cacheSystem: true,
      initialMessages: [{ role: "user", content: "go" }],
      tools: { echo: ECHO_TOOL },
    });
    for (const call of calls) {
      expect(call.system).toBe("You are a tester.");
      expect(call.cacheSystem).toBe(true);
    }
  });

  it("throws MaxIterationsExceededError when the model never stops requesting tools", async () => {
    const looping: AnthropicClient = {
      async chat() {
        return fakeResponse({
          toolUses: [{ id: "u", name: "echo", input: { value: "again" } }],
          stopReason: "tool_use",
        });
      },
    };
    await expect(
      runAgentLoop({
        client: looping,
        initialMessages: [{ role: "user", content: "go" }],
        tools: { echo: ECHO_TOOL },
        maxIterations: 3,
      }),
    ).rejects.toBeInstanceOf(MaxIterationsExceededError);
  });
});
