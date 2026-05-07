import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbFile } from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import { computeTelemetry } from "./analyst-telemetry.ts";

describe("computeTelemetry", () => {
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

  function withDb<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("returns zeros on an empty event log", () => {
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.planTransitions.drafted).toBe(0);
    expect(report.planTransitions.approved).toBe(0);
    expect(report.planTransitions.rejected).toBe(0);
    expect(report.planTransitions.revised).toBe(0);
    expect(report.overrideRates).toEqual([]);
    expect(report.averageReviseRounds).toBe(0);
    expect(report.escalations).toEqual({
      recorded: 0,
      acknowledged: 0,
      outstanding: 0,
    });
    expect(report.learningLoop).toEqual({
      scansCompleted: 0,
      metaPlansDrafted: 0,
    });
  });

  it("counts plan-drafted and plan-transition events by destination", () => {
    withDb((db) => {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "p1", type: "improvement" },
      });
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "p2", type: "business" },
      });
      // p1: draft -> approved -> executing -> shipped-pending-impact -> success
      for (const to of [
        "approved",
        "executing",
        "shipped-pending-impact",
        "success",
      ]) {
        appendEvent(db, {
          appId: "jarvis",
          vaultId: "personal",
          kind: "plan-transition",
          payload: { planId: "p1", from: "x", to },
        });
      }
      // p2: draft -> draft (revise) -> rejected
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-transition",
        payload: { planId: "p2", from: "draft", to: "draft" },
      });
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-transition",
        payload: { planId: "p2", from: "draft", to: "rejected" },
      });
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.planTransitions.drafted).toBe(2);
    expect(report.planTransitions.approved).toBe(1);
    expect(report.planTransitions.executing).toBe(1);
    expect(report.planTransitions.shippedPendingImpact).toBe(1);
    expect(report.planTransitions.success).toBe(1);
    expect(report.planTransitions.revised).toBe(1);
    expect(report.planTransitions.rejected).toBe(1);
  });

  it("computes override rate per plan-type, worst first", () => {
    withDb((db) => {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "i1", type: "improvement" },
      });
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "i2", type: "improvement" },
      });
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "b1", type: "business" },
      });
      // improvement: 1 approve + 1 reject → rate 0.5
      recordFeedback(db, {
        kind: "approve",
        actor: "user",
        targetType: "plan",
        targetId: "i1",
      });
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: "i2",
      });
      // business: 1 reject + 1 revise → rate 1.0
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: "b1",
      });
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: "b1",
      });
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.overrideRates).toHaveLength(2);
    // worst first
    expect(report.overrideRates[0]?.type).toBe("business");
    expect(report.overrideRates[0]?.rate).toBe(1);
    expect(report.overrideRates[0]?.reviewed).toBe(2);
    expect(report.overrideRates[1]?.type).toBe("improvement");
    expect(report.overrideRates[1]?.rate).toBe(0.5);
    expect(report.overrideRates[1]?.approved).toBe(1);
    expect(report.overrideRates[1]?.rejected).toBe(1);
  });

  it("buckets feedback for unknown plans as 'unknown'", () => {
    withDb((db) => {
      // No plan-drafted recorded for this id.
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: "ghost-1",
      });
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.overrideRates).toHaveLength(1);
    expect(report.overrideRates[0]?.type).toBe("unknown");
    expect(report.overrideRates[0]?.rate).toBe(1);
  });

  it("computes average revise rounds over plans with terminal feedback", () => {
    withDb((db) => {
      // p1: 2 revises + approve. p2: approve only. p3: reject + 1 revise.
      // total revise = 3. terminal plans = 3. avg = 1.0
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: "p1",
      });
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: "p1",
      });
      recordFeedback(db, {
        kind: "approve",
        actor: "user",
        targetType: "plan",
        targetId: "p1",
      });
      recordFeedback(db, {
        kind: "approve",
        actor: "user",
        targetType: "plan",
        targetId: "p2",
      });
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: "p3",
      });
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: "p3",
      });
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.averageReviseRounds).toBe(1);
  });

  it("counts escalations and computes outstanding", () => {
    withDb((db) => {
      for (let i = 0; i < 3; i += 1) {
        appendEvent(db, {
          appId: "jarvis",
          vaultId: "personal",
          kind: "escalation",
          payload: { reason: `r${i}` },
        });
      }
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "escalation-acknowledged",
        payload: { reason: "r0" },
      });
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.escalations.recorded).toBe(3);
    expect(report.escalations.acknowledged).toBe(1);
    expect(report.escalations.outstanding).toBe(2);
  });

  it("counts learning-loop activity", () => {
    withDb((db) => {
      for (let i = 0; i < 4; i += 1) {
        appendEvent(db, {
          appId: "jarvis",
          vaultId: "personal",
          kind: "learn-scan-completed",
          payload: { findings: 0 },
        });
      }
      for (let i = 0; i < 2; i += 1) {
        appendEvent(db, {
          appId: "jarvis",
          vaultId: "personal",
          kind: "learn-meta-drafted",
          payload: { planId: `m${i}` },
        });
      }
    });
    const report = computeTelemetry({ dataDir: sandbox.dataDir });
    expect(report.learningLoop.scansCompleted).toBe(4);
    expect(report.learningLoop.metaPlansDrafted).toBe(2);
  });

  it("respects the --since window: older events excluded", () => {
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 60);
    withDb((db) => {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "old", type: "improvement" },
        createdAt: longAgo.toISOString(),
      });
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "new", type: "improvement" },
      });
    });
    const since = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    })();
    const report = computeTelemetry({ dataDir: sandbox.dataDir, since });
    expect(report.planTransitions.drafted).toBe(1);
    expect(report.since).toBe(since);
  });

  it("records a telemetry-computed event after computation", () => {
    const fixedNow = new Date("2026-05-06T12:00:00.000Z");
    computeTelemetry({ dataDir: sandbox.dataDir, now: fixedNow });
    const rows = withDb((db) =>
      db
        .prepare(
          "SELECT payload, created_at FROM events WHERE kind = 'telemetry-computed'",
        )
        .all() as Array<{ payload: string; created_at: string }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(fixedNow.toISOString());
    const payload = JSON.parse(rows[0]!.payload) as { windowDays: number };
    expect(payload.windowDays).toBeGreaterThan(0);
  });
});
