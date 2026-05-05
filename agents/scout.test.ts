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
  autoDraftFromIdeas,
  composeBriefFromIdea,
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

  it("renders the notes block when passed in (from notesContextBlock)", async () => {
    const { client, calls } = fakeScoutClient([
      scoreXml({ score: 60, rationale: "x", suggestedPriority: "normal" }),
    ]);
    await scoreIdea({
      idea: {
        id: "i",
        title: "x",
        app: "demo",
        brief: "y",
        tags: [],
        body: "",
      },
      profile: {} as ReturnType<typeof JSON.parse>,
      brain: null,
      client,
      notes: "## Free-text notes for this app\n\nAddress-step is the killer.",
    });
    expect(calls[0]!.context).toContain("## Free-text notes for this app");
    expect(calls[0]!.context).toContain("Address-step is the killer");
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

  it("reads per-app free-text notes and includes them in the LLM context", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Idea using notes",
        "App: demo",
        "Brief: y",
        "",
      ].join("\n"),
    );
    // Drop a note for `demo` before scoring.
    const { appendNote } = await import("../orchestrator/notes.ts");
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "Hypothesis: address-step is the funnel killer.",
      now: new Date("2026-05-04T00:00:00Z"),
    });

    const { client, calls } = fakeScoutClient([
      scoreXml({ score: 70, rationale: "x", suggestedPriority: "normal" }),
    ]);
    await scoreUnscoredIdeas({
      dataDir: sandbox.dataDir,
      client,
      vault: "personal",
      now: () => FIXED_NOW,
    });
    expect(calls[0]!.context).toContain("## Free-text notes for this app");
    expect(calls[0]!.context).toContain("address-step is the funnel killer");
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

// ---------------------------------------------------------------------------
// composeBriefFromIdea — deterministic brief construction
// ---------------------------------------------------------------------------

describe("composeBriefFromIdea", () => {
  it("packs title, app, brief, score, and rationale into the brief", () => {
    const brief = composeBriefFromIdea({
      id: "x",
      title: "Shorten checkout funnel",
      app: "erdei-fahazak",
      brief: "Address-step drop-off is high",
      tags: ["conversion"],
      score: 88,
      rationale: "high signal; quick to ship",
      body: "Two months of data show address-step drop-off.",
    });
    expect(brief).toContain("Title: Shorten checkout funnel");
    expect(brief).toContain("App: erdei-fahazak");
    expect(brief).toContain("Tags: conversion");
    expect(brief).toContain("Brief: Address-step drop-off is high");
    expect(brief).toContain("Scout score: 88/100");
    expect(brief).toContain("Scout's rationale: high signal");
    expect(brief).toContain("Two months of data");
  });

  it("works with minimal fields (no tags / rationale / body)", () => {
    const brief = composeBriefFromIdea({
      id: "x",
      title: "Bare",
      app: "demo",
      brief: "minimal",
      tags: [],
      score: 80,
      body: "",
    });
    expect(brief).not.toContain("Tags:");
    expect(brief).not.toContain("Scout's rationale:");
    expect(brief).not.toContain("Notes from the user:");
    expect(brief).toContain("Title: Bare");
  });
});

// ---------------------------------------------------------------------------
// autoDraftFromIdeas — Strategist hand-off + idempotency
// ---------------------------------------------------------------------------

const VALID_PLAN_DRAFT = `<plan>
# Plan: Address auto-detected idea
Type: improvement
Subtype: bugfix
ImplementationReview: skip
App: demo
Priority: high
Destructive: false
Status: draft
Author: strategist
Confidence: 80 — auto-drafted by Scout from a high-scoring idea

## Problem

A high-scoring idea from Business_Ideas.md needs a concrete plan.

## Build plan

- Identify the affected code or surface.
- Apply a targeted change.
- Verify with the existing test suite.

## Testing strategy

Unit tests for the affected component. Manual verification on the staging deploy.

## Acceptance criteria

- The change ships without regressions.
- The user-visible outcome from the idea is delivered.
</plan>`;

interface FakeStrategistCall {
  brief: string;
}

