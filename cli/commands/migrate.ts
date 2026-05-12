import fs from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  listPendingMigrations,
  runMigrations,
} from "../../migrations/runner.ts";
import {
  dbFile,
  getDataDir,
  migrationsBrainDir,
  migrationsDbDir,
  migrationsProfileDir,
} from "../paths.ts";

const VALID_DIRS = ["db", "brain", "profile", "all"] as const;
type MigrationDir = (typeof VALID_DIRS)[number];

interface Target {
  name: string;
  migrationsDir: string;
  dbPath: string;
}

function buildTargets(dir: MigrationDir, dataDir: string): Target[] {
  const all: Target[] = [
    {
      name: "db",
      migrationsDir: migrationsDbDir(),
      dbPath: dbFile(dataDir),
    },
    {
      name: "brain",
      migrationsDir: migrationsBrainDir(),
      dbPath: dbFile(dataDir),
    },
    {
      name: "profile",
      migrationsDir: migrationsProfileDir(),
      dbPath: dbFile(dataDir),
    },
  ];
  if (dir === "all") return all;
  return all.filter((t) => t.name === dir);
}

export async function runMigrate(rawArgs: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        "dry-run": { type: "boolean", default: false },
        dir: { type: "string", default: "all" },
      },
    });
  } catch (err) {
    process.stderr.write(
      `migrate: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const dryRun = parsed.values["dry-run"] as boolean;
  const dirArg = parsed.values["dir"] as string;

  if (!(VALID_DIRS as readonly string[]).includes(dirArg)) {
    process.stderr.write(
      `migrate: invalid --dir "${dirArg}". Must be one of: db, brain, profile, all\n`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  const targets = buildTargets(dirArg as MigrationDir, dataDir);

  for (const target of targets) {
    if (!fs.existsSync(target.migrationsDir)) {
      process.stdout.write(
        `migrate [${target.name}]: no migrations dir — skipping\n`,
      );
      continue;
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(target.dbPath);
      if (dryRun) {
        const pending = await listPendingMigrations(db, target.migrationsDir);
        if (pending.length === 0) {
          process.stdout.write(
            `migrate [${target.name}]: no pending migrations\n`,
          );
        } else {
          process.stdout.write(
            `migrate [${target.name}]: pending migrations:\n`,
          );
          for (const name of pending) {
            process.stdout.write(`  ${name}\n`);
          }
        }
      } else {
        const result = await runMigrations(db, target.migrationsDir);
        if (result.applied.length === 0) {
          process.stdout.write(
            `migrate [${target.name}]: no pending migrations\n`,
          );
        } else {
          for (const name of result.applied) {
            process.stdout.write(`migrate [${target.name}]: applied ${name}\n`);
          }
        }
      }
    } catch (err) {
      process.stderr.write(
        `migrate [${target.name}]: error — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      db?.close();
      return 1;
    }
    db.close();
  }

  return 0;
}
