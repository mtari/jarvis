import { describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import {
  IdeaIntakeError,
  parseIdeaBlock,
  parseIdeaTurn,
  runIdeaIntakeAgent,
} from "./idea-intake.ts";
import type { IntakeIO, UserAnswer } from "./intake.ts";

function fixedRunResult(text: string): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 1,
    durationMs: 1,
    totalCostUsd: 0,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  };
}

function scriptedTransport(responses: string[]): {
  transport: RunAgentTransport;
  calls: RunAgentResolvedOptions[];
} {
  const calls: RunAgentResolvedOptions[] = [];
  let i = 0;
  const transport: RunAgentTransport = async (resolved) => {
    calls.push(resolved);
    if (i >= responses.length) {
      throw new Error(`scripted transport out of responses (got ${i + 1})`);
    }
    return fixedRunResult(responses[i++]!);
  };
  return { transport, calls };
}

type ScriptedAnswer = string | null | { skip: true };

function scriptedIO(answers: ReadonlyArray<ScriptedAnswer>): {
  io: IntakeIO;
  asked: Array<{ sectionId: string; text: string; isFollowup: boolean }>;
  output: string[];
} {
  const asked: Array<{ sectionId: string; text: string; isFollowup: boolean }> = [];
  const output: string[] = [];
  let i = 0;
  const io: IntakeIO = {
    readUserAnswer: async (q) => {
      asked.push({
        sectionId: q.sectionId,
        text: q.text,
        isFollowup: q.isFollowup,
      });
      if (i >= answers.length) {
        throw new Error(`scripted IO out of answers (asked ${i + 1} times)`);
      }
      const a = answers[i++];
      if (a === null) return { kind: "end" } satisfies UserAnswer;
      if (typeof a === "object" && "skip" in a) {
        return { kind: "skip" } satisfies UserAnswer;
      }
      return { kind: "answer", text: a as string } satisfies UserAnswer;
    },
    writeOutput: (t) => output.push(t),
  };
  return { io, asked, output };
}

describe("parseIdeaBlock", () => {
  it("parses a fully formed idea block", () => {
    const body = `Title: Personal-brand newsletter
App: new
Brief: Weekly behind-the-scenes letter on solo product-building.
Tags: brand, content, consulting

Audience: indie devs who want to build their own products.
Why now: erdei-fahazak + jarvis make a credible portfolio.
Effort: ~2h/week ongoing. Tools: ConvertKit + a landing page.`;
    const idea = parseIdeaBlock(body);
    expect(idea).toBeDefined();
    expect(idea?.title).toBe("Personal-brand newsletter");
    expect(idea?.app).toBe("new");
    expect(idea?.brief).toContain("Weekly");
    expect(idea?.tags).toEqual(["brand", "content", "consulting"]);
    expect(idea?.body).toContain("Audience: indie devs");
    expect(idea?.body).toContain("Effort: ~2h/week");
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseIdeaBlock("Title: x\nBrief: y\n\nbody")).toBeUndefined(); // no App
    expect(parseIdeaBlock("App: x\nBrief: y\n\nbody")).toBeUndefined(); // no Title
    expect(parseIdeaBlock("Title: x\nApp: y\n\nbody")).toBeUndefined(); // no Brief
  });

  it("handles missing tags gracefully", () => {
    const body = `Title: Foo
App: erdei-fahazak
Brief: bar

baz`;
    const idea = parseIdeaBlock(body);
    expect(idea?.tags).toEqual([]);
  });
});

describe("parseIdeaTurn", () => {
  it("extracts <ask>", () => {
    const turn = parseIdeaTurn(`<ask>What's the working title?</ask>`);
    expect(turn.ask).toBe("What's the working title?");
    expect(turn.followup).toBeUndefined();
    expect(turn.idea).toBeUndefined();
  });

  it("extracts <followup>", () => {
    const turn = parseIdeaTurn(`<followup>Be more specific?</followup>`);
    expect(turn.followup).toBe("Be more specific?");
  });

  it("extracts <idea>", () => {
    const turn = parseIdeaTurn(`<idea>
Title: Foo
App: erdei-fahazak
Brief: bar

body
</idea>`);
    expect(turn.idea?.title).toBe("Foo");
    expect(turn.idea?.app).toBe("erdei-fahazak");
  });
});

