import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import { dbFile } from "../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { runFridayAudit } from "./strategist-friday-audit.ts";

const IMPROVEMENT_PLAN_RESPONSE = `<plan>
# Plan: Tighten Strategist scope rule
Type: improvement
Subtype: rework
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 75 — fixture

## Problem
Override rate climbing for improvement plans.

## Build plan
- Tighten the Strategist prompt around scope.

## Testing strategy
Manual.

## Acceptance criteria
- ok

## Success metric
- Metric: improvement override rate
- Baseline: 50%
- Target: 30%
- Data source: yarn jarvis telemetry

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert the prompt commit.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause if approval rate drops.
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

/** A Friday in May 2026 — used as a stable `now` for tests. */
const A_FRIDAY = new Date("2026-05-08T12:00:00.000Z");
/** A non-Friday in the same week. */
const A_TUESDAY = new Date("2026-05-05T12:00:00.000Z");

/** Seed a project shipment so the throughput gate passes. */
function seedProjectShipment(sandbox: InstallSandbox, atIso?: string): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    appendEvent(db, {
      appId: "erdei-fahazak",
      vaultId: "personal",
      kind: "plan-transition",
      payload: {
        planId: "p-ship-1",
        from: "executing",
        to: "shipped-pending-impact",
      },
      ...(atIso !== undefined && { createdAt: atIso }),
    });
  } finally {
    db.close();
  }
}

/** Seed enough feedback for hasMeaningfulSignal to clear. */
function seedSignal(sandbox: InstallSandbox): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "plan-drafted",
      payload: { planId: "x1", type: "improvement" },
    });
    recordFeedback(db, {
      kind: "reject",
      actor: "user",
      targetType: "plan",
      targetId: "x1",
      note: "the scope is bad",
    });
  } finally {
    db.close();
  }
}

describe("runFridayAudit", () => {
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

  it("skips when not Friday", async () => {
    seedProjectShipment(sandbox);
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_TUESDAY,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("not-friday");
    expect(result.drafted).toEqual([]);
  });

  it("skips when no project shipped in past 7 days", async () => {
    // Friday but no throughput.
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-throughput");
    expect(result.projectShipments).toBe(0);
  });

  it("excludes jarvis-app shipments from the throughput gate", async () => {
    // Only a jarvis shipment — does not count.
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-transition",
        payload: { planId: "j1", from: "executing", to: "shipped-pending-impact" },
      });
    } finally {
      db.close();
    }
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.skipReason).toBe("no-throughput");
    expect(result.projectShipments).toBe(0);
  });

  it("skips when an audit ran in the idempotency window", async () => {
    seedProjectShipment(sandbox);
    seedSignal(sandbox);
    // First run drafts.
    const r1 = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(r1.ran).toBe(true);
    // Second run, hours later, hits the idempotency window.
    const later = new Date(A_FRIDAY.getTime() + 2 * 60 * 60 * 1000);
    const r2 = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: later,
    });
    expect(r2.ran).toBe(false);
    expect(r2.skipReason).toBe("already-ran-recently");
  });

  it("skips when backlog is already at target depth", async () => {
    seedProjectShipment(sandbox);
    seedSignal(sandbox);
    // Three eligible jarvis improvement plans → backlog full.
    dropPlan(sandbox, "2026-05-08-pa", {
      type: "improvement",
      subtype: "new-feature",
      app: "jarvis",
      status: "awaiting-review",
    });
    dropPlan(sandbox, "2026-05-08-pb", {
      type: "improvement",
      subtype: "rework",
      app: "jarvis",
      status: "approved",
    });
    dropPlan(sandbox, "2026-05-08-pc", {
      type: "improvement",
      subtype: "refactor",
      app: "jarvis",
      status: "awaiting-review",
    });
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("backlog-full");
    expect(result.backlogDepth).toBe(3);
  });

  it("counts subtype=meta and non-improvement plans as outside the backlog", async () => {
    seedProjectShipment(sandbox);
    seedSignal(sandbox);
    // Meta and non-improvement plans should NOT count.
    dropPlan(sandbox, "2026-05-08-meta", {
      type: "improvement",
      subtype: "meta",
      app: "jarvis",
      status: "awaiting-review",
    });
    dropPlan(sandbox, "2026-05-08-biz", {
      type: "business",
      app: "jarvis",
      status: "awaiting-review",
    });
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.backlogDepth).toBe(0);
    expect(result.ran).toBe(true);
    expect(result.drafted).toHaveLength(1);
  });

  it("excludes out-of-window project shipments from throughput", async () => {
    // Shipment from 14 days ago — outside default 7d window.
    const longAgo = new Date(A_FRIDAY);
    longAgo.setDate(longAgo.getDate() - 14);
    seedProjectShipment(sandbox, longAgo.toISOString());
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.skipReason).toBe("no-throughput");
    expect(result.projectShipments).toBe(0);
  });

  it("skips with no-context (under --force) when telemetry + feedback are empty", async () => {
    // No seeded shipment, no seeded signal. --force bypasses
    // the throughput gate; the no-context branch then fires because
    // hasMeaningfulSignal sees an empty DB.
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
      force: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-context");
  });

  it("drafts a jarvis improvement plan when all gates pass", async () => {
    seedProjectShipment(sandbox);
    seedSignal(sandbox);
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
    });
    expect(result.ran).toBe(true);
    expect(result.drafted).toHaveLength(1);
    expect(result.drafted[0]?.planId).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    // friday-audit-completed event recorded.
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'friday-audit-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      const p = JSON.parse(rows[0]!.payload) as { mode: string; drafted: string[] };
      expect(p.mode).toBe("live");
      expect(p.drafted).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("--force bypasses the day-of-week + throughput + idempotency gates", async () => {
    // No throughput, not a Friday — should still run.
    seedSignal(sandbox);
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_TUESDAY,
      force: true,
    });
    expect(result.ran).toBe(true);
    expect(result.drafted).toHaveLength(1);
  });

  it("--force still respects backlog-full", async () => {
    seedSignal(sandbox);
    for (const id of ["a", "b", "c"]) {
      dropPlan(sandbox, `2026-05-08-${id}`, {
        type: "improvement",
        subtype: "new-feature",
        app: "jarvis",
        status: "awaiting-review",
      });
    }
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_TUESDAY,
      force: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("backlog-full");
  });

  it("--dry-run records a dry-run audit but does not draft", async () => {
    seedProjectShipment(sandbox);
    seedSignal(sandbox);
    const result = await runFridayAudit({
      dataDir: sandbox.dataDir,
      client: fakeClient(),
      now: A_FRIDAY,
      dryRun: true,
    });
    expect(result.ran).toBe(true);
    expect(result.drafted).toEqual([]);
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'friday-audit-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      const p = JSON.parse(rows[0]!.payload) as { mode: string };
      expect(p.mode).toBe("dry-run");
    } finally {
      db.close();
    }
  });
});
