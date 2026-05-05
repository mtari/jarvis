import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { dbFile, setupQueueFile } from "../cli/paths.ts";
import {
  appendSetupTask,
  listPendingSetupTasks,
  resolveSetupTask,
  type SetupTask,
} from "./setup-tasks.ts";

const SAMPLE: SetupTask = {
  id: "task-1",
  title: "Set the Stripe restricted key",
  detail: "Add `STRIPE_RESTRICTED_KEY` to `.env`. See onboarding doc.",
  createdAt: "2026-05-05T10:00:00Z",
  source: { kind: "onboard", refId: "erdei-fahazak" },
};

describe("listPendingSetupTasks", () => {
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

  it("returns an empty list when the file is empty (install default)", () => {
    expect(listPendingSetupTasks(sandbox.dataDir)).toEqual([]);
  });

  it("returns parsed tasks in file order", () => {
    fs.writeFileSync(
      setupQueueFile(sandbox.dataDir),
      [
        JSON.stringify({
          id: "a",
          title: "first",
          createdAt: "2026-05-05T09:00:00Z",
        }),
        JSON.stringify({
          id: "b",
          title: "second",
          createdAt: "2026-05-05T10:00:00Z",
        }),
      ].join("\n"),
    );
    const tasks = listPendingSetupTasks(sandbox.dataDir);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("skips malformed lines silently", () => {
    fs.writeFileSync(
      setupQueueFile(sandbox.dataDir),
      [
        JSON.stringify({ id: "a", title: "ok", createdAt: "2026-05-05T00:00:00Z" }),
        "not-json",
        JSON.stringify({ noId: true }),
        JSON.stringify({ id: "b", title: "ok", createdAt: "2026-05-05T00:00:00Z" }),
      ].join("\n"),
    );
    const tasks = listPendingSetupTasks(sandbox.dataDir);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("returns empty when the file doesn't exist", () => {
    fs.rmSync(setupQueueFile(sandbox.dataDir));
    expect(listPendingSetupTasks(sandbox.dataDir)).toEqual([]);
  });
});

describe("appendSetupTask", () => {
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

  it("writes the first task to an empty queue", () => {
    appendSetupTask(sandbox.dataDir, SAMPLE);
    const tasks = listPendingSetupTasks(sandbox.dataDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual(SAMPLE);
  });

  it("appends without clobbering existing tasks", () => {
    appendSetupTask(sandbox.dataDir, { ...SAMPLE, id: "first" });
    appendSetupTask(sandbox.dataDir, { ...SAMPLE, id: "second" });
    const tasks = listPendingSetupTasks(sandbox.dataDir);
    expect(tasks.map((t) => t.id)).toEqual(["first", "second"]);
  });
});

describe("resolveSetupTask", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    appendSetupTask(sandbox.dataDir, SAMPLE);
    appendSetupTask(sandbox.dataDir, { ...SAMPLE, id: "task-2", title: "Other" });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function readResolutionEvents(): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT payload FROM events WHERE kind = 'setup-task-resolved'")
        .all() as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      conn.close();
    }
  }

  it("removes the task from the queue and records a setup-task-resolved event (done)", () => {
    const result = resolveSetupTask(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      "task-1",
      { status: "done", actor: "cli" },
    );
    expect(result.ok).toBe(true);
    expect(result.task?.title).toBe(SAMPLE.title);

    const remaining = listPendingSetupTasks(sandbox.dataDir).map((t) => t.id);
    expect(remaining).toEqual(["task-2"]);

    const events = readResolutionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "task-1",
      status: "done",
      actor: "cli",
      title: SAMPLE.title,
      source: { kind: "onboard", refId: "erdei-fahazak" },
    });
  });

  it("records skipReason when status=skipped", () => {
    resolveSetupTask(sandbox.dataDir, dbFile(sandbox.dataDir), "task-2", {
      status: "skipped",
      actor: "slack:U1",
      skipReason: "decided to use stripe-checkout instead",
    });
    const events = readResolutionEvents();
    expect(events[0]).toMatchObject({
      taskId: "task-2",
      status: "skipped",
      actor: "slack:U1",
      skipReason: "decided to use stripe-checkout instead",
    });
  });

  it("returns ok=false with a clear message when the task id isn't pending", () => {
    const result = resolveSetupTask(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      "no-such-task",
      { status: "done", actor: "cli" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
    // No mutation
    expect(listPendingSetupTasks(sandbox.dataDir)).toHaveLength(2);
    expect(readResolutionEvents()).toHaveLength(0);
  });

  it("leaves the queue empty + parseable after resolving the last task", () => {
    resolveSetupTask(sandbox.dataDir, dbFile(sandbox.dataDir), "task-1", {
      status: "done",
      actor: "cli",
    });
    resolveSetupTask(sandbox.dataDir, dbFile(sandbox.dataDir), "task-2", {
      status: "done",
      actor: "cli",
    });
    expect(listPendingSetupTasks(sandbox.dataDir)).toEqual([]);
    // File should still exist + be readable
    expect(fs.existsSync(setupQueueFile(sandbox.dataDir))).toBe(true);
  });
});
