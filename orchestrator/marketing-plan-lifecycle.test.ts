import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { dbFile } from "../cli/paths.ts";
import { findPlan } from "./plan-store.ts";
import {
  insertScheduledPost,
  type ScheduledPostInput,
} from "./scheduled-posts.ts";
import { reconcileMarketingPlanState } from "./marketing-plan-lifecycle.ts";

function dropMarketingPlan(
  sandbox: InstallSandbox,
  id: string,
  status: string,
): void {
  // Hand-write a marketing plan since the shared dropPlan helper
  // emits improvement plans by default.
  const planText = [
    "# Plan: April push",
    "Type: marketing",
    "Subtype: campaign",
    "App: demo",
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
    "(rows below)",
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
  ].join("\n");
  const dir = path.join(
    sandbox.dataDir,
    "vaults",
    "personal",
    "plans",
    "demo",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), planText);
}

function row(
  id: string,
  planId: string,
  overrides: Partial<ScheduledPostInput> = {},
): ScheduledPostInput {
  return {
    id,
    planId,
    appId: "demo",
    channel: "facebook",
    content: "x",
    assets: [],
    scheduledAt: "2026-04-08T09:00:00.000Z",
    ...overrides,
  };
}

describe("reconcileMarketingPlanState", () => {
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

  function reconcile(planId: string) {
    return reconcileMarketingPlanState({
      dataDir: sandbox.dataDir,
      dbFilePath: dbFile(sandbox.dataDir),
      planId,
      actor: "test",
    });
  }

  it("approved + rows present → executing", () => {
    dropMarketingPlan(sandbox, "p1", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p1"));
    } finally {
      db.close();
    }
    const result = reconcile("p1");
    expect(result.transitioned).toEqual([
      { from: "approved", to: "executing" },
    ]);
    expect(findPlan(sandbox.dataDir, "p1")?.plan.metadata.status).toBe(
      "executing",
    );
  });

  it("executing + all rows terminal → done", () => {
    dropMarketingPlan(sandbox, "p2", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p2", { status: "published" }));
      insertScheduledPost(db, row("post-2", "p2", { status: "skipped" }));
      insertScheduledPost(db, row("post-3", "p2", { status: "failed" }));
    } finally {
      db.close();
    }
    const result = reconcile("p2");
    // Two transitions in one call: approved → executing → done.
    expect(result.transitioned).toEqual([
      { from: "approved", to: "executing" },
      { from: "executing", to: "done" },
    ]);
    expect(findPlan(sandbox.dataDir, "p2")?.plan.metadata.status).toBe("done");
  });

  it("approved + rows have any pending → executing only (not done)", () => {
    dropMarketingPlan(sandbox, "p3", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p3", { status: "published" }));
      insertScheduledPost(db, row("post-2", "p3", { status: "pending" }));
    } finally {
      db.close();
    }
    const result = reconcile("p3");
    expect(result.transitioned).toEqual([
      { from: "approved", to: "executing" },
    ]);
    expect(findPlan(sandbox.dataDir, "p3")?.plan.metadata.status).toBe(
      "executing",
    );
  });

  it("awaiting-review rows count as open (single-post plans)", () => {
    dropMarketingPlan(sandbox, "p4", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p4", { status: "awaiting-review" }));
    } finally {
      db.close();
    }
    const result = reconcile("p4");
    // approved → executing happens, but not yet → done (row still open).
    expect(result.transitioned).toEqual([
      { from: "approved", to: "executing" },
    ]);
  });

  it("approved + zero rows → no transition", () => {
    dropMarketingPlan(sandbox, "p5", "approved");
    const result = reconcile("p5");
    expect(result.transitioned).toEqual([]);
    expect(findPlan(sandbox.dataDir, "p5")?.plan.metadata.status).toBe(
      "approved",
    );
  });

  it("idempotent — re-running on a plan already at done is a no-op", () => {
    dropMarketingPlan(sandbox, "p6", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p6", { status: "published" }));
    } finally {
      db.close();
    }
    reconcile("p6");
    const result = reconcile("p6");
    expect(result.transitioned).toEqual([]);
  });

  it("returns planNotFound when plan id doesn't exist", () => {
    const result = reconcile("ghost");
    expect(result.planNotFound).toBe(true);
    expect(result.transitioned).toEqual([]);
  });

  it("non-marketing plans are skipped silently", () => {
    dropPlan(sandbox, "code-plan", { status: "approved" });
    const result = reconcile("code-plan");
    expect(result.planNotFound).toBe(false);
    expect(result.transitioned).toEqual([]);
    expect(
      findPlan(sandbox.dataDir, "code-plan")?.plan.metadata.status,
    ).toBe("approved");
  });

  it("plans in terminal state (done / cancelled / rejected) are not reverted", () => {
    dropMarketingPlan(sandbox, "done-plan", "approved");
    // Manually push to done first
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "done-plan", { status: "published" }));
    } finally {
      db.close();
    }
    reconcile("done-plan"); // approved → executing → done
    expect(
      findPlan(sandbox.dataDir, "done-plan")?.plan.metadata.status,
    ).toBe("done");

    // Insert a fresh "pending" row (e.g. simulating an out-of-band edit)
    const db2 = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(
        db2,
        row("post-2", "done-plan", { status: "pending" }),
      );
    } finally {
      db2.close();
    }
    // Reconcile again — should NOT pull plan back to executing
    const result = reconcile("done-plan");
    expect(result.transitioned).toEqual([]);
    expect(
      findPlan(sandbox.dataDir, "done-plan")?.plan.metadata.status,
    ).toBe("done");
  });

  it("records plan-transition events in the event log", () => {
    dropMarketingPlan(sandbox, "p-evt", "approved");
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("post-1", "p-evt", { status: "published" }));
    } finally {
      db.close();
    }
    reconcile("p-evt");
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = verifyDb
        .prepare("SELECT payload FROM events WHERE kind = 'plan-transition'")
        .all() as Array<{ payload: string }>;
      expect(events.length).toBe(2);
      const parsed = events.map((e) => JSON.parse(e.payload));
      expect(parsed[0]).toMatchObject({
        planId: "p-evt",
        from: "approved",
        to: "executing",
        actor: "test",
        reason: "marketing-rows-state",
      });
      expect(parsed[1]).toMatchObject({
        planId: "p-evt",
        from: "executing",
        to: "done",
        actor: "test",
      });
    } finally {
      verifyDb.close();
    }
  });
});