describe("runIdeaIntakeAgent", () => {
  it("walks ask → ask → idea and returns the structured result", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask>Working title and target app?</ask>`,
      `<ask>Audience and rough effort?</ask>`,
      `<idea>
Title: Personal-brand newsletter
App: new
Brief: Weekly behind-the-scenes letter on solo product-building.
Tags: brand, content

Audience: indie devs. Effort: 2h/week ongoing. No external dependencies.
</idea>`,
    ]);
    const { io, asked, output } = scriptedIO([
      "Personal-brand newsletter, new project",
      "indie devs, ~2h/week",
    ]);

    const result = await runIdeaIntakeAgent({
      knownApps: ["erdei-fahazak", "jarvis"],
      io,
      transport,
    });

    expect(result.totalRounds).toBe(3);
    expect(result.finishedCleanly).toBe(true);
    expect(result.idea.title).toBe("Personal-brand newsletter");
    expect(result.idea.app).toBe("new");
    expect(result.idea.tags).toEqual(["brand", "content"]);
    expect(asked).toHaveLength(2);
    expect(output.some((s) => s.includes("Idea captured"))).toBe(true);
    // STATE includes known apps for the agent's first ask
    expect(calls[0]?.prompt).toContain("known apps: [erdei-fahazak, jarvis]");
  });

  it("treats /end as a signal to wrap up — agent emits idea early", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask>What's the title?</ask>`,
      `<idea>
Title: (untitled)
App: new
Brief: (no brief — captured early)

User wrapped early.
</idea>`,
    ]);
    const { io } = scriptedIO([null]);

    const result = await runIdeaIntakeAgent({
      knownApps: [],
      io,
      transport,
    });

    expect(result.finishedCleanly).toBe(false);
    // Round-2 STATE contains the user-signaled-end hint
    expect(calls[1]?.prompt).toContain("user signaled end");
  });

  it("records /skip in the transcript so the agent doesn't re-ask", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask>Tags?</ask>`,
      `<idea>
Title: Foo
App: erdei-fahazak
Brief: bar

(no tags — user skipped)
</idea>`,
    ]);
    const { io } = scriptedIO([{ skip: true }]);

    const result = await runIdeaIntakeAgent({
      knownApps: ["erdei-fahazak"],
      io,
      transport,
    });

    expect(result.finishedCleanly).toBe(true);
    expect(calls[1]?.prompt).toContain("(user skipped");
    expect(calls[1]?.prompt).toContain("Q1: Tags?");
  });

  it("passes the full Q/A transcript forward each round so the agent has memory", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask>Working title and target app?</ask>`,
      `<ask>Audience and rough effort?</ask>`,
      `<ask>External dependencies or risks?</ask>`,
      `<idea>
Title: Newsletter
App: new
Brief: indie newsletter

Audience: indie devs. Effort 2h/week. No deps.
</idea>`,
    ]);
    const { io } = scriptedIO([
      "Personal-brand newsletter, new project",
      "indie devs, ~2h/week",
      "no external deps",
    ]);

    await runIdeaIntakeAgent({
      knownApps: ["erdei-fahazak", "jarvis"],
      io,
      transport,
    });

    // Round 2 has Q1+A1
    expect(calls[1]?.prompt).toContain("Q1: Working title and target app?");
    expect(calls[1]?.prompt).toContain(
      "A1: Personal-brand newsletter, new project",
    );
    // Round 3 has Q1+A1, Q2+A2
    expect(calls[2]?.prompt).toContain("Q2: Audience and rough effort?");
    expect(calls[2]?.prompt).toContain("A2: indie devs, ~2h/week");
    // Round 4 has all three Q/A pairs
    expect(calls[3]?.prompt).toContain("Q3: External dependencies or risks?");
    expect(calls[3]?.prompt).toContain("A3: no external deps");
  });

  it("throws when the agent emits a malformed turn", async () => {
    const { transport } = scriptedTransport([`(plain text, no tags)`]);
    const { io } = scriptedIO([]);
    await expect(
      runIdeaIntakeAgent({
        knownApps: [],
        io,
        transport,
      }),
    ).rejects.toBeInstanceOf(IdeaIntakeError);
  });

  it("throws when the <idea> block is missing required fields", async () => {
    const { transport } = scriptedTransport([
      `<ask>title?</ask>`,
      // App field missing → parseIdeaBlock returns undefined → no idea field
      `<idea>
Title: Foo
Brief: bar

body
</idea>
<ask>Anything else?</ask>`,
    ]);
    // The fallthrough means the runner sees an <ask> without a parsed
    // idea, then runs out of scripted answers
    const { io } = scriptedIO(["title-here"]);
    // Expect the runner to ask another round, then bail when answers run out
    await expect(
      runIdeaIntakeAgent({
        knownApps: [],
        io,
        transport,
      }),
    ).rejects.toThrow(/scripted IO out of answers/);
  });

  it("hits maxRounds without an <idea> block and throws", async () => {
    const { transport } = scriptedTransport([
      `<ask>q1</ask>`,
      `<ask>q2</ask>`,
      `<ask>q3</ask>`,
    ]);
    const { io } = scriptedIO(["a1", "a2", "a3"]);
    await expect(
      runIdeaIntakeAgent({
        knownApps: [],
        io,
        transport,
        maxRounds: 3,
      }),
    ).rejects.toBeInstanceOf(IdeaIntakeError);
  });
});
