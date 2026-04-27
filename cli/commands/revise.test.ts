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
import { runRevise } from "./revise.ts";

describe("runRevise", () => {
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

  it("transitions awaiting-review → draft and stores feedback note", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-test", {
      status: "awaiting-review",
    });

    const code = await runRevise([
      "2026-04-27-test",
      "scope is too broad",
    ]);
    expect(code).toBe(0);

    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "draft",
    );

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const feedback = db
        .prepare("SELECT * FROM feedback WHERE kind = 'revise'")
        .all() as Array<{ note: string }>;
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.note).toBe("scope is too broad");
    } finally {
      db.close();
    }
  });

  it("accepts --note as an alternative to a positional note", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    expect(
      await runRevise([
        "2026-04-27-test",
        "--note",
        "swap the framing",
      ]),
    ).toBe(0);
  });

  it("returns 1 when no feedback is provided", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    expect(await runRevise(["2026-04-27-test"])).toBe(1);
  });

  it("returns 1 when the plan is not in awaiting-review", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "draft" });
    expect(await runRevise(["2026-04-27-test", "fix this"])).toBe(1);
  });
});
