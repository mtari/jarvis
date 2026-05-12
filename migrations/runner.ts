import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "better-sqlite3";

export interface Migration {
  up: (db: Database) => void;
  down: (db: Database) => void;
}

export interface MigrationRunResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_FILE_PATTERN = /^(\d{3})-[a-z0-9-]+\.ts$/;

export async function listPendingMigrations(
  db: Database,
  dir: string,
): Promise<string[]> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE_PATTERN.test(f))
    .sort();

  const appliedRows = db
    .prepare("SELECT name FROM _migrations")
    .all() as Array<{ name: string }>;
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  return files
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((name) => !appliedSet.has(name));
}

export async function runMigrations(
  db: Database,
  dir: string,
): Promise<MigrationRunResult> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE_PATTERN.test(f))
    .sort();

  const seenIndices = new Set<string>();
  for (const f of files) {
    const idx = f.slice(0, 3);
    if (seenIndices.has(idx)) {
      throw new Error(`Duplicate migration index ${idx} in ${dir}`);
    }
    seenIndices.add(idx);
  }

  const appliedRows = db
    .prepare("SELECT name FROM _migrations")
    .all() as Array<{ name: string }>;
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const insertApplied = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    const name = file.replace(/\.ts$/, "");
    if (appliedSet.has(name)) {
      alreadyApplied.push(name);
      continue;
    }

    const moduleUrl = pathToFileURL(path.join(dir, file)).href;
    const mod = (await import(moduleUrl)) as Partial<Migration>;
    if (typeof mod.up !== "function" || typeof mod.down !== "function") {
      throw new Error(
        `Migration ${name} must export up() and down() functions`,
      );
    }

    const tx = db.transaction(() => {
      mod.up!(db);
      insertApplied.run(name, new Date().toISOString());
    });

    try {
      tx();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${name} failed: ${cause}`);
    }

    applied.push(name);
  }

  return { applied, alreadyApplied };
}
