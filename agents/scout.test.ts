import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  brainDir,
  brainFile,
  businessIdeasFile,
  dbFile,
} from "../cli/paths.ts";
import { saveBrain } from "../orchestrator/brain.ts";
import { loadBusinessIdeas } from "../orchestrator/business-ideas.ts";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import {
  parseScoreResponse,
  scoreIdea,
  scoreUnscoredIdeas,
  ScoutError,
  type ScoutScoreResult,
} from "./scout.ts";
import type { BusinessIdea } from "../orchestrator/business-ideas.ts";

interface FakeScoutCall {
  context: string;
}

/** Minimal fake LLM client that returns canned <score> responses. */
function fakeScoutClient(
  responses: string[],
): { client: AnthropicClient; calls: FakeScoutCall[] } {
  const calls: FakeScoutCall[] = [];
  let i = 0;
  const client: AnthropicClient = {
    async chat(req) {
      const userMessage = req.messages.find((m) => m.role === "user");
      const context =
        typeof userMessage?.content === "string" ? userMessage.content : "";
      calls.push({ context });
      const text =
        i < responses.length
          ? responses[i++]!
          : responses[responses.length - 1]!;
      return {
        text,
        blocks: [{ type: "text", text }],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
    },
  };
  return { client, calls };
}

function scoreXml(s: ScoutScoreResult): string {
  return `<score>\n${JSON.stringify(s, null, 2)}\n</score>`;
}

// ---------------------------------------------------------------------------
// parseScoreResponse — protocol parsing
// ---------------------------------------------------------------------------

describe("parseScoreResponse", () => {
  function chat(text: string) {
    return {
      text,
      blocks: [{ type: "text" as const, text }],
      stopReason: "end_turn",
      model: "x",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
      },
      redactions: [],
    };
  }

  it("parses a well-formed <score> block", () => {
    const result = parseScoreResponse(
      chat(scoreXml({ score: 72, rationale: "x", suggestedPriority: "high" })),
    );
    expect(result).toEqual({
      score: 72,
      rationale: "x",
      suggestedPriority: "high",
    });
  });

  it("throws when <score> block is missing", () => {
    expect(() => parseScoreResponse(chat("just prose, no xml"))).toThrow(
      ScoutError,
    );
  });

  it("throws when JSON inside <score> is malformed", () => {
    expect(() => parseScoreResponse(chat("<score>not json</score>"))).toThrow(
      /not valid JSON/,
    );
  });

  it("throws when score is not an integer in [0, 100]", () => {
    const tooHigh = scoreXml({
      score: 150,
      rationale: "x",
      suggestedPriority: "high",
    });
    expect(() => parseScoreResponse(chat(tooHigh))).toThrow(
      /integer in \[0, 100\]/,
    );
  });

  it("throws when suggestedPriority is invalid", () => {
    const bad = `<score>${JSON.stringify({
      score: 50,
      rationale: "x",
      suggestedPriority: "urgent",
    })}</score>`;
    expect(() => parseScoreResponse(chat(bad))).toThrow(
      /low\|normal\|high\|blocking/,
    );
  });

  it("throws when rationale is empty", () => {
    const bad = scoreXml({
      score: 50,
      rationale: "",
      suggestedPriority: "low",
    });
    expect(() => parseScoreResponse(chat(bad))).toThrow(/rationale/);
  });
});

// ---------------------------------------------------------------------------
// scoreIdea — single LLM call
// ---------------------------------------------------------------------------

describe("scoreIdea", () => {
  it("includes idea, profile, and brain in the LLM context", async () => {
    const { client, calls } = fakeScoutClient([
      scoreXml({
        score: 80,
        rationale: "high impact",
        suggestedPriority: "high",
      }),
    ]);
    const result = await scoreIdea({
      idea: {
        id: "i",
        title: "Test idea",
        app: "demo",
        brief: "do the thing",
        tags: ["x"],
        body: "more detail",
      },
      profile: { schemaVersion: 1, areasToAvoid: [] } as unknown as ReturnType<
        typeof JSON.parse
      >,
      brain: { schemaVersion: 1, projectName: "demo" } as unknown as ReturnType<
        typeof JSON.parse
      >,
      client,
    });
    expect(result.score).toBe(80);
    expect(calls).toHaveLength(1);
    const ctx = calls[0]!.context;
    expect(ctx).toContain("Test idea");
    expect(ctx).toContain("do the thing");
    expect(ctx).toContain("more detail");
    expect(ctx).toContain('"projectName": "demo"');
  });

  it("notes 'new app' when brain is null and idea targets a new app", async () => {
    const { client, calls } = fakeScoutClient([
      scoreXml({ score: 50, rationale: "x", suggestedPriority: "normal" }),
    ]);
    await scoreIdea({
      idea: {
        id: "i",
        title: "Newcomer",
        app: "new",
        brief: "y",
        tags: [],
        body: "",
      },
      profile: {} as ReturnType<typeof JSON.parse>,
      brain: null,
      client,
    });
    expect(calls[0]!.context).toContain("New app — no existing brain");
  });
});

