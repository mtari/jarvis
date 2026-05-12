import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { down as migration002Down } from "../../migrations/db/002-scheduled-posts-retry.ts";
import { runMigrate } from "./migrate.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";

describe("runMigrate", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();

    stdoutLines = [];
    stderrLines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    silencer.restore();
    sandbox.cleanup();
  });

  it("--dry-run against up-to-date DB reports no pending and exits 0", async () => {
    const code = await runMigrate(["--dry-run"]);
    expect(code).toBe(0);
    const out = stdoutLines.join("");
    expect(out).toContain("no pending migrations");
  });

  it("--dry-run shows pending migration without applying it", async () => {
    // Remove the 002 row to simulate pending
    const db = new Database(path.join(sandbox.dataDir, "jarvis.db"));
    db.prepare(
      "DELETE FROM _migrations WHERE name='002-scheduled-posts-retry'",
    ).run();
    db.close();

    const code = await runMigrate(["--dry-run"]);
    expect(code).toBe(0);

    const out = stdoutLines.join("");
    expect(out).toContain("002-scheduled-posts-retry");

    // Verify DB row was NOT inserted
    const db2 = new Database(path.join(sandbox.dataDir, "jarvis.db"));
    const row = db2
      .prepare(
        "SELECT name FROM _migrations WHERE name='002-scheduled-posts-retry'",
      )
      .get();
    db2.close();
    expect(row).toBeUndefined();
  });

  it("live apply against fully rolled-back DB applies 002 and exits 0", async () => {
    // Roll back 002 fully: remove row + undo schema
    const db = new Database(path.join(sandbox.dataDir, "jarvis.db"));
    db.prepare(
      "DELETE FROM _migrations WHERE name='002-scheduled-posts-retry'",
    ).run();
    migration002Down(db);
    db.close();

    const code = await runMigrate([]);
    expect(code).toBe(0);

    const out = stdoutLines.join("");
    expect(out).toContain("002-scheduled-posts-retry");

    // Verify _migrations row exists with non-null applied_at
    const db2 = new Database(path.join(sandbox.dataDir, "jarvis.db"));
    const row = db2
      .prepare(
        "SELECT name, applied_at FROM _migrations WHERE name='002-scheduled-posts-retry'",
      )
      .get() as { name: string; applied_at: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.applied_at).not.toBeNull();

    // Verify columns exist on scheduled_posts
    const cols = db2
      .prepare("PRAGMA table_info(scheduled_posts)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("retry_count");
    expect(colNames).toContain("next_retry_at");

    db2.close();
  });

  it("second live apply is idempotent (no pending), exits 0", async () => {
    const code = await runMigrate([]);
    expect(code).toBe(0);
    const out = stdoutLines.join("");
    expect(out).toContain("no pending migrations");
  });

  it("--dir brain skips because migrations/brain/ does not exist, exits 0", async () => {
    const code = await runMigrate(["--dir", "brain"]);
    expect(code).toBe(0);
    const out = stdoutLines.join("");
    expect(out).toContain("skipping");
  });

  it("--dir invalid exits 1 with usage error", async () => {
    const code = await runMigrate(["--dir", "invalid"]);
    expect(code).toBe(1);
    const err = stderrLines.join("");
    expect(err).toContain("invalid");
  });

  it("migration error exits 1 and prints the error", async () => {
    // Replace DB file with a directory so better-sqlite3 can't open it
    const dbPath = path.join(sandbox.dataDir, "jarvis.db");
    fs.rmSync(dbPath);
    fs.mkdirSync(dbPath);

    const code = await runMigrate([]);
    expect(code).toBe(1);
    const err = stderrLines.join("");
    expect(err.length).toBeGreaterThan(0);
  });
});
