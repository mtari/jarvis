import fs from "node:fs";
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
import { parsePlan } from "./plan.ts";
import {
  approvePlan,
  rejectPlan,
  revisePlan,
  REVISE_CAP,
} from "./plan-lifecycle.ts";
import { recordFeedback } from "./feedback-store.ts";
import { findPlan } from "./plan-store.ts";

describe("plan-lifecycle", () => {
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

  describe("approvePlan", () => {
    it("transitions awaiting-review → approved on a clean plan", () => {
      const path = dropPlan(sandbox, "2026-04-28-test", {
        status: "awaiting-review",
      });
      const result = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-test",
      );
      expect(result.ok).toBe(true);
      expect(parsePlan(fs.readFileSync(path, "utf8")).metadata.status).toBe(
        "approved",
      );
    });

    it("returns wrong-state when plan is in draft", () => {
      dropPlan(sandbox, "2026-04-28-test", { status: "draft" });
      const result = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-test",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("wrong-state");
    });

    it("refuses destructive without confirmation", () => {
      dropPlan(sandbox, "2026-04-28-d", {
        status: "awaiting-review",
        destructive: true,
      });
      const denied = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-d",
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok)
        expect(denied.reason).toBe("destructive-not-confirmed");

      const allowed = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-d",
        { confirmDestructive: true },
      );
      expect(allowed.ok).toBe(true);
    });

    it("transitions parent improvement plan when an impl plan is approved", () => {
      const parentId = "2026-04-28-parent";
      dropPlan(sandbox, parentId, { status: "approved" });
      dropPlan(sandbox, `${parentId}-impl`, {
        type: "implementation",
        parentPlan: parentId,
        status: "awaiting-review",
      });
      const result = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        `${parentId}-impl`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parentTransitioned?.id).toBe(parentId);
        expect(result.parentTransitioned?.to).toBe("executing");
      }
      expect(findPlan(sandbox.dataDir, parentId)?.plan.metadata.status).toBe(
        "executing",
      );
    });
  });

  describe("revisePlan", () => {
    it("transitions awaiting-review → draft + records feedback", () => {
      dropPlan(sandbox, "2026-04-28-x", { status: "awaiting-review" });
      const result = revisePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-x",
        "scope is too broad",
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.priorRevisions).toBe(0);
    });

    it("hits the 3-cap escalation on the 4th attempt", () => {
      dropPlan(sandbox, "2026-04-28-cap", { status: "awaiting-review" });
      const seed = new Database(dbFile(sandbox.dataDir));
      try {
        for (let i = 0; i < REVISE_CAP; i += 1) {
          recordFeedback(seed, {
            kind: "revise",
            actor: "user",
            targetType: "plan",
            targetId: "2026-04-28-cap",
            note: `prior #${i + 1}`,
          });
        }
      } finally {
        seed.close();
      }
      const result = revisePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-cap",
        "fourth",
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "at-cap") {
        expect(result.priorRevisions).toBe(REVISE_CAP);
        expect(result.cap).toBe(REVISE_CAP);
      }
    });
  });

  describe("rejectPlan", () => {
    it("transitions awaiting-review → rejected and stores category in feedback context", () => {
      dropPlan(sandbox, "2026-04-28-r", { status: "awaiting-review" });
      const result = rejectPlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-r",
        { category: "duplicate", note: "already shipped" },
      );
      expect(result.ok).toBe(true);

      const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
      try {
        const fb = db
          .prepare(
            "SELECT * FROM feedback WHERE kind = 'reject' AND target_id = ?",
          )
          .get("2026-04-28-r") as {
          note: string | null;
          context_snapshot: string | null;
        };
        expect(fb.note).toBe("already shipped");
        expect(JSON.parse(fb.context_snapshot!)).toEqual({
          category: "duplicate",
        });
      } finally {
        db.close();
      }
    });

    it("returns wrong-state when plan is not in awaiting-review", () => {
      dropPlan(sandbox, "2026-04-28-d", { status: "draft" });
      const result = rejectPlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "2026-04-28-d",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("wrong-state");
    });
  });
});