// ---------------------------------------------------------------------------
// scoreUnscoredIdeas — file integration + DB events
// ---------------------------------------------------------------------------

describe("scoreUnscoredIdeas", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  const FIXED_NOW = new Date("2026-05-05T08:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    fs.rmSync(brainDir(sandbox.dataDir, "personal", "jarvis"), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function writeIdeas(content: string): void {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), content);
  }

  function seedAppBrain(app: string): void {
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", app), {
      recursive: true,
    });
    saveBrain(brainFile(sandbox.dataDir, "personal", app), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
    });
  }

  function readIdeaScoredEvents(): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT payload FROM events WHERE kind = 'idea-scored'")
        .all() as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      conn.close();
    }
  }

  it("scores every unscored idea, persists, and records one event each", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Idea A",
        "App: demo",
        "Brief: x",
        "",
        "## Idea B",
        "App: demo",
        "Brief: y",
        "",
      ].join("\n"),
    );
    const { client } = fakeScoutClient([
      scoreXml({
        score: 80,
        rationale: "first reason",
        suggestedPriority: "high",
      }),
      scoreXml({
        score: 35,
        rationale: "second reason",
        suggestedPriority: "low",
      }),
    ]);

    const result = await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(result.scoredCount).toBe(2);
    expect(result.errorCount).toBe(0);

    // File now has both scores
    const reloaded = loadBusinessIdeas(sandbox.dataDir);
    const a = reloaded.ideas.find((i) => i.title === "Idea A");
    const b = reloaded.ideas.find((i) => i.title === "Idea B");
    expect(a?.score).toBe(80);
    expect(a?.scoredAt).toBe(FIXED_NOW.toISOString());
    expect(a?.rationale).toBe("first reason");
    expect(b?.score).toBe(35);
    expect(b?.rationale).toBe("second reason");

    // One idea-scored event per scored idea
    const events = readIdeaScoredEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e["score"]).sort()).toEqual([35, 80]);
  });

  it("skips ideas that already have a Score field", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Already scored",
        "App: demo",
        "Brief: x",
        "Score: 70",
        "Rationale: prior run",
        "",
        "## Fresh one",
        "App: demo",
        "Brief: y",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeScoutClient([
      scoreXml({ score: 50, rationale: "x", suggestedPriority: "normal" }),
    ]);

    const result = await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(result.scoredCount).toBe(1);
    // Only one call to the LLM — the already-scored idea was skipped
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toContain("Fresh one");
  });

  it("isolates per-idea LLM errors and continues with the rest", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Bad response",
        "App: demo",
        "Brief: x",
        "",
        "## Good one",
        "App: demo",
        "Brief: y",
        "",
      ].join("\n"),
    );
    const { client } = fakeScoutClient([
      "no score block here",
      scoreXml({ score: 60, rationale: "ok", suggestedPriority: "normal" }),
    ]);

    const result = await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(result.scoredCount).toBe(1);
    expect(result.errorCount).toBe(1);

    const reloaded = loadBusinessIdeas(sandbox.dataDir);
    const bad = reloaded.ideas.find((i) => i.title === "Bad response");
    const good = reloaded.ideas.find((i) => i.title === "Good one");
    expect(bad?.score).toBeUndefined();
    expect(good?.score).toBe(60);
  });

  it("uses null brain for new-app ideas without trying to load one", async () => {
    writeIdeas(
      [
        "## A new app idea",
        "App: new",
        "Brief: y",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeScoutClient([
      scoreXml({ score: 60, rationale: "x", suggestedPriority: "normal" }),
    ]);

    const result = await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(result.scoredCount).toBe(1);
    expect(calls[0]!.context).toContain("New app — no existing brain");
  });

  it("does not write to disk when nothing was scored", async () => {
    writeIdeas("");
    const before = fs.readFileSync(
      businessIdeasFile(sandbox.dataDir),
      "utf8",
    );

    const { client } = fakeScoutClient([
      scoreXml({ score: 0, rationale: "x", suggestedPriority: "low" }),
    ]);
    const result = await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(result.scoredCount).toBe(0);

    const after = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");
    expect(after).toBe(before);
  });
});

// Helper type used inline in tests above
type _BI = BusinessIdea; // eslint-disable-line @typescript-eslint/no-unused-vars
