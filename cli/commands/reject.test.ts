import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlan } from "../../orchestrator/plan.ts";
import { checkpointsDir, dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runReject } from "./reject.ts";

describe("runReject", () => {
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

  it("transitions awaiting-review → rejected", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-test", {
      status: "awaiting-review",
    });
    const code = await runReject(["2026-04-27-test"]);
    expect(code).toBe(0);
    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "rejected",
    );
  });

  it("stores --category in the feedback context_snapshot", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    await runReject([
      "2026-04-27-test",
      "--category",
      "duplicate",
      "--note",
      "we shipped this last quarter",
    ]);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const feedback = db
        .prepare("SELECT * FROM feedback WHERE kind = 'reject'")
        .all() as Array<{ note: string; context_snapshot: string | null }>;
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.note).toBe("we shipped this last quarter");
      expect(JSON.parse(feedback[0]!.context_snapshot!)).toEqual({
        category: "duplicate",
      });
    } finally {
      db.close();
    }
  });

  it("returns 1 when the plan is not in awaiting-review", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "draft" });
    expect(await runReject(["2026-04-27-test"])).toBe(1);
  });

  function writeCheckpoint(planId: string): string {
    const dir = checkpointsDir(sandbox.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${planId}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        planId,
        branch: "feat/x",
        sha: "abc",
        modifiedFiles: [],
        amendmentReason: "r",
        amendmentProposal: "p",
        timestamp: "2026-05-05T00:00:00Z",
      }),
    );
    return filePath;
  }

  it("removes the amendment checkpoint when rejecting an amendment-state plan", async () => {
    const planId = "2026-04-27-amend-reject";
    dropPlan(sandbox, planId, { status: "awaiting-review" });
    const checkpointPath = writeCheckpoint(planId);
    expect(fs.existsSync(checkpointPath)).toBe(true);

    const code = await runReject([planId]);
    expect(code).toBe(0);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("rejects cleanly when no checkpoint exists (no-op cleanup)", async () => {
    const planId = "2026-04-27-no-checkpoint";
    dropPlan(sandbox, planId, { status: "awaiting-review" });
    // No writeCheckpoint() call

    const code = await runReject([planId]);
    expect(code).toBe(0);
    // Plan is rejected on disk
    const finalPath = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "plans",
      "jarvis",
      `${planId}.md`,
    );
    expect(parsePlan(fs.readFileSync(finalPath, "utf8")).metadata.status).toBe(
      "rejected",
    );
  });

  it("does NOT remove the checkpoint when reject fails (wrong-state path)", async () => {
    const planId = "2026-04-27-wrong-state";
    dropPlan(sandbox, planId, { status: "draft" });
    const checkpointPath = writeCheckpoint(planId);

    expect(await runReject([planId])).toBe(1);
    // Checkpoint left intact — reject returned an error, no cleanup
    expect(fs.existsSync(checkpointPath)).toBe(true);
  });
});
