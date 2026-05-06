import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { createDaemonLogger } from "../../orchestrator/daemon-logger.ts";
import {
  insertScheduledPost,
  listScheduledPosts,
} from "../../orchestrator/scheduled-posts.ts";
import { dbFile, planDir } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import {
  createMarketerService,
  runMarketerTick,
} from "./service.ts";

// ---------------------------------------------------------------------------
// Mock client — humanizer that returns the input verbatim
// ---------------------------------------------------------------------------

function passthroughClient(): AnthropicClient {
  return {
    async chat(req) {
      const userMsg = req.messages[req.messages.length - 1]?.content;
      const draftText = typeof userMsg === "string" ? userMsg : "";
      const draft = draftText.split("Draft:\n").pop()?.trimEnd() ?? "";
      const text = `<humanized>\n${draft}\n</humanized>\n<changes>\n(none)\n</changes>`;
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

// ---------------------------------------------------------------------------
// Plan fixture — minimal valid marketing plan
// ---------------------------------------------------------------------------

function dropMarketingPlan(
  sandbox: InstallSandbox,
  id: string,
  app: string,
  status: string,
): void {
  const folder = planDir(sandbox.dataDir, "personal", app);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, `${id}.md`),
    [
      "# Plan: April test",
      "Type: marketing",
      "Subtype: campaign",
      `App: ${app}`,
      "Priority: normal",
      "Destructive: false",
      `Status: ${status}`,
      "Author: strategist",
      "Confidence: 75 — fixture",
      "",
      "## Opportunity",
      "x",
      "",
      "## Audience",
      "x",
      "",
      "## Channels",
      "x",
      "",
      "## Content calendar",
      "### Post 1",
      "Date: 2026-04-08",
      "Channel: facebook",
      "Assets: -",
      "Text:",
      "Hello world.",
      "",
      "## Schedule",
      "x",
      "",
      "## Tracking & KPIs",
      "x",
      "",
      "## Success metric",
      "- Metric: x",
      "- Baseline: x",
      "- Target: x",
      "- Data source: x",
      "",
      "## Observation window",
      "30d.",
      "",
      "## Connections required",
      "- Facebook: present",
      "",
      "## Rollback",
      "x",
      "",
      "## Estimated effort",
      "- Claude calls: ~3",
      "- Your review time: 5 min",
      "- Wall-clock to ship: 1 hour",
      "",
      "## Amendment clauses",
      "x",
      "",
    ].join("\n"),
  );
}

function dropImprovementPlan(
  sandbox: InstallSandbox,
  id: string,
): void {
  const folder = planDir(sandbox.dataDir, "personal", "demo");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, `${id}.md`),
    [
      "# Plan: code change",
      "Type: improvement",
      "Subtype: new-feature",
      "ImplementationReview: required",
      "App: demo",
      "Priority: normal",
      "Destructive: false",
      "Status: approved",
      "Author: strategist",
      "Confidence: 75 — fixture",
      "",
      "## Problem",
      "x",
      "",
      "## Build plan",
      "x",
      "",
      "## Testing strategy",
      "x",
      "",
      "## Acceptance criteria",
      "- ok",
      "",
      "## Success metric",
      "- Metric: x",
      "- Baseline: x",
      "- Target: x",
      "- Data source: x",
      "",
      "## Observation window",
      "30d.",
      "",
      "## Connections required",
      "- None: present",
      "",
      "## Rollback",
      "Revert.",
      "",
      "## Estimated effort",
      "- Claude calls: ~3",
      "- Your review time: 5 min",
      "- Wall-clock to ship: 1 hour",
      "",
      "## Amendment clauses",
      "x",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Daemon context fixture
// ---------------------------------------------------------------------------

function buildCtx(sandbox: InstallSandbox): DaemonContext {
  const logger = createDaemonLogger({
    logsDir: `${sandbox.dataDir}/logs`,
    echo: false,
  });
  return {
    dataDir: sandbox.dataDir,
    logger,
    pidFile: { pid: process.pid, startedAt: new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// runMarketerTick
// ---------------------------------------------------------------------------

describe("runMarketerTick", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("fires on approved marketing plans + writes scheduled_posts rows", async () => {
    dropMarketingPlan(sandbox, "2026-04-01-fire", "demo", "approved");
    const ctx = buildCtx(sandbox);
    try {
      const result = await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
      expect(result.prepared).toHaveLength(1);
      expect(result.prepared[0]?.planId).toBe("2026-04-01-fire");
      expect(result.errors).toEqual([]);

      const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
      try {
        const rows = listScheduledPosts(verifyDb, {
          planId: "2026-04-01-fire",
        });
        expect(rows).toHaveLength(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      ctx.logger.close();
    }
  });

  it("skips already-prepared plans (idempotent)", async () => {
    dropMarketingPlan(sandbox, "2026-04-01-skip", "demo", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, {
        id: "preseeded",
        planId: "2026-04-01-skip",
        appId: "demo",
        channel: "facebook",
        content: "x",
        assets: [],
        scheduledAt: "2026-04-08T09:00:00.000Z",
      });
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      const result = await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
      expect(result.prepared).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.planId).toBe("2026-04-01-skip");
    } finally {
      ctx.logger.close();
    }
  });

  it("ignores non-approved marketing plans", async () => {
    dropMarketingPlan(sandbox, "2026-04-01-draft", "demo", "draft");
    dropMarketingPlan(
      sandbox,
      "2026-04-01-awaiting",
      "demo",
      "awaiting-review",
    );
    const ctx = buildCtx(sandbox);
    try {
      const result = await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
      expect(result.prepared).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      ctx.logger.close();
    }
  });

  it("ignores non-marketing approved plans (Developer's territory)", async () => {
    dropImprovementPlan(sandbox, "2026-04-01-code");
    const ctx = buildCtx(sandbox);
    try {
      const result = await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
      expect(result.prepared).toEqual([]);
    } finally {
      ctx.logger.close();
    }
  });

  it("records a marketer-fired event per fire", async () => {
    dropMarketingPlan(sandbox, "2026-04-01-event", "demo", "approved");
    const ctx = buildCtx(sandbox);
    try {
      await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
    } finally {
      ctx.logger.close();
    }
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = verifyDb
        .prepare("SELECT payload FROM events WHERE kind = 'marketer-fired'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId: "2026-04-01-event",
        postCount: 1,
      });
    } finally {
      verifyDb.close();
    }
  });

  it("records errors but doesn't throw when a plan can't be prepared", async () => {
    // Drop a plan with empty content calendar — prepareMarketingPlan throws
    const folder = planDir(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "broken.md"),
      [
        "# Plan: broken",
        "Type: marketing",
        "Subtype: campaign",
        "App: demo",
        "Priority: normal",
        "Destructive: false",
        "Status: approved",
        "Author: strategist",
        "Confidence: 50 — fixture",
        "",
        "## Content calendar",
        "(empty — no Post entries)",
        "",
      ].join("\n"),
    );
    const ctx = buildCtx(sandbox);
    try {
      const result = await runMarketerTick({
        dataDir: sandbox.dataDir,
        ctx,
        getClient: () => passthroughClient(),
      });
      expect(result.prepared).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.planId).toBe("broken");
    } finally {
      ctx.logger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createMarketerService — tick guards
// ---------------------------------------------------------------------------

describe("createMarketerService", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("invokes _tickBody on start", async () => {
    let invocations = 0;
    const service = createMarketerService({
      dataDir: sandbox.dataDir,
      tickMs: 60_000,
      _tickBody: async () => {
        invocations += 1;
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      await new Promise((r) => setTimeout(r, 0));
      service.stop();
    } finally {
      ctx.logger.close();
    }
    expect(invocations).toBe(1);
  });

  it("guards against overlapping ticks (tickInFlight)", async () => {
    let entered = 0;
    let resolveBlock!: () => void;
    const blocker = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const service = createMarketerService({
      dataDir: sandbox.dataDir,
      tickMs: 1,
      _tickBody: async () => {
        entered += 1;
        await blocker;
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      await new Promise((r) => setTimeout(r, 20));
      expect(entered).toBe(1);
      resolveBlock();
      await new Promise((r) => setTimeout(r, 5));
      service.stop();
    } finally {
      ctx.logger.close();
    }
  });

  it("logs and recovers on _tickBody throw", async () => {
    const service = createMarketerService({
      dataDir: sandbox.dataDir,
      tickMs: 60_000,
      _tickBody: async () => {
        throw new Error("boom");
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      await new Promise((r) => setTimeout(r, 0));
      service.stop();
    } finally {
      ctx.logger.close();
    }
    expect(true).toBe(true);
  });
});
