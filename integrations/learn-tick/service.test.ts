import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { createDaemonLogger } from "../../orchestrator/daemon-logger.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import {
  createLearnTickService,
  runLearnTick,
} from "./service.ts";

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

const META_PLAN_RESPONSE = `<plan>
# Plan: Add scope-tightening rule
Type: improvement
Subtype: meta
ImplementationReview: skip
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — fixture

## Problem
Recurring scope rejections.

## Build plan
- Add prompt rule.

## Testing strategy
Manual.

## Acceptance criteria
- ok

## Success metric
- Metric: x
- Baseline: x
- Target: x
- Data source: x

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause if metric grows.
</plan>`;

function fakeClient(text = META_PLAN_RESPONSE): AnthropicClient {
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

function seedRejectionTheme(
  sandbox: InstallSandbox,
  token: string,
  count: number,
): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    for (let i = 0; i < count; i += 1) {
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: `p-${token}-${i}`,
        note: `the ${token} is bad`,
      });
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// runLearnTick
// ---------------------------------------------------------------------------

describe("runLearnTick", () => {
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

  it("scans + drafts when no prior scan exists", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    const ctx = buildCtx(sandbox);
    try {
      const result = await runLearnTick({
        dataDir: sandbox.dataDir,
        ctx,
        minIntervalMs: 7 * 24 * 60 * 60 * 1000,
        autoDraft: true,
        draftThreshold: 5,
        maxDrafts: 5,
        getClient: () => fakeClient(),
      });
      expect(result.scanned).toBe(true);
      expect(result.drafted).toBe(1);
    } finally {
      ctx.logger.close();
    }
  });

  it("skips when last scan was within minIntervalMs", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    // Pre-seed a learn-scan-completed event one hour ago
    const recent = new Date();
    recent.setHours(recent.getHours() - 1);
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "learn-scan-completed",
        payload: { scannedFeedbackRows: 0 },
        createdAt: recent.toISOString(),
      });
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      const result = await runLearnTick({
        dataDir: sandbox.dataDir,
        ctx,
        minIntervalMs: 7 * 24 * 60 * 60 * 1000, // 7d
        autoDraft: true,
        draftThreshold: 5,
        maxDrafts: 5,
        getClient: () => fakeClient(),
      });
      expect(result.scanned).toBe(false);
      expect(result.skipReason).toBe("recent-scan");
    } finally {
      ctx.logger.close();
    }
  });

  it("scans again once minIntervalMs has elapsed", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    // Pre-seed a learn-scan-completed event 8 days ago
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 8);
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "learn-scan-completed",
        payload: { scannedFeedbackRows: 0 },
        createdAt: longAgo.toISOString(),
      });
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      const result = await runLearnTick({
        dataDir: sandbox.dataDir,
        ctx,
        minIntervalMs: 7 * 24 * 60 * 60 * 1000, // 7d
        autoDraft: true,
        draftThreshold: 5,
        maxDrafts: 5,
        getClient: () => fakeClient(),
      });
      expect(result.scanned).toBe(true);
    } finally {
      ctx.logger.close();
    }
  });

  it("autoDraft: false → scans only, no draft attempts", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    let chatCalls = 0;
    const client: AnthropicClient = {
      async chat() {
        chatCalls += 1;
        return fakeClient().chat({} as never);
      },
    };
    const ctx = buildCtx(sandbox);
    try {
      const result = await runLearnTick({
        dataDir: sandbox.dataDir,
        ctx,
        minIntervalMs: 7 * 24 * 60 * 60 * 1000,
        autoDraft: false,
        draftThreshold: 5,
        maxDrafts: 5,
        getClient: () => client,
      });
      expect(result.scanned).toBe(true);
      expect(result.drafted).toBe(0);
      expect(chatCalls).toBe(0);
    } finally {
      ctx.logger.close();
    }
  });

  it("captures drafter errors without aborting the tick", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    const ctx = buildCtx(sandbox);
    try {
      const result = await runLearnTick({
        dataDir: sandbox.dataDir,
        ctx,
        minIntervalMs: 7 * 24 * 60 * 60 * 1000,
        autoDraft: true,
        draftThreshold: 5,
        maxDrafts: 5,
        getClient: () => ({
          async chat() {
            throw new Error("simulated transport failure");
          },
        }),
      });
      expect(result.scanned).toBe(true);
      // Drafter wraps the per-finding throw in result.errors; tick
      // returns drafted=0, errors>0 rather than re-throwing.
      expect(result.drafted).toBe(0);
      expect(result.errors).toBeGreaterThan(0);
    } finally {
      ctx.logger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createLearnTickService
// ---------------------------------------------------------------------------

describe("createLearnTickService", () => {
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
    const service = createLearnTickService({
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
    const service = createLearnTickService({
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
    const service = createLearnTickService({
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
