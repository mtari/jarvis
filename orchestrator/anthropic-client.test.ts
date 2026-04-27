import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetExceededError,
  createAnthropicClient,
  estimateTokens,
  type Transport,
} from "./anthropic-client.ts";
import { REDACTION_PLACEHOLDER } from "./redactor.ts";

interface FakeMessageOptions {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  stopReason?: Anthropic.StopReason;
}

function makeFakeMessage(opts: FakeMessageOptions = {}): Anthropic.Message {
  const text = opts.text ?? "Hello from fake.";
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    container: null,
    stop_details: null,
    content: [
      {
        type: "text",
        text,
        citations: null,
      } as Anthropic.TextBlock,
    ],
    model: "claude-sonnet-4-6",
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 20,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
      service_tier: null,
      server_tool_use: null,
    } as Anthropic.Usage,
  };
}

const REAL_GH_PAT = "ghp_" + "B".repeat(36);

describe("createAnthropicClient.chat", () => {
  it("returns concatenated text + usage + stop reason from the response", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage({
        text: "answer",
        inputTokens: 42,
        outputTokens: 10,
      });
    };

    const client = createAnthropicClient({ transport });
    const response = await client.chat({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.text).toBe("answer");
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 42,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(response.redactions).toEqual([]);
    expect(capturedParams?.messages).toHaveLength(1);
  });

  it("redacts secrets from messages and system before sending", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage();
    };

    const client = createAnthropicClient({ transport });
    const response = await client.chat({
      system: `Use ${REAL_GH_PAT} carefully`,
      messages: [
        { role: "user", content: `Token: ${REAL_GH_PAT}` },
      ],
    });

    expect(capturedParams?.system).toBe(`Use ${REDACTION_PLACEHOLDER} carefully`);
    const sentUserContent = capturedParams?.messages[0]?.content;
    expect(sentUserContent).toBe(`Token: ${REDACTION_PLACEHOLDER}`);
    expect(response.redactions.length).toBeGreaterThanOrEqual(2);
    expect(response.redactions.every((r) => r.kind === "github-token")).toBe(
      true,
    );
  });

  it("sends a plain string system block when cacheSystem is false", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage();
    };

    const client = createAnthropicClient({ transport });
    await client.chat({
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(capturedParams?.system).toBe("you are helpful");
  });

  it("marks the system block with cache_control when cacheSystem is true", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage();
    };

    const client = createAnthropicClient({ transport });
    await client.chat({
      system: "you are helpful",
      cacheSystem: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Array.isArray(capturedParams?.system)).toBe(true);
    const block = (capturedParams?.system as Anthropic.TextBlockParam[])[0];
    expect(block?.text).toBe("you are helpful");
    expect(block?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("uses the configured default model and maxTokens", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage();
    };

    const client = createAnthropicClient({
      transport,
      defaultModel: "claude-haiku-4-5-20251001",
      defaultMaxTokens: 1024,
    });
    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(capturedParams?.model).toBe("claude-haiku-4-5-20251001");
    expect(capturedParams?.max_tokens).toBe(1024);
  });

  it("per-request model and maxTokens override defaults", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const transport: Transport = async (params) => {
      capturedParams = params;
      return makeFakeMessage();
    };

    const client = createAnthropicClient({
      transport,
      defaultModel: "claude-sonnet-4-6",
    });
    await client.chat({
      model: "claude-opus-4-7",
      maxTokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(capturedParams?.model).toBe("claude-opus-4-7");
    expect(capturedParams?.max_tokens).toBe(4096);
  });

  it("throws ContextBudgetExceededError when estimated input exceeds the budget", async () => {
    const transport: Transport = async () => makeFakeMessage();
    const client = createAnthropicClient({ transport, contextBudget: 5 });

    await expect(
      client.chat({
        messages: [{ role: "user", content: "x".repeat(1000) }],
      }),
    ).rejects.toBeInstanceOf(ContextBudgetExceededError);
  });

  it("includes cache usage stats from the response", async () => {
    const transport: Transport = async () =>
      makeFakeMessage({
        inputTokens: 100,
        outputTokens: 30,
        cacheRead: 80,
        cacheCreation: 20,
      });
    const client = createAnthropicClient({ transport });
    const response = await client.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 80,
      cacheCreationTokens: 20,
    });
  });
});

describe("estimateTokens", () => {
  it("counts characters across system and messages, divides by 4", () => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "x".repeat(40),
      messages: [{ role: "user", content: "y".repeat(40) }],
    };
    expect(estimateTokens(params)).toBe(20);
  });

  it("handles array system blocks", () => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [{ type: "text", text: "x".repeat(80) }],
      messages: [{ role: "user", content: "y".repeat(40) }],
    };
    expect(estimateTokens(params)).toBe(30);
  });
});
