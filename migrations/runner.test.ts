import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.ts";

interface TempDirHandle {
  dir: string;
  cleanup: () => void;
}

function makeTempDir(): TempDirHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-migrations-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMigration(dir: string, file: string, body: string): void {
  fs.writeFileSync(path.join(dir, file), body, "utf8");
}

const SIMPLE_TABLE_MIGRATION = `
import type { Database } from "better-sqlite3";
export function up(db: Database) {
  db.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY)");
}
export function down(db: Database) {
  db.exec("DROP TABLE foo");
}
`;

const SECOND_TABLE_MIGRATION = `
import type { Database } from "better-sqlite3";
export function up(db: Database) {
  db.exec("CREATE TABLE bar (id INTEGER PRIMARY KEY)");
}
export function down(db: Database) {
  db.exec("DROP TABLE bar");
}
`;

const FAILING_MIGRATION = `
import type { Database } from "better-sqlite3";
export function up(db: Database) {
  db.exec("CREATE TABLE good (id INTEGER PRIMARY KEY)");
  throw new Error("boom");
}
export function down(_db: Database) {}
`;

describe("runMigrations", () => {
  let tmp: TempDirHandle;
  let db: Database.Database;

  beforeEach(() => {
    tmp = makeTempDir();
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("applies pending migrations in numeric order", async () => {
    writeMigration(tmp.dir, "002-bar.ts", SECOND_TABLE_MIGRATION);
    writeMigration(tmp.dir, "001-foo.ts", SIMPLE_TABLE_MIGRATION);

    const result = await runMigrations(db, tmp.dir);

    expect(result.applied).toEqual(["001-foo", "002-bar"]);
    expect(result.alreadyApplied).toEqual([]);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('foo','bar') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toEqual(["bar", "foo"]);
  });

  it("skips already-applied migrations on second run", async () => {
    writeMigration(tmp.dir, "001-foo.ts", SIMPLE_TABLE_MIGRATION);

    await runMigrations(db, tmp.dir);
    const second = await runMigrations(db, tmp.dir);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(["001-foo"]);
  });

  it("rolls back the failing migration's transaction", async () => {
    writeMigration(tmp.dir, "001-fails.ts", FAILING_MIGRATION);

    await expect(runMigrations(db, tmp.dir)).rejects.toThrow(/boom/);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='good'",
      )
      .all();
    expect(tables).toEqual([]);
    const tracked = db
      .prepare("SELECT name FROM _migrations WHERE name='001-fails'")
      .all();
    expect(tracked).toEqual([]);
  });

  it("rejects duplicate migration indices", async () => {
    writeMigration(tmp.dir, "001-foo.ts", SIMPLE_TABLE_MIGRATION);
    writeMigration(tmp.dir, "001-bar.ts", SECOND_TABLE_MIGRATION);

    await expect(runMigrations(db, tmp.dir)).rejects.toThrow(
      /Duplicate migration index 001/,
    );
  });

  it("ignores files that don't match NNN-name.ts", async () => {
    writeMigration(tmp.dir, "README.md", "# notes");
    writeMigration(tmp.dir, "1-bad.ts", SIMPLE_TABLE_MIGRATION);
    writeMigration(tmp.dir, "001-foo.ts", SIMPLE_TABLE_MIGRATION);

    const result = await runMigrations(db, tmp.dir);

    expect(result.applied).toEqual(["001-foo"]);
  });
});

describe("initial DB schema", () => {
  it("creates all expected tables", async () => {
    const db = new Database(":memory:");
    try {
      const dir = path.join(import.meta.dirname, "db");
      const result = await runMigrations(db, dir);
      expect(result.applied).toContain("001-initial-schema");

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = tables.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "_migrations",
          "agent_state",
          "events",
          "feedback",
          "scheduled_posts",
          "suppressions",
          "vault_state",
        ]),
      );
    } finally {
      db.close();
    }
  });
});
