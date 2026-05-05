import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { saveBrain } from "../orchestrator/brain.ts";
import {
  brainFile,
  businessIdeasFile,
  dbFile,
  notesFile,
  setupQueueFile,
} from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  DiscussError,
  parseDiscussResponse,
  runDiscuss,
  type DiscussTurnResult,
} from "./discuss.ts";
import type { Prompter } from "./strategist.ts";

// ---------------------------------------------------------------------------
// Mock client + prompter helpers
// ---------------------------------------------------------------------------

function makeMockClient(responses: string[]): {
  client: AnthropicClient;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  let i = 0;
  const client: AnthropicClient = {
    async chat(req) {
      calls.push(req);
      const text = responses[i++];
      if (text === undefined) {
        throw new Error(
          `mock client ran out of responses at call #${calls.length}`,
        );
      }
      const r: ChatResponse = {
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
      return r;
    },
  };
  return { client, calls };
}

function makeScriptedPrompter(answers: string[]): {
  prompter: Prompter;
  asked: string[];
  printed: string[];
} {
  const asked: string[] = [];
  const printed: string[] = [];
  let i = 0;
  return {
    asked,
    printed,
    prompter: {
      async ask(p) {
        asked.push(p);
        return answers[i++] ?? "";
      },
      print(m) {
        printed.push(m);
      },
    },
  };
}

function seedBrain(sandbox: InstallSandbox, app: string): void {
  const brainPath = brainFile(sandbox.dataDir, "personal", app);
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  saveBrain(brainPath, {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    userPreferences: {},
    connections: {},
    priorities: [],
    wip: {},
  });
}

// Minimal valid plan block that parsePlan accepts — used when the discuss
// outcome is propose-plan and runStrategist gets called with challenge=false.
const PLAN_BLOCK = `<plan>
# Plan: Discuss-driven plan
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: demo
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — discussed in session

## Problem
The conversation surfaced a real need.

## Build plan
- Build the thing the conversation agreed on.

## Testing strategy
Manual + unit on the formatter.

## Acceptance criteria
- it works.

## Success metric
- Metric: subjective check
- Baseline: today
- Target: ships
- Data source: manual

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert.

## Estimated effort
- Claude calls: ~3
- Your review time: 5 min
- Wall-clock to ship: 1 hour

## Amendment clauses
Pause if scope expands.
</plan>`;

// ---------------------------------------------------------------------------
// parseDiscussResponse — pure parser
// ---------------------------------------------------------------------------

describe("parseDiscussResponse", () => {
  it("parses a <continue> block", () => {
    const r = parseDiscussResponse("<continue>\nWhat's the budget?\n</continue>");
    expect(r).toEqual({ kind: "continue", text: "What's the budget?" });
  });

  it("parses a <propose-plan> block", () => {
    const r = parseDiscussResponse(
      "<propose-plan>\nFix the address-step funnel on checkout.\n</propose-plan>",
    );
    expect(r).toEqual({
      kind: "propose-plan",
      brief: "Fix the address-step funnel on checkout.",
    });
  });

  it("parses a <propose-idea> block with title + brief", () => {
    const r = parseDiscussResponse(
      [
        "<propose-idea>",
        "title: Mountain weather widget",
        "brief: Side widget showing current trail conditions.",
        "</propose-idea>",
      ].join("\n"),
    );
    expect(r).toEqual({
      kind: "propose-idea",
      title: "Mountain weather widget",
      brief: "Side widget showing current trail conditions.",
    });
  });

  it("parses a <propose-note> block with multi-line body", () => {
    const r = parseDiscussResponse(
      "<propose-note>\naddress-step is the funnel killer.\nWe lose 40% there.\n</propose-note>",
    );
    if (r.kind !== "propose-note") throw new Error("expected note");
    expect(r.text).toContain("address-step");
    expect(r.text).toContain("40%");
  });

  it("parses a <propose-setup-task> block with multi-line detail", () => {
    const r = parseDiscussResponse(
      [
        "<propose-setup-task>",
        "title: Wire Stripe restricted key",
        "detail: Create a restricted key in the Stripe dashboard.",
        "Drop it in .env as STRIPE_RESTRICTED_KEY.",
        "</propose-setup-task>",
      ].join("\n"),
    );
    if (r.kind !== "propose-setup-task") throw new Error("expected setup-task");
    expect(r.title).toBe("Wire Stripe restricted key");
    expect(r.detail).toContain("Create a restricted key");
    expect(r.detail).toContain("STRIPE_RESTRICTED_KEY");
  });

  it("parses a <close> block", () => {
    const r = parseDiscussResponse("<close>\nWe talked it through.\n</close>");
    expect(r).toEqual({ kind: "close", text: "We talked it through." });
  });

  it("close takes precedence over a stray continue block (defensive)", () => {
    const r = parseDiscussResponse(
      "<close>done</close>\n<continue>still going</continue>",
    );
    expect(r.kind).toBe("close");
  });

  it("throws on missing block", () => {
    expect(() => parseDiscussResponse("just prose")).toThrow(DiscussError);
  });

  it("throws on empty <continue>", () => {
    expect(() =>
      parseDiscussResponse("<continue>\n\n</continue>"),
    ).toThrow(/empty/);
  });

  it("throws when <propose-idea> is missing required fields", () => {
    expect(() =>
      parseDiscussResponse(
        "<propose-idea>\ntitle: just a title\n</propose-idea>",
      ),
    ).toThrow(/brief/);
  });

  it("throws when <propose-setup-task> is missing detail", () => {
    expect(() =>
      parseDiscussResponse(
        "<propose-setup-task>\ntitle: x\n</propose-setup-task>",
      ),
    ).toThrow(/detail/);
  });
});

// ---------------------------------------------------------------------------
// runDiscuss — orchestration with scripted prompter + mock LLM
// ---------------------------------------------------------------------------

describe("runDiscuss", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    seedBrain(sandbox, "demo");
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("loops on <continue> and closes when the model emits <close>", async () => {
    const { client, calls } = makeMockClient([
      "<continue>What's the goal?</continue>",
      "<close>We talked it through. No action.</close>",
    ]);
    const { prompter, printed } = makeScriptedPrompter(["Just thinking out loud."]);

    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Open question about pricing.",
      prompter,
    });

    expect(result.outcome).toBe("closed");
    expect(result.turns).toBe(2);
    expect(result.refId).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(printed.some((p) => p.includes("What's the goal?"))).toBe(true);
    expect(printed.some((p) => p.includes("We talked it through"))).toBe(true);
  });

  it("treats blank reply as quit", async () => {
    const { client } = makeMockClient([
      "<continue>What's the goal?</continue>",
    ]);
    const { prompter } = makeScriptedPrompter([""]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Hi.",
      prompter,
    });
    expect(result.outcome).toBe("closed");
    expect(result.turns).toBe(1);
  });

  it("appends a note when the user accepts a propose-note", async () => {
    const { client } = makeMockClient([
      "<propose-note>address-step is the funnel killer</propose-note>",
    ]);
    const { prompter } = makeScriptedPrompter(["y"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Funnel issue.",
      prompter,
      now: new Date("2026-05-04T12:00:00Z"),
    });
    expect(result.outcome).toBe("note");
    const written = fs.readFileSync(
      notesFile(sandbox.dataDir, "personal", "demo"),
      "utf8",
    );
    expect(written).toContain("address-step is the funnel killer");
    expect(written).toContain("2026-05-04T12:00:00.000Z");
  });

  it("creates a setup task when the user accepts a propose-setup-task", async () => {
    const { client } = makeMockClient([
      [
        "<propose-setup-task>",
        "title: Wire Stripe key",
        "detail: Add STRIPE_RESTRICTED_KEY to .env.",
        "</propose-setup-task>",
      ].join("\n"),
    ]);
    const { prompter } = makeScriptedPrompter(["y"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Need to integrate Stripe.",
      prompter,
      now: new Date("2026-05-04T12:00:00Z"),
    });
    expect(result.outcome).toBe("setup-task");
    expect(result.refId).toBeDefined();
    const queue = fs
      .readFileSync(setupQueueFile(sandbox.dataDir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { title: string; source?: { kind: string } });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.title).toBe("Wire Stripe key");
    expect(queue[0]?.source?.kind).toBe("discuss");
  });

  it("saves a business idea when the user accepts a propose-idea", async () => {
    const { client } = makeMockClient([
      [
        "<propose-idea>",
        "title: Trail conditions widget",
        "brief: Surface mountain trail status on the booking page.",
        "</propose-idea>",
      ].join("\n"),
    ]);
    const { prompter } = makeScriptedPrompter(["y"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Considering value-add for guests.",
      prompter,
    });
    expect(result.outcome).toBe("idea");
    const ideasText = fs.readFileSync(
      businessIdeasFile(sandbox.dataDir),
      "utf8",
    );
    expect(ideasText).toContain("Trail conditions widget");
    expect(ideasText).toContain("Surface mountain trail status");
  });

  it("drafts a Strategist plan when the user accepts a propose-plan", async () => {
    const { client } = makeMockClient([
      "<propose-plan>Inline-validate the address field on checkout.</propose-plan>",
      PLAN_BLOCK,
    ]);
    const { prompter } = makeScriptedPrompter(["y"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "The funnel is leaking at the address step.",
      prompter,
    });
    expect(result.outcome).toBe("plan");
    expect(result.refId).toBeDefined();
    expect(result.refId).toMatch(/^\d{4}-\d{2}-\d{2}-discuss-driven-plan/);
  });

  it("rejects + comments folds the comment back as a refinement", async () => {
    const { client, calls } = makeMockClient([
      "<propose-note>note A</propose-note>",
      "<close>fair, dropping it.</close>",
    ]);
    const { prompter } = makeScriptedPrompter(["the wording is wrong"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Want to capture a thought.",
      prompter,
    });
    expect(result.outcome).toBe("closed");
    // Second call should see the user's rejection comment in conversation.
    const secondCall = calls[1]!;
    const userMessages = secondCall.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(userMessages.some((c) => c.includes("the wording is wrong"))).toBe(
      true,
    );
    // Note file must NOT have been written.
    expect(
      fs.existsSync(notesFile(sandbox.dataDir, "personal", "demo")),
    ).toBe(false);
  });

  it("plain n rejects without comment and continues", async () => {
    const { client } = makeMockClient([
      "<propose-note>n note</propose-note>",
      "<close>ok then.</close>",
    ]);
    const { prompter } = makeScriptedPrompter(["n"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Whatever.",
      prompter,
    });
    expect(result.outcome).toBe("closed");
    expect(
      fs.existsSync(notesFile(sandbox.dataDir, "personal", "demo")),
    ).toBe(false);
  });

  it("respects maxTurns and closes if the cap is hit", async () => {
    const { client } = makeMockClient([
      "<continue>q1</continue>",
      "<continue>q2</continue>",
    ]);
    const { prompter } = makeScriptedPrompter(["a1", "a2"]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Topic.",
      prompter,
      maxTurns: 2,
    });
    expect(result.outcome).toBe("closed");
    expect(result.turns).toBe(2);
  });

  it("records conversation-started + conversation-closed events", async () => {
    const { client } = makeMockClient([
      "<close>done.</close>",
    ]);
    const { prompter } = makeScriptedPrompter([]);
    const result = await runDiscuss({
      client,
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "Hi.",
      prompter,
    });
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT kind, payload FROM events WHERE kind LIKE 'conversation-%' ORDER BY id ASC",
        )
        .all() as Array<{ kind: string; payload: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.kind).toBe("conversation-started");
      expect(rows[1]?.kind).toBe("conversation-closed");
      const startPayload = JSON.parse(rows[0]!.payload);
      expect(startPayload.conversationId).toBe(result.conversationId);
      expect(startPayload.topic).toBe("Hi.");
    } finally {
      db.close();
    }
  });

  it("surfaces parser errors as DiscussError", async () => {
    const { client } = makeMockClient(["just prose"]);
    const { prompter } = makeScriptedPrompter([]);
    await expect(
      runDiscuss({
        client,
        app: "demo",
        vault: "personal",
        dataDir: sandbox.dataDir,
        topic: "Hi.",
        prompter,
      }),
    ).rejects.toThrow(DiscussError);
  });

  it("works without a brain — soft-skip the project context block", async () => {
    const { client, calls } = makeMockClient([
      "<close>k.</close>",
    ]);
    const { prompter } = makeScriptedPrompter([]);
    await runDiscuss({
      client,
      app: "no-brain-app",
      vault: "personal",
      dataDir: sandbox.dataDir,
      topic: "First thoughts.",
      prompter,
    });
    expect(calls).toHaveLength(1);
    const firstUser = calls[0]!.messages.find((m) => m.role === "user");
    const content =
      typeof firstUser?.content === "string" ? firstUser.content : "";
    expect(content).toContain("No brain on file");
  });
});

// Type smoke test — make sure the discriminator stays exhaustive.
describe("DiscussTurnResult discriminator", () => {
  it("covers all kinds", () => {
    const samples: DiscussTurnResult[] = [
      { kind: "continue", text: "x" },
      { kind: "propose-plan", brief: "x" },
      { kind: "propose-idea", title: "x", brief: "y" },
      { kind: "propose-note", text: "x" },
      { kind: "propose-setup-task", title: "x", detail: "y" },
      { kind: "close", text: "x" },
    ];
    expect(samples).toHaveLength(6);
  });
});
