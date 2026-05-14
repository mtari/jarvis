import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import {
  IntakeError,
  parseAgentTurn,
  runIntakeAgent,
  type IntakeIO,
  type UserAnswer,
} from "./intake.ts";

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
  asked: Array<{ sectionId: string; text: string }>;
  output: string[];
} {
  const asked: Array<{ sectionId: string; text: string }> = [];
  const output: string[] = [];
  let i = 0;
  const io: IntakeIO = {
    readUserAnswer: async (q) => {
      asked.push({ sectionId: q.sectionId, text: q.text });
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

describe("parseAgentTurn", () => {
  it("parses ask + save in one turn", () => {
    const text = `<save sectionId="origin-story" status="answered">User started in 2023 because of a parking incident.</save>
<ask sectionId="problem-and-opportunity">What's the specific problem the app solves?</ask>`;
    const parsed = parseAgentTurn(text);
    expect(parsed.saves).toEqual([
      {
        sectionId: "origin-story",
        status: "answered",
        body: "User started in 2023 because of a parking incident.",
      },
    ]);
    expect(parsed.ask).toEqual({
      sectionId: "problem-and-opportunity",
      text: "What's the specific problem the app solves?",
    });
    expect(parsed.followup).toBeUndefined();
    expect(parsed.done).toBeUndefined();
  });

  it("parses save + done", () => {
    const text = `<save sectionId="long-term-vision" status="answered">10-year vision: regional dominance.</save>
<done>Captured 12 sections; 2 partial; 1 skipped.</done>`;
    const parsed = parseAgentTurn(text);
    expect(parsed.saves).toHaveLength(1);
    expect(parsed.done?.summary).toBe(
      "Captured 12 sections; 2 partial; 1 skipped.",
    );
  });

  it("parses followup", () => {
    const text = `<followup sectionId="traction-and-metrics">You said "growing" — can you give a number? MoM signups, MRR, anything concrete?</followup>`;
    const parsed = parseAgentTurn(text);
    expect(parsed.followup?.sectionId).toBe("traction-and-metrics");
    expect(parsed.ask).toBeUndefined();
  });

  it("normalises unknown status to answered", () => {
    const text = `<save sectionId="x" status="weird">body</save>`;
    const parsed = parseAgentTurn(text);
    expect(parsed.saves[0]?.status).toBe("answered");
  });
});

describe("runIntakeAgent", () => {
  let repoRoot: string;
  let intakeFilePath: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-intake-"));
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2),
    );
    intakeFilePath = path.join(repoRoot, "_intake.md");
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("walks ask → save → done and writes the intake markdown", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="origin-story">Why did you start the business?</ask>`,
      `<save sectionId="origin-story" status="answered">Saw a gap in the market.</save>
<ask sectionId="problem-and-opportunity">What problem does it solve?</ask>`,
      `<save sectionId="problem-and-opportunity" status="answered">Renters waste 20+ minutes per trip looking for parking.</save>
<done>Captured 2 sections.</done>`,
    ]);
    const { io, asked } = scriptedIO([
      "Saw a gap in the market.",
      "Renters waste 20+ minutes per trip looking for parking.",
    ]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });

    expect(result.finishedCleanly).toBe(true);
    expect(result.totalRounds).toBe(3);
    expect(result.sections.map((s) => s.id)).toEqual([
      "origin-story",
      "problem-and-opportunity",
    ]);
    expect(asked.map((a) => a.sectionId)).toEqual([
      "origin-story",
      "problem-and-opportunity",
    ]);

    const markdown = fs.readFileSync(intakeFilePath, "utf8");
    expect(markdown).toContain("# Intake — demo");
    expect(markdown).toContain("## origin-story");
    expect(markdown).toContain("Saw a gap in the market.");
    expect(markdown).toContain("## problem-and-opportunity");
    expect(markdown).toContain("Renters waste 20+ minutes per trip looking for parking.");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Captured 2 sections.");

    // The agent's STATE on round 2 carries the user's round-1 answer
    const turn2Prompt = calls[1]?.prompt ?? "";
    expect(turn2Prompt).toContain('"Saw a gap in the market."');
    expect(turn2Prompt).toContain("last asked: origin-story");
    // STATE no longer carries an audience field — intake is audience-blind.
    const turn3Prompt = calls[2]?.prompt ?? "";
    expect(turn3Prompt).not.toContain("audience:");
  });

  it("persists intake.md after every save (mid-interview crash safety)", async () => {
    const { transport } = scriptedTransport([
      `<ask sectionId="origin-story">Why?</ask>`,
      `<save sectionId="origin-story" status="answered">Saw a gap.</save>
<ask sectionId="problem-and-opportunity">What problem?</ask>`,
      // Pretend the third turn never returns by throwing
    ]);
    const { io } = scriptedIO(["Saw a gap.", "Story here.", "extra"]);

    // Wrap transport to error on the third call so we simulate a crash AFTER
    // the second save has been persisted.
    let callCount = 0;
    const failingTransport: RunAgentTransport = async (resolved) => {
      callCount += 1;
      if (callCount === 3) throw new Error("simulated crash");
      return transport(resolved);
    };

    await expect(
      runIntakeAgent({
        app: "demo",
        repoRoot,
        io,
        intakeFilePath,
        transport: failingTransport,
      }),
    ).rejects.toThrow(/simulated crash/);

    // The first save survived to disk.
    const markdown = fs.readFileSync(intakeFilePath, "utf8");
    expect(markdown).toContain("## origin-story");
    expect(markdown).toContain("Saw a gap.");
  });

  it("forwards a skip request to the agent's STATE block", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="origin-story">Q1</ask>`,
      `<save sectionId="origin-story" status="skipped">user skipped</save>
<ask sectionId="problem-and-opportunity">Q2</ask>`,
      `<save sectionId="problem-and-opportunity" status="answered">A2</save>
<done>1 skipped, 1 answered.</done>`,
    ]);
    const { io } = scriptedIO([{ skip: true }, "A2"]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });
    expect(result.finishedCleanly).toBe(true);
    // The orchestrator's round-2 prompt tells the agent the user asked to skip
    expect(calls[1]?.prompt).toContain("user asked to skip this section");
  });

  it("does not cap followups — agent can drill into a section as needed", async () => {
    // Two consecutive followups on the same section are honored; the user is
    // asked each time. The agent decides when it has enough.
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="traction-and-metrics">Numbers?</ask>`,
      `<followup sectionId="traction-and-metrics">Anything more concrete?</followup>`,
      `<followup sectionId="traction-and-metrics">MoM percentage?</followup>`,
      `<save sectionId="traction-and-metrics" status="answered">Growing 25% MoM, ~500 MAU.</save>
<done>1 captured.</done>`,
    ]);
    const { io, asked } = scriptedIO([
      "growing",
      "still growing",
      "25% MoM, ~500 MAU",
    ]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });
    expect(result.finishedCleanly).toBe(true);
    // All three user-facing questions were asked — no override, no drop
    expect(asked.map((a) => a.sectionId)).toEqual([
      "traction-and-metrics",
      "traction-and-metrics",
      "traction-and-metrics",
    ]);
    // No prompt contains the (now-removed) override line
    for (const c of calls) {
      expect(c.prompt).not.toContain("ORCHESTRATOR OVERRIDE");
    }
  });

  it("includes full PRIOR ANSWERS bodies in subsequent prompts", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="origin-story">Why?</ask>`,
      `<save sectionId="origin-story" status="answered">Started in 2023 after a parking incident in Budapest that wasted 40 minutes of my life. I'd spent 15 years in real estate so the property side made sense.</save>
<ask sectionId="problem-and-opportunity">What's the problem?</ask>`,
      `<save sectionId="problem-and-opportunity" status="answered">Renters in Budapest waste 20+ minutes per trip looking for parking; about 200K daily affected.</save>
<done>2 captured.</done>`,
    ]);
    const { io } = scriptedIO(["A1", "A2"]);

    await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });
    // Round 2 prompt: nothing saved yet, so no PRIOR ANSWERS block
    expect(calls[1]?.prompt).not.toContain("PRIOR ANSWERS");
    // Round 3 prompt: PRIOR ANSWERS includes the FULL origin-story body
    const turn3 = calls[2]?.prompt ?? "";
    expect(turn3).toContain("PRIOR ANSWERS");
    expect(turn3).toContain("### origin-story");
    expect(turn3).toContain(
      "I'd spent 15 years in real estate so the property side made sense.",
    );
  });

  it("amending an earlier section overwrites the saved body", async () => {
    const { transport } = scriptedTransport([
      `<ask sectionId="market-and-customers">Who's it for?</ask>`,
      // First answer: B2B
      `<save sectionId="market-and-customers" status="answered">B2B SaaS founders.</save>
<ask sectionId="competition">Who do you compete with?</ask>`,
      // Later answer reveals B2B2C — agent amends the earlier section in the same turn
      `<save sectionId="market-and-customers" status="answered">B2B2C: SaaS founders sell to their end-users via our app, so we're effectively serving both layers.</save>
<save sectionId="competition" status="answered">Mostly Stripe-adjacent vendors.</save>
<done>2 captured (1 amended).</done>`,
    ]);
    const { io } = scriptedIO(["B2B SaaS founders", "Stripe-adjacent. Also we're really B2B2C."]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });
    expect(result.finishedCleanly).toBe(true);
    const market = result.sections.find((s) => s.id === "market-and-customers");
    expect(market?.body).toContain("B2B2C");
    // Only one entry in collected per sectionId
    expect(
      result.sections.filter((s) => s.id === "market-and-customers"),
    ).toHaveLength(1);
  });

  it("treats { kind: 'end' } from readUserAnswer as user-signaled end", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="origin-story">Why?</ask>`,
      `<save sectionId="origin-story" status="partial">no answer
Gap: not collected</save>
<done>User wrapped early.</done>`,
    ]);
    const { io } = scriptedIO([null]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
    });

    expect(result.finishedCleanly).toBe(true);
    // The agent's STATE on round 2 must include "user signaled end: true"
    expect(calls[1]?.prompt).toContain("user signaled end: true");
  });

  it("throws when the agent emits a malformed turn (no ask/followup/done)", async () => {
    const { transport } = scriptedTransport([`<save sectionId="x" status="answered">y</save>`]);
    const { io } = scriptedIO([]);
    await expect(
      runIntakeAgent({
        app: "demo",
        repoRoot,
        io,
        intakeFilePath,
        transport,
      }),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it("rejects relative paths", async () => {
    const { transport } = scriptedTransport([]);
    const { io } = scriptedIO([]);
    await expect(
      runIntakeAgent({
        app: "demo",
        repoRoot: "relative/path",
        io,
        intakeFilePath,
        transport,
      }),
    ).rejects.toBeInstanceOf(IntakeError);
    await expect(
      runIntakeAgent({
        app: "demo",
        repoRoot,
        io,
        intakeFilePath: "relative/intake.md",
        transport,
      }),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it("caps at maxRounds without <done>", async () => {
    const { transport } = scriptedTransport([
      `<ask sectionId="origin-story">Q1</ask>`,
      `<save sectionId="origin-story" status="answered">A1</save>
<ask sectionId="problem-and-opportunity">Q2</ask>`,
    ]);
    // Round 2 emits <save>+<ask>, so the loop reads a second answer before
    // the cap check exits the loop.
    const { io } = scriptedIO(["A1", "A2"]);

    const result = await runIntakeAgent({
      app: "demo",
      repoRoot,
      io,
      intakeFilePath,
      transport,
      maxRounds: 2,
    });

    expect(result.finishedCleanly).toBe(false);
    expect(result.totalRounds).toBe(2);
  });
});
