import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbFile } from "../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import { runLearnScan } from "./analyst-learn.ts";

function seedFeedback(
  sandbox: InstallSandbox,
  rows: Array<{
    kind: "approve" | "reject" | "revise";
    targetId: string;
    note?: string;
    actor?: string;
    daysAgo?: number;
  }>,
): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    for (const r of rows) {
      const createdAt = (() => {
        const d = new Date();
        d.setDate(d.getDate() - (r.daysAgo ?? 0));
        return d.toISOString();
      })();
      const input: Parameters<typeof recordFeedback>[1] = {
        kind: r.kind,
        actor: r.actor ?? "user",
        targetType: "plan",
        targetId: r.targetId,
        createdAt,
      };
      if (r.note !== undefined) input.note = r.note;
      recordFeedback(db, input);
    }
  } finally {
    db.close();
  }
}

describe("runLearnScan", () => {
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

  it("returns an empty report when no feedback exists", () => {
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.scannedFeedbackRows).toBe(0);
    expect(r.rejectionThemes).toEqual([]);
    expect(r.reviseThemes).toEqual([]);
    expect(r.lowApprovalRates).toEqual([]);
    expect(r.recommendations).toEqual([]);
  });

  it("clusters rejection themes by recurring tokens", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope too broad" },
      { kind: "reject", targetId: "plan-2", note: "scope is unclear" },
      { kind: "reject", targetId: "plan-3", note: "scope creep — stop" },
      { kind: "reject", targetId: "plan-4", note: "looks fine actually" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    const scope = r.rejectionThemes.find((t) => t.token === "scope");
    expect(scope).toBeDefined();
    expect(scope?.count).toBe(3);
    expect(scope?.examplePlanIds).toEqual(
      expect.arrayContaining(["plan-1", "plan-2", "plan-3"]),
    );
  });

  it("does not cluster tokens below the threshold (3)", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope too broad" },
      { kind: "reject", targetId: "plan-2", note: "scope is unclear" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.rejectionThemes).toEqual([]);
  });

  it("dedupes mentions across the same plan id", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope scope scope" },
      { kind: "reject", targetId: "plan-1", note: "scope again" },
      { kind: "reject", targetId: "plan-2", note: "scope is bad" },
      { kind: "reject", targetId: "plan-3", note: "scope creep" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    const scope = r.rejectionThemes.find((t) => t.token === "scope");
    // 3 distinct plan ids ('plan-1', 'plan-2', 'plan-3')
    expect(scope?.count).toBe(3);
  });

  it("revise themes cluster separately from rejection themes", () => {
    seedFeedback(sandbox, [
      { kind: "revise", targetId: "plan-a", note: "rollback section weak" },
      { kind: "revise", targetId: "plan-b", note: "rollback path missing" },
      { kind: "revise", targetId: "plan-c", note: "rollback unclear" },
      { kind: "reject", targetId: "plan-x", note: "totally different reason" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.reviseThemes.find((t) => t.token === "rollback")?.count).toBe(3);
    expect(r.rejectionThemes).toEqual([]);
  });

  it("light stemming clusters inflected forms", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "rejecting this approach" },
      { kind: "reject", targetId: "plan-2", note: "rejected — try again" },
      { kind: "reject", targetId: "plan-3", note: "rejects the brief" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    // All three forms collapse to "reject" via stemming.
    const reject = r.rejectionThemes.find((t) => t.token === "reject");
    expect(reject?.count).toBe(3);
  });

  it("respects the `since` window — rows older than since are skipped", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "old-1", note: "scope problem", daysAgo: 60 },
      { kind: "reject", targetId: "old-2", note: "scope creep", daysAgo: 60 },
      { kind: "reject", targetId: "old-3", note: "scope wrong", daysAgo: 60 },
      { kind: "reject", targetId: "new-1", note: "scope too broad" },
    ]);
    const since = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    })();
    const r = runLearnScan({ dataDir: sandbox.dataDir, since });
    expect(r.scannedFeedbackRows).toBe(1);
    expect(r.rejectionThemes).toEqual([]); // only 1 in window, below threshold
  });

  it("low-approval rates surface plan-type / subtype with <50% approval over >=3 samples", () => {
    // Drop the actual plans on disk so listPlans finds them
    dropPlan(sandbox, "low-1", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-2", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-3", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-4", { type: "improvement", subtype: "new-feature" });
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "low-1" },
      { kind: "reject", targetId: "low-2" },
      { kind: "reject", targetId: "low-3" },
      { kind: "approve", targetId: "low-4" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.lowApprovalRates).toHaveLength(1);
    expect(r.lowApprovalRates[0]).toMatchObject({
      type: "improvement",
      subtype: "new-feature",
      approved: 1,
      total: 4,
    });
    expect(r.lowApprovalRates[0]?.rate).toBeLessThan(0.5);
  });

  it("doesn't surface low-approval when sample size is under 3", () => {
    dropPlan(sandbox, "small-1", { type: "improvement", subtype: "rework" });
    seedFeedback(sandbox, [{ kind: "reject", targetId: "small-1" }]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.lowApprovalRates).toEqual([]);
  });

  it("emits recommendations for the top 3 rejection / revise / low-approval signals", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "p-1", note: "scope too broad" },
      { kind: "reject", targetId: "p-2", note: "scope unclear" },
      { kind: "reject", targetId: "p-3", note: "scope creep" },
      { kind: "revise", targetId: "p-4", note: "rollback section weak" },
      { kind: "revise", targetId: "p-5", note: "rollback missing" },
      { kind: "revise", targetId: "p-6", note: "rollback unclear" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.recommendations.some((rec) => rec.includes("scope"))).toBe(true);
    expect(r.recommendations.some((rec) => rec.includes("rollback"))).toBe(
      true,
    );
  });

  it("records a learn-scan-completed event", () => {
    runLearnScan({ dataDir: sandbox.dataDir });
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'learn-scan-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload);
      expect(payload).toMatchObject({
        scannedFeedbackRows: 0,
        rejectionThemes: 0,
      });
    } finally {
      db.close();
    }
  });
});
