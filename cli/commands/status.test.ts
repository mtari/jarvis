import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { daemonPidFile, dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runStatus } from "./status.ts";

function writePidFile(pidPath: string, pid: number): void {
  fs.writeFileSync(
    pidPath,
    JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

function seedAgentCall(
  dbPath: string,
  agent: string,
  createdAt?: string,
): void {
  const db = new Database(dbPath);
  try {
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "agent-call",
      payload: {
        agent,
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
      },
      ...(createdAt !== undefined && { createdAt }),
    });
  } finally {
    db.close();
  }
}

describe("runStatus", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logs: string[];

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logs = [];
    console.log = (msg?: unknown): void => {
      logs.push(typeof msg === "string" ? msg : String(msg));
    };
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("shows stopped and none when no pidfile and no DB events", async () => {
    const code = await runStatus([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("daemon: stopped");
    expect(out).toContain("plans: none");
    expect(out).toContain("last agent call: none");
  });

  it("shows running with pid and uptime when daemon is alive", async () => {
    writePidFile(daemonPidFile(sandbox.dataDir), process.pid);
    const code = await runStatus([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/daemon: running \(pid \d+, up \d/);
  });

  it("shows stopped when pidfile has a dead pid", async () => {
    // 2^30 is far beyond max PID on any OS
    writePidFile(daemonPidFile(sandbox.dataDir), 1073741824);
    const code = await runStatus([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("daemon: stopped");
  });

  it("shows plan counts grouped by status", async () => {
    dropPlan(sandbox, "2026-04-30-plan-a", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-30-plan-b", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-30-plan-c", { status: "approved" });
    const code = await runStatus([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("2 awaiting-review");
    expect(out).toContain("1 approved");
  });

  it("shows last agent call with timestamp and agent name", async () => {
    const ts = "2026-04-30T14:02:00.000Z";
    seedAgentCall(dbFile(sandbox.dataDir), "analyst", ts);
    const code = await runStatus([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(`last agent call: ${ts} (analyst)`);
  });

  it("exits 0 when DB is missing", async () => {
    fs.rmSync(dbFile(sandbox.dataDir));
    const code = await runStatus([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("last agent call: none");
  });
});
