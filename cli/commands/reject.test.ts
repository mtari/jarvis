import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlan } from "../../orchestrator/plan.ts";
import { dbFile } from "../paths.ts";
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
});
