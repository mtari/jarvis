import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  createSdkClient,
  RateLimitedError,
  type SdkRunResult,
  type SdkTransport,
} from "./agent-sdk-runtime.ts";

function makeFakeTransport(result: Partial<SdkRunResult> = {}): {
  transport: SdkTransport;
  calls: Array<{ prompt: string; options: Parameters<SdkTransport>[1] }>;
} {
  const calls: Array<{ prompt: string; options: Parameters<SdkTransport>[1] }> = [];
  const transport: SdkTransport = async (prompt, options) => {
    calls.push({ prompt, options });
    return {
      text: result.text ?? "ok",
      model: result.model ?? "claude-sonnet-4-6",
      usage: result.usage ?? {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 80,
        cacheCreationTokens: 0,
      },
      durationMs: result.durationMs ?? 250,
      stopReason: result.stopReason ?? "end_turn",
      numTurns: result.numTurns ?? 1,
      totalCostUsd: result.totalCostUsd ?? 0,
    };
  };
  return { transport, calls };
}

describe("createSdkClient", () => {
  it("forwards system prompt + single-turn user message to the transport", async () => {
    const { transport, calls } = makeFakeTransport({ text: "draft response" });
    const client = createSdkClient({ transport });

    const response = await client.chat({
      system: "You are Strategist.",
      messages: [{ role: "user", content: "Brief: add a status command." }],
    });

    expect(response.text).toBe("draft response");
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 80,
      cacheCreationTokens: 0,
    });
    expect(response.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.options.systemPrompt).toBe("You are Strategist.");
    expect(call.prompt).toBe("Brief: add a status command.");
  });

  it("encodes multi-turn conversation as a labelled transcript", async () => {
    const { transport, calls } = makeFakeTransport();
    const client = createSdkClient({ transport });

    await client.chat({
      system: "You are Strategist.",
      messages: [
        { role: "user", content: "initial brief" },
        { role: "assistant", content: "<clarify>What's the priority?</clarify>" },
        { role: "user", content: "Q: priority? A: high" },
      ],
    });

    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("[USER]\ninitial brief");
    expect(prompt).toContain("[ASSISTANT]\n<clarify>What's the priority?</clarify>");
    expect(prompt).toContain("[USER]\nQ: priority? A: high");
    expect(prompt).toContain("[YOUR TURN AS ASSISTANT]");
  });

  it("redacts secret-shaped strings in the system prompt + user messages", async () => {
    const { transport, calls } = makeFakeTransport();
    const client = createSdkClient({ transport });

    // Hand-build an obviously-secret-shaped Anthropic key fragment so the
    // redactor catches it. Split across concatenation to keep the source
    // file safe to commit.
    const fakeKey = "sk-ant-" + "a".repeat(95);
    const response = await client.chat({
      system: `You are Strategist. Use ${fakeKey} when needed.`,
      messages: [{ role: "user", content: `Also use ${fakeKey} in the body.` }],
    });

    const call = calls[0]!;
    expect(call.options.systemPrompt).not.toContain(fakeKey);
    expect(call.options.systemPrompt).toContain("[REDACTED");
    expect(call.prompt).not.toContain(fakeKey);
    expect(call.prompt).toContain("[REDACTED");
    expect(response.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the provided model and falls back to default when none is given", async () => {
    const { transport, calls } = makeFakeTransport();
    const client = createSdkClient({ transport, defaultModel: "claude-haiku-4-5-20251001" });

    await client.chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(calls[0]!.options.model).toBe("claude-haiku-4-5-20251001");

    await client.chat({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "y" }],
    });
    expect(calls[1]!.options.model).toBe("claude-opus-4-7");
  });

  it("propagates RateLimitedError from the transport", async () => {
    const transport: SdkTransport = async () => {
      throw new RateLimitedError(
        "rate limit hit",
        new Date("2026-04-28T19:00:00Z"),
        "five_hour",
      );
    };
    const client = createSdkClient({ transport });

    await expect(
      client.chat({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("createAgentRuntime", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env["JARVIS_AGENT_RUNTIME"];
  });
  afterEach(() => {
    if (prev !== undefined) {
      process.env["JARVIS_AGENT_RUNTIME"] = prev;
    } else {
      delete process.env["JARVIS_AGENT_RUNTIME"];
    }
  });

  it("returns the SDK runtime by default (no env var set)", () => {
    delete process.env["JARVIS_AGENT_RUNTIME"];
    const runtime = createAgentRuntime();
    expect(runtime.mode).toBe("subscription");
  });

  it("returns the SDK runtime when JARVIS_AGENT_RUNTIME=sdk", () => {
    process.env["JARVIS_AGENT_RUNTIME"] = "sdk";
    const runtime = createAgentRuntime();
    expect(runtime.mode).toBe("subscription");
  });

  it("returns the legacy API runtime when JARVIS_AGENT_RUNTIME=api", () => {
    process.env["JARVIS_AGENT_RUNTIME"] = "api";
    const runtime = createAgentRuntime();
    expect(runtime.mode).toBe("api");
  });
});
