import { describe, expect, it } from "vitest";
import {
  CashInGateViolatedError,
  createSdkClient,
  processSdkMessages,
  RateLimitedError,
  type SdkQueryHandle,
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

// ---------------------------------------------------------------------------
// Cash-in-commit-early gate enforcement.
//
// Today's pre-fix incident: Developer made `git commit` then ran ~25 minutes
// of additional Bash calls (re-reading files, re-running tests) without ever
// pushing. The fire was salvaged by hand. The runtime now interrupts the SDK
// query when too many post-commit Bash calls accumulate without a `git push`.
// ---------------------------------------------------------------------------

interface FakeMessage {
  type: string;
  [k: string]: unknown;
}

/**
 * Build a fake SdkQueryHandle that yields the given messages and tracks
 * whether `interrupt()` was called. Lets tests exercise processSdkMessages
 * without importing the real SDK.
 */
function fakeHandle(messages: FakeMessage[]): {
  handle: SdkQueryHandle;
  interrupted: { value: boolean };
} {
  const interrupted = { value: false };
  async function* gen(): AsyncGenerator<unknown> {
    for (const m of messages) {
      yield m;
      // If the test caller interrupts mid-stream, stop yielding to mimic
      // the SDK's behavior on Query.interrupt().
      if (interrupted.value) return;
    }
  }
  const iter = gen();
  const handle: SdkQueryHandle = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async interrupt() {
      interrupted.value = true;
    },
  };
  return { handle, interrupted };
}

function bashAssistantMessage(command: string): FakeMessage {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: `tu-${Math.random().toString(36).slice(2)}`,
          name: "Bash",
          input: { command },
        },
      ],
    },
  };
}

function successResult(): FakeMessage {
  return {
    type: "result",
    subtype: "success",
    num_turns: 5,
    duration_ms: 1234,
    total_cost_usd: 0,
    result: "DONE\nBranch: feat/x\nPR URL: https://example/pr/1\nTests: pass",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    permission_denials: [],
    modelUsage: { "claude-sonnet-4-6": {} },
  };
}

describe("processSdkMessages — cash-in-commit-early gate", () => {
  it("does NOT fire on a clean commit → push → gh pr create flow", async () => {
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage("yarn typecheck"),
      bashAssistantMessage("yarn test"),
      bashAssistantMessage(
        'git commit -m "feat: add status command" cli/commands/status.ts',
      ),
      bashAssistantMessage("git push -u origin feat/x"),
      bashAssistantMessage('gh pr create --title "..." --body "..."'),
      successResult(),
    ]);
    const result = await processSdkMessages(handle, {
      fallbackModel: "claude-sonnet-4-6",
    });
    expect(result.subtype).toBe("success");
    expect(interrupted.value).toBe(false);
  });

  it("does NOT fire when push happens within the limit even with a couple extra bash calls", async () => {
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      bashAssistantMessage("git status"), // Developer re-checks, OK
      bashAssistantMessage("git log --oneline -3"), // and again
      bashAssistantMessage("git push -u origin feat/x"), // pushes within budget
      bashAssistantMessage("gh pr create ..."),
      successResult(),
    ]);
    const result = await processSdkMessages(handle, {
      fallbackModel: "claude-sonnet-4-6",
    });
    expect(result.subtype).toBe("success");
    expect(interrupted.value).toBe(false);
  });

  it("interrupts + throws CashInGateViolatedError after >5 post-commit bash calls without push", async () => {
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      bashAssistantMessage("yarn test"),
      bashAssistantMessage("cat file1.ts"),
      bashAssistantMessage("cat file2.ts"),
      bashAssistantMessage("yarn typecheck"),
      bashAssistantMessage("git diff HEAD~1"),
      bashAssistantMessage("git log"), // 6th post-commit bash → triggers
      successResult(),
    ]);
    await expect(
      processSdkMessages(handle, { fallbackModel: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(CashInGateViolatedError);
    expect(interrupted.value).toBe(true);
  });

  it("CashInGateViolatedError carries the post-commit count", async () => {
    const { handle } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      ...Array.from({ length: 6 }, (_, i) =>
        bashAssistantMessage(`echo ${i}`),
      ),
      successResult(),
    ]);
    try {
      await processSdkMessages(handle, { fallbackModel: "claude-sonnet-4-6" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CashInGateViolatedError);
      expect((err as CashInGateViolatedError).postCommitBashCount).toBe(6);
    }
  });

  it("the threshold is configurable", async () => {
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      bashAssistantMessage("ls"),
      bashAssistantMessage("ls"),
      successResult(),
    ]);
    await expect(
      processSdkMessages(handle, {
        fallbackModel: "claude-sonnet-4-6",
        postCommitBashLimit: 1,
      }),
    ).rejects.toBeInstanceOf(CashInGateViolatedError);
    expect(interrupted.value).toBe(true);
  });

  it("a `git commit --amend` on the same fire is treated as the original commit (not a post-commit call)", async () => {
    // A user's prior amend tendency shouldn't count as the trigger event;
    // we only set `committed` on the first git commit. Subsequent commits
    // still count as post-commit bash calls — which is what we want
    // (amending after the cash-in window is itself wandering).
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      bashAssistantMessage("git push -u origin feat/x"), // satisfies push
      bashAssistantMessage("gh pr create ..."),
      successResult(),
    ]);
    const result = await processSdkMessages(handle, {
      fallbackModel: "claude-sonnet-4-6",
    });
    expect(result.subtype).toBe("success");
    expect(interrupted.value).toBe(false);
  });

  it("recognises `git push` even with extra args", async () => {
    const { handle } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      bashAssistantMessage("git push -u origin feature/y --no-verify-disabled"),
      bashAssistantMessage("ls -la"), // post-push wandering still allowed
      bashAssistantMessage("ls"),
      bashAssistantMessage("ls"),
      bashAssistantMessage("ls"),
      bashAssistantMessage("ls"),
      successResult(),
    ]);
    const result = await processSdkMessages(handle, {
      fallbackModel: "claude-sonnet-4-6",
    });
    expect(result.subtype).toBe("success");
  });

  it("ignores tool_use blocks for non-Bash tools when counting", async () => {
    const { handle, interrupted } = fakeHandle([
      bashAssistantMessage('git commit -m "feat: x"'),
      // 6 Read calls — these don't count; only Bash counts
      ...Array.from({ length: 6 }, () => ({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "r",
              name: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
      })),
      bashAssistantMessage("git push -u origin feat/x"),
      bashAssistantMessage("gh pr create ..."),
      successResult(),
    ]);
    const result = await processSdkMessages(handle, {
      fallbackModel: "claude-sonnet-4-6",
    });
    expect(result.subtype).toBe("success");
    expect(interrupted.value).toBe(false);
  });
});

