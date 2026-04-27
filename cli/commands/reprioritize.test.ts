import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlan } from "../../orchestrator/plan-store.ts";
import { dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runReprioritize } from "./reprioritize.ts";

describe("runReprioritize", () => {
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

  it("requires --app, --plan, --priority", async () => {
    expect(await runReprioritize([])).toBe(1);
    expect(await runReprioritize(["--app", "jarvis"])).toBe(1);
    expect(
      await runReprioritize(["--app", "jarvis", "--plan", "x"]),
    ).toBe(1);
  });

  it("rejects invalid priority", async () => {
    dropPlan(sandbox, "2026-04-27-x", { status: "awaiting-review" });
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "2026-04-27-x",
        "--priority",
        "urgent",
      ]),
    ).toBe(1);
  });

  it("returns 1 when plan is not found", async () => {
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "missing",
        "--priority",
        "high",
      ]),
    ).toBe(1);
  });

  it("returns 1 when plan belongs to a different app", async () => {
    dropPlan(sandbox, "2026-04-27-other", {
      status: "awaiting-review",
      app: "other-app",
    });
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "2026-04-27-other",
        "--priority",
        "high",
      ]),
    ).toBe(1);
  });

  it("returns 1 when plan is in a non-backlog state", async () => {
    dropPlan(sandbox, "2026-04-27-done", { status: "done" });
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "2026-04-27-done",
        "--priority",
        "high",
      ]),
    ).toBe(1);
  });

  it("updates plan file's Priority + emits event + feedback", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-up", {
      status: "awaiting-review",
      priority: "low",
    });
    const code = await runReprioritize([
      "--app",
      "jarvis",
      "--plan",
      "2026-04-27-up",
      "--priority",
      "high",
    ]);
    expect(code).toBe(0);

    const reread = fs.readFileSync(planPath, "utf8");
    expect(reread).toContain("Priority: high");
    expect(reread).not.toContain("Priority: low");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT * FROM events WHERE kind = 'plan-reprioritize'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId: "2026-04-27-up",
        from: "low",
        to: "high",
      });

      const fb = db
        .prepare(
          "SELECT * FROM feedback WHERE kind = 'reprioritize'",
        )
        .all() as Array<{ context_snapshot: string }>;
      expect(fb).toHaveLength(1);
      expect(JSON.parse(fb[0]!.context_snapshot)).toEqual({
        from: "low",
        to: "high",
      });
    } finally {
      db.close();
    }
  });

  it("works on approved plans (mid-backlog reorder)", async () => {
    dropPlan(sandbox, "2026-04-27-approved", {
      status: "approved",
      priority: "normal",
    });
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "2026-04-27-approved",
        "--priority",
        "blocking",
      ]),
    ).toBe(0);
    const updated = findPlan(sandbox.dataDir, "2026-04-27-approved");
    expect(updated?.plan.metadata.priority).toBe("blocking");
  });

  it("no-ops when priority is already at the requested level", async () => {
    dropPlan(sandbox, "2026-04-27-noop", {
      status: "awaiting-review",
      priority: "high",
    });
    expect(
      await runReprioritize([
        "--app",
        "jarvis",
        "--plan",
        "2026-04-27-noop",
        "--priority",
        "high",
      ]),
    ).toBe(0);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT * FROM events WHERE kind = 'plan-reprioritize'")
        .all();
      expect(events).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
