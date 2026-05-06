import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { saveBrain } from "../orchestrator/brain.ts";
import { loadDocsIndex } from "../orchestrator/docs.ts";
import {
  brainFile,
  dbFile,
  planDir,
} from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { absorbDoc, DocAbsorbError } from "./strategist-doc-absorb.ts";

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

function fakeClient(text: string): AnthropicClient {
  return {
    async chat() {
      const r: ChatResponse = {
        text,
        blocks: [{ type: "text", text }],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
      return r;
    },
  };
}

const VALID_PLAN = [
  "<plan>",
  "# Plan: Absorb brand-guide into demo brain",
  "Type: improvement",
  "Subtype: meta",
  "ImplementationReview: skip",
  "App: demo",
  "Priority: normal",
  "Destructive: false",
  "Status: draft",
  "Author: strategist",
  "Confidence: 75 — fixture",
  "",
  "## Problem",
  "Brain lacks brand voice; doc fills it.",
  "",
  "## Build plan",
  "- Apply the brain changes below.",
  "- Write doc id to docs.json.",
  "",
  "## Brain changes (proposed)",
  "- `brand.voice`: add — \"warm, factual\"",
  "",
  "## Doc summary",
  "Brand voice is warm and factual.",
  "More detail in the second line.",
  "",
  "## Testing strategy",
  "Manual diff.",
  "",
  "## Acceptance criteria",
  "- brand.voice set",
  "",
  "## Success metric",
  "- Metric: subjective",
  "- Baseline: pre",
  "- Target: post",
  "- Data source: manual",
  "",
  "## Observation window",
  "N/A.",
  "",
  "## Connections required",
  "- None: present",
  "",
  "## Rollback",
  "Revert brain.json.",
  "",
  "## Estimated effort",
  "- Claude calls: 1",
  "- Your review time: 5 min",
  "- Wall-clock to ship: minutes",
  "",
  "## Amendment clauses",
  "Pause if conflicting.",
  "</plan>",
].join("\n");

describe("absorbDoc", () => {
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

  it("drafts a meta plan + persists docs.json entry", async () => {
    const result = await absorbDoc({
      client: fakeClient(VALID_PLAN),
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      source: "/tmp/brand-guide.md",
      docContent: "Brand voice is warm and factual.",
    });
    expect(result.planId).toMatch(/absorb-brand-guide/);

    // Plan file written to plans dir
    const folder = planDir(sandbox.dataDir, "personal", "demo");
    const files = fs.readdirSync(folder).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const planText = fs.readFileSync(path.join(folder, files[0]!), "utf8");
    expect(planText).toContain("Type: improvement");
    expect(planText).toContain("Subtype: meta");
    expect(planText).toContain("Status: awaiting-review");

    // docs.json entry has retention=absorbed and a non-empty summary
    const docs = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.retention).toBe("absorbed");
    expect(docs[0]?.cachedFile).toBeUndefined();
    expect(docs[0]?.summary).toContain("Brand voice");

    // doc-absorb-proposed event recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'doc-absorb-proposed'",
        )
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({
        docId: result.docId,
        planId: result.planId,
        source: "/tmp/brand-guide.md",
      });
    } finally {
      db.close();
    }
  });

  it("throws DocAbsorbError when Strategist returns clarify (doc not project-relevant)", async () => {
    await expect(
      absorbDoc({
        client: fakeClient(
          "<clarify>\nDoc has nothing project-scoped.\n</clarify>",
        ),
        app: "demo",
        vault: "personal",
        dataDir: sandbox.dataDir,
        source: "/tmp/random.md",
        docContent: "Random unrelated content.",
      }),
    ).rejects.toThrow(DocAbsorbError);
  });

  it("throws when plan validates but isn't improvement/meta", async () => {
    const wrongType = VALID_PLAN.replace(
      "Type: improvement\nSubtype: meta",
      "Type: improvement\nSubtype: new-feature",
    ).replace("ImplementationReview: skip", "ImplementationReview: required");
    await expect(
      absorbDoc({
        client: fakeClient(wrongType),
        app: "demo",
        vault: "personal",
        dataDir: sandbox.dataDir,
        source: "/tmp/x.md",
        docContent: "x",
      }),
    ).rejects.toThrow(/improvement\/meta/);
  });

  it("throws when plan app doesn't match input app", async () => {
    const wrongApp = VALID_PLAN.replace("App: demo", "App: other");
    await expect(
      absorbDoc({
        client: fakeClient(wrongApp),
        app: "demo",
        vault: "personal",
        dataDir: sandbox.dataDir,
        source: "/tmp/x.md",
        docContent: "x",
      }),
    ).rejects.toThrow(/doesn't match/);
  });

  it("disambiguates docId when source slug collides with an existing doc", async () => {
    // Pre-seed an existing entry that would collide on docIdFromSource
    const docPath = "/tmp/brand-guide.md";
    await absorbDoc({
      client: fakeClient(VALID_PLAN),
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      source: docPath,
      docContent: "first",
    });
    // Second absorb with same slug source but different exact path
    const result2 = await absorbDoc({
      client: fakeClient(VALID_PLAN),
      app: "demo",
      vault: "personal",
      dataDir: sandbox.dataDir,
      source: "/elsewhere/brand-guide.md",
      docContent: "second",
    });
    expect(result2.docId).toMatch(/-2$/);
  });
});
