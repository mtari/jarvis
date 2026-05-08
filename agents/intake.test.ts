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

function scriptedIO(answers: ReadonlyArray<string | null>): {
  io: IntakeIO;
  asked: Array<{ sectionId: string; text: string }>;
  output: string[];
} {
  const asked: Array<{ sectionId: string; text: string }> = [];
  const output: string[] = [];
  let i = 0;
  const io: IntakeIO = {
    readUserAnswer: async (q) => {
      asked.push(q);
      if (i >= answers.length) {
        throw new Error(`scripted IO out of answers (asked ${i + 1} times)`);
      }
      return answers[i++] ?? null;
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
      `<ask sectionId="audience-and-context">Who is this interview for?</ask>`,
      `<save sectionId="audience-and-context" status="answered">For potential investors.</save>
<ask sectionId="origin-story">Why did you start the business?</ask>`,
      `<save sectionId="origin-story" status="answered">Saw a gap in the market.</save>
<done>Captured 2 sections.</done>`,
    ]);
    const { io, asked } = scriptedIO(["For potential investors.", "Saw a gap in the market."]);

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
      "audience-and-context",
      "origin-story",
    ]);
    expect(asked.map((a) => a.sectionId)).toEqual([
      "audience-and-context",
      "origin-story",
    ]);

    const markdown = fs.readFileSync(intakeFilePath, "utf8");
    expect(markdown).toContain("# Intake — demo");
    expect(markdown).toContain("## audience-and-context");
    expect(markdown).toContain("For potential investors.");
    expect(markdown).toContain("## origin-story");
    expect(markdown).toContain("Saw a gap in the market.");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Captured 2 sections.");

    // The agent's STATE on round 2 carries the user's round-1 answer
    const turn2Prompt = calls[1]?.prompt ?? "";
    expect(turn2Prompt).toContain('"For potential investors."');
    expect(turn2Prompt).toContain("last asked: audience-and-context");
    // Audience is sniffed from the save's body, so it lands in round 3's STATE
    const turn3Prompt = calls[2]?.prompt ?? "";
    expect(turn3Prompt).toContain("audience: investor");
  });

  it("persists intake.md after every save (mid-interview crash safety)", async () => {
    const { transport } = scriptedTransport([
      `<ask sectionId="audience-and-context">Who?</ask>`,
      `<save sectionId="audience-and-context" status="answered">Mentor.</save>
<ask sectionId="origin-story">Why?</ask>`,
      // Pretend the third turn never returns by throwing
    ]);
    const { io } = scriptedIO(["Mentor.", "Story here.", "extra"]);

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
    expect(markdown).toContain("## audience-and-context");
    expect(markdown).toContain("Mentor.");
  });

  it("treats null from readUserAnswer as user-signaled end", async () => {
    const { transport, calls } = scriptedTransport([
      `<ask sectionId="audience-and-context">Who?</ask>`,
      `<save sectionId="audience-and-context" status="partial">no answer
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
      `<ask sectionId="audience-and-context">Q1</ask>`,
      `<save sectionId="audience-and-context" status="answered">A1</save>
<ask sectionId="origin-story">Q2</ask>`,
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
