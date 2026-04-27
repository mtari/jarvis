import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlan } from "../../orchestrator/plan-store.ts";
import { parsePlan } from "../../orchestrator/plan.ts";
import { dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runApprove } from "./approve.ts";

describe("runApprove", () => {
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

  it("transitions awaiting-review → approved + records event + feedback", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-test", {
      status: "awaiting-review",
    });

    const code = await runApprove(["2026-04-27-test"]);
    expect(code).toBe(0);

    const reread = parsePlan(fs.readFileSync(planPath, "utf8"));
    expect(reread.metadata.status).toBe("approved");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT * FROM events WHERE kind = 'plan-transition'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId: "2026-04-27-test",
        from: "awaiting-review",
        to: "approved",
      });

      const feedback = db
        .prepare("SELECT * FROM feedback WHERE kind = 'approve'")
        .all();
      expect(feedback).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("refuses without --confirm-destructive when plan is destructive", async () => {
    dropPlan(sandbox, "2026-04-27-destructive", {
      status: "awaiting-review",
      destructive: true,
    });

    const code = await runApprove(["2026-04-27-destructive"]);
    expect(code).toBe(1);
  });

  it("approves a destructive plan with --confirm-destructive", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-destructive", {
      status: "awaiting-review",
      destructive: true,
    });

    const code = await runApprove([
      "2026-04-27-destructive",
      "--confirm-destructive",
    ]);
    expect(code).toBe(0);
    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "approved",
    );
  });

  it("returns 1 for a missing plan", async () => {
    expect(await runApprove(["nonexistent"])).toBe(1);
  });

  it("returns 1 for a plan not in awaiting-review", async () => {
    dropPlan(sandbox, "2026-04-27-draft", { status: "draft" });
    expect(await runApprove(["2026-04-27-draft"])).toBe(1);
  });

  it("returns 1 with no plan id", async () => {
    expect(await runApprove([])).toBe(1);
  });

  it("transitions parent improvement plan approved → executing on impl approval", async () => {
    const parentId = "2026-04-27-parent";
    const implId = "2026-04-27-parent-impl";
    dropPlan(sandbox, parentId, { status: "approved" });
    dropPlan(sandbox, implId, {
      type: "implementation",
      parentPlan: parentId,
      status: "awaiting-review",
    });

    expect(await runApprove([implId])).toBe(0);

    const parent = findPlan(sandbox.dataDir, parentId);
    const impl = findPlan(sandbox.dataDir, implId);
    expect(parent?.plan.metadata.status).toBe("executing");
    expect(impl?.plan.metadata.status).toBe("approved");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const transitions = db
        .prepare(
          "SELECT * FROM events WHERE kind = 'plan-transition' ORDER BY id",
        )
        .all() as Array<{ payload: string }>;
      const decoded = transitions.map(
        (e) => JSON.parse(e.payload) as { planId: string; from: string; to: string },
      );
      expect(decoded).toContainEqual(
        expect.objectContaining({ planId: implId, from: "awaiting-review", to: "approved" }),
      );
      expect(decoded).toContainEqual(
        expect.objectContaining({ planId: parentId, from: "approved", to: "executing" }),
      );
    } finally {
      db.close();
    }
  });

  it("does not touch parent if parent isn't currently approved", async () => {
    const parentId = "2026-04-27-parent-paused";
    const implId = `${parentId}-impl`;
    dropPlan(sandbox, parentId, { status: "executing" });
    dropPlan(sandbox, implId, {
      type: "implementation",
      parentPlan: parentId,
      status: "awaiting-review",
    });

    expect(await runApprove([implId])).toBe(0);

    const parent = findPlan(sandbox.dataDir, parentId);
    expect(parent?.plan.metadata.status).toBe("executing");
  });
});