function fakeStrategistClient(
  responseTexts: string[] = [VALID_PLAN_DRAFT],
): { client: AnthropicClient; calls: FakeStrategistCall[] } {
  const calls: FakeStrategistCall[] = [];
  let i = 0;
  const client: AnthropicClient = {
    async chat(req) {
      const initialUser = req.messages.find((m) => m.role === "user");
      const brief =
        typeof initialUser?.content === "string" ? initialUser.content : "";
      calls.push({ brief });
      const text =
        i < responseTexts.length
          ? responseTexts[i++]!
          : responseTexts[responseTexts.length - 1]!;
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

describe("autoDraftFromIdeas", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

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

  function readDraftedEvents(): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT payload FROM events WHERE kind = 'idea-drafted'")
        .all() as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      conn.close();
    }
  }

  it("drafts a plan for a scored idea and records an idea-drafted event", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## High signal idea",
        "App: demo",
        "Brief: y",
        "Score: 90",
        "Rationale: r",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient([VALID_PLAN_DRAFT]);

    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.entries[0]?.planId).toBeDefined();
    // Strategist saw a brief that mentions the idea title + score
    expect(calls[0]?.brief).toContain("High signal idea");
    expect(calls[0]?.brief).toContain("Scout score: 90/100");

    const events = readDraftedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ideaId: "high-signal-idea",
      score: 90,
      actor: "scout",
    });
  });

  it("does NOT redraft on a second call with the same idea (idempotent)", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Repeat",
        "App: demo",
        "Brief: y",
        "Score: 90",
        "",
      ].join("\n"),
    );
    const { client: c1 } = fakeStrategistClient();
    await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client: c1,
    });

    const { client: c2, calls: secondCalls } = fakeStrategistClient();
    const second = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client: c2,
    });
    expect(second.draftedCount).toBe(0);
    expect(second.entries[0]?.skippedReason).toContain("already drafted");
    // Second client never called
    expect(secondCalls).toHaveLength(0);
  });

  it("skips ideas below the score threshold", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Below threshold",
        "App: demo",
        "Brief: y",
        "Score: 50",
        "",
        "## Above threshold",
        "App: demo",
        "Brief: y",
        "Score: 85",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(1);
    expect(calls).toHaveLength(1);
    const skipped = result.entries.find((e) => e.ideaId === "below-threshold");
    expect(skipped?.skippedReason).toContain("below threshold");
  });

  it("respects a custom scoreThreshold", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Mid",
        "App: demo",
        "Brief: y",
        "Score: 65",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
      scoreThreshold: 60,
    });
    expect(result.draftedCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("skips unscored ideas with a clear reason", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## No score",
        "App: demo",
        "Brief: y",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.entries[0]?.skippedReason).toBe("unscored");
    expect(calls).toHaveLength(0);
  });

  it("skips new-app ideas (App: new) with a clear reason", async () => {
    writeIdeas(
      [
        "## A whole new app",
        "App: new",
        "Brief: y",
        "Score: 90",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.entries[0]?.skippedReason).toContain("new-app idea");
    expect(calls).toHaveLength(0);
  });

  it("skips ideas whose target app has no brain", async () => {
    // No seedAppBrain — the brain doesn't exist
    writeIdeas(
      [
        "## Orphan",
        "App: ghost",
        "Brief: y",
        "Score: 90",
        "",
      ].join("\n"),
    );
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.entries[0]?.skippedReason).toContain('no brain for app "ghost"');
    expect(calls).toHaveLength(0);
  });

  it("isolates per-idea Strategist errors and continues", async () => {
    seedAppBrain("demo");
    writeIdeas(
      [
        "## Fails",
        "App: demo",
        "Brief: y",
        "Score: 90",
        "",
        "## Works",
        "App: demo",
        "Brief: y",
        "Score: 95",
        "",
      ].join("\n"),
    );
    // First response missing <plan> tag → Strategist throws; second OK
    const { client } = fakeStrategistClient([
      "no plan block here",
      VALID_PLAN_DRAFT,
    ]);
    const result = await autoDraftFromIdeas({
      dataDir: sandbox.dataDir,
      vault: "personal",
      client,
    });
    expect(result.draftedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    const fails = result.entries.find((e) => e.ideaId === "fails");
    const works = result.entries.find((e) => e.ideaId === "works");
    expect(fails?.error).toContain("strategist");
    expect(works?.planId).toBeDefined();
  });
});
