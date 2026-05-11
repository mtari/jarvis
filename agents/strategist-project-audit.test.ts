import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { dbFile, brainDir, brainFile } from "../cli/paths.ts";
import { saveBrain } from "../orchestrator/brain.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { runProjectAudit } from "./strategist-project-audit.ts";

const TARGET_APP = "erdei-fahazak";
const TARGET_VAULT = "personal";

const IMPROVEMENT_PLAN_RESPONSE = `<plan>
# Plan: Improve caching layer
Type: improvement
Subtype: rework
ImplementationReview: required
App: erdei-fahazak
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 75 — fixture

## Problem
Cache hit rate is low.

## Build plan
- Rework caching strategy.

## Testing strategy
Manual.

## Acceptance criteria
- ok

## Success metric
- Metric: cache hit rate
- Baseline: 20%
- Target: 60%
- Data source: logs

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert commit.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause if cache miss rate increases.
</plan>`;

function fakeClient(text = IMPROVEMENT_PLAN_RESPONSE): AnthropicClient {
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

const A_NOW = new Date("2026-05-11T12:00:00.000Z");

function seedBrain(
  sandbox: InstallSandbox,
  app: string,
  vault: string,
  status: "active" | "maintenance" | "paused" = "active",
): void {
  fs.mkdirSync(brainDir(sandbox.dataDir, vault, app), { recursive: true });
  saveBrain(brainFile(sandbox.dataDir, vault, app), {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: status,
    projectPriority: 3,
  });
}

function seedTransition(
  sandbox: InstallSandbox,
  app: string,
  vault: string,
  atIso?: string,
): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "plan-transition",
      payload: { planId: "p1", from: "approved", to: "executing" },
      ...(atIso !== undefined && { createdAt: atIso }),
    });
  } finally {
    db.close();
  }
}

function seedSignal(
  sandbox: InstallSandbox,
  app: string,
  vault: string,
  atIso?: string,
): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "signal",
      payload: { kind: "yarn-audit", severity: "moderate", title: "dep issue" },
      ...(atIso !== undefined && { createdAt: atIso }),
    });
  } finally {
    db.close();
  }
}

describe("runProjectAudit", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    seedBrain(sandbox, TARGET_APP, TARGET_VAULT, "active");
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("skips when brain.projectStatus is paused", async () => {
    seedBrain(sandbox, TARGET_APP, TARGET_VAULT, "paused");
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("app-paused");
  });

  it("skips when brain.projectStatus is maintenance", async () => {
    seedBrain(sandbox, TARGET_APP, TARGET_VAULT, "maintenance");
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("app-paused");
  });

  it("skips when audit ran within the past 24h", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    // First run
    const r1 = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(r1.ran).toBe(true);
    // Second run 2h later — still within idempotency window
    const later = new Date(A_NOW.getTime() + 2 * 60 * 60 * 1000);
    const r2 = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: later,
    });
    expect(r2.ran).toBe(false);
    expect(r2.skipReason).toBe("already-ran-recently");
  });

  it("skips when backlog has 3 eligible improvement plans", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    for (const id of ["pa", "pb", "pc"]) {
      dropPlan(sandbox, `2026-05-11-${id}`, {
        type: "improvement",
        subtype: "new-feature",
        app: TARGET_APP,
        status: "awaiting-review",
      });
    }
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("backlog-full");
  });

  it("skips when no plan-transition and no signal events in 7d window", async () => {
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-context");
  });

  it("--force bypasses app-paused gate", async () => {
    seedBrain(sandbox, TARGET_APP, TARGET_VAULT, "paused");
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
      force: true,
    });
    // app-paused is NOT bypassed by force in the plan spec; however the
    // spec says force bypasses already-ran-recently and no-context but NOT
    // backlog-full. Re-reading: "force bypasses app-paused, already-ran-recently,
    // no-context" per plan. Paused brain with force → should proceed to draft.
    expect(result.ran).toBe(true);
  });

  it("--force bypasses already-ran-recently gate", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    // First run
    await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    // Second run with --force
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
      force: true,
    });
    expect(result.ran).toBe(true);
  });

  it("--force bypasses no-context gate", async () => {
    // No events seeded, but --force skips the no-context check
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
      force: true,
    });
    expect(result.ran).toBe(true);
  });

  it("--force still respects backlog-full", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    for (const id of ["a", "b", "c"]) {
      dropPlan(sandbox, `2026-05-11-${id}`, {
        type: "improvement",
        subtype: "new-feature",
        app: TARGET_APP,
        status: "awaiting-review",
      });
    }
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
      force: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("backlog-full");
  });

  it("--dry-run records event with drafted:false and mode:dry-run", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
      dryRun: true,
    });
    expect(result.ran).toBe(true);
    expect(result.drafted).toEqual([]);
    expect(result.mode).toBe("dry-run");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'project-audit-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      const p = JSON.parse(rows[0]!.payload) as {
        mode: string;
        drafted: unknown[];
      };
      expect(p.mode).toBe("dry-run");
      expect(p.drafted).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("happy path: drafts one improvement plan and records completion event", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.ran).toBe(true);
    expect(result.drafted).toHaveLength(1);
    expect(result.drafted[0]?.planId).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    expect(result.mode).toBe("live");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'project-audit-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      const p = JSON.parse(rows[0]!.payload) as {
        mode: string;
        drafted: string[];
      };
      expect(p.mode).toBe("live");
      expect(p.drafted).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("records correct event payload shape", async () => {
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT app_id, payload FROM events WHERE kind = 'project-audit-completed'",
        )
        .all() as Array<{ app_id: string; payload: string }>;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.app_id).toBe(TARGET_APP);
      const p = JSON.parse(row.payload) as {
        app: string;
        vault: string;
        drafted: string[];
        mode: string;
        transitionsCount: number;
        signalsCount: number;
      };
      expect(p.app).toBe(TARGET_APP);
      expect(p.vault).toBe(TARGET_VAULT);
      expect(p.mode).toBe("live");
      expect(p.transitionsCount).toBe(result.transitionsCount);
      expect(p.signalsCount).toBe(result.signalsCount);
    } finally {
      db.close();
    }
  });

  it("only counts events for the target app (app isolation)", async () => {
    const OTHER_APP = "other-app";
    seedBrain(sandbox, OTHER_APP, TARGET_VAULT, "active");
    // Seed events for both apps
    seedTransition(sandbox, TARGET_APP, TARGET_VAULT);
    seedSignal(sandbox, TARGET_APP, TARGET_VAULT);
    seedTransition(sandbox, OTHER_APP, TARGET_VAULT);
    seedTransition(sandbox, OTHER_APP, TARGET_VAULT);
    seedSignal(sandbox, OTHER_APP, TARGET_VAULT);

    const result = await runProjectAudit({
      dataDir: sandbox.dataDir,
      app: TARGET_APP,
      vault: TARGET_VAULT,
      client: fakeClient(),
      now: A_NOW,
    });
    expect(result.transitionsCount).toBe(1);
    expect(result.signalsCount).toBe(1);
  });
});
