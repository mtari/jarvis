import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainFile, dbFile } from "../cli/paths.ts";
import { loadBrain, saveBrain } from "./brain.ts";
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

    it("auto-applies brain updates from a meta plan on approval", () => {
      const planPath = path.join(
        sandbox.dataDir,
        "vaults",
        "personal",
        "plans",
        "demo",
        "absorb-brand.md",
      );
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(
        planPath,
        [
          "# Plan: Absorb brand voice",
          "Type: improvement",
          "Subtype: meta",
          "ImplementationReview: skip",
          "App: demo",
          "Priority: normal",
          "Destructive: false",
          "Status: awaiting-review",
          "Author: strategist",
          "Confidence: 75 — fixture",
          "",
          "## Problem",
          "x",
          "",
          "## Build plan",
          "- Apply.",
          "",
          "## Brain changes (proposed)",
          '- `brand.voice`: refine — "warm, factual"',
          '- `stack.framework`: conflict — disagree',
          "",
          "## Doc summary",
          "x",
          "",
          "## Testing strategy",
          "Manual diff.",
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
          "N/A.",
          "",
          "## Connections required",
          "- None: present",
          "",
          "## Rollback",
          "Revert.",
          "",
          "## Estimated effort",
          "- Claude calls: 1",
          "- Your review time: 5 min",
          "- Wall-clock to ship: minutes",
          "",
          "## Amendment clauses",
          "Pause if conflicting.",
          "",
        ].join("\n"),
      );

      // Seed a minimal brain for the demo app
      const brainPath = brainFile(sandbox.dataDir, "personal", "demo");
      fs.mkdirSync(path.dirname(brainPath), { recursive: true });
      saveBrain(brainPath, {
        schemaVersion: 1,
        projectName: "demo",
        projectType: "app",
        projectStatus: "active",
        projectPriority: 3,
        userPreferences: {},
        connections: {},
        priorities: [],
        wip: {},
      });

      const result = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "absorb-brand",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.brainChangesApplied?.hasChanges).toBe(true);
      expect(result.brainChangesApplied?.applied).toHaveLength(1);
      expect(result.brainChangesApplied?.skipped).toHaveLength(1);

      const after = loadBrain(brainPath);
      expect(after.brand?.["voice"]).toBe("warm, factual");

      // brain-updated event recorded
      const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
      try {
        const events = db
          .prepare("SELECT payload FROM events WHERE kind = 'brain-updated'")
          .all() as Array<{ payload: string }>;
        expect(events).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it("non-meta plans don't trigger brain applier", () => {
      dropPlan(sandbox, "ordinary", { status: "awaiting-review" });
      const result = approvePlan(
        sandbox.dataDir,
        dbFile(sandbox.dataDir),
        "ordinary",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.brainChangesApplied).toBeUndefined();
      }
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
