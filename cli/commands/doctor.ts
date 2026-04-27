import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { inspectLock, isLockStale } from "../../orchestrator/lock.ts";
import { scanPlans } from "../../orchestrator/plan-store.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runDoctor(_rawArgs: string[]): Promise<number> {
  const dataDir = getDataDir();
  const lines: string[] = [];
  let issues = 0;

  if (!fs.existsSync(dataDir)) {
    console.error(
      `doctor: data directory ${dataDir} does not exist. Run 'yarn jarvis install' first.`,
    );
    return 1;
  }
  lines.push(`Data dir: ${dataDir}`);

  // Daemon
  const pidFile = path.join(dataDir, ".daemon.pid");
  if (!fs.existsSync(pidFile)) {
    lines.push("• Daemon: not running (expected during Phase 0).");
  } else {
    const pidText = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(pidText, 10);
    if (Number.isNaN(pid)) {
      lines.push(`✗ Daemon PID file malformed: ${pidText}`);
      issues += 1;
    } else if (isPidAlive(pid)) {
      lines.push(`✓ Daemon running (pid ${pid}).`);
    } else {
      lines.push(`✗ Daemon PID file present but pid ${pid} is dead.`);
      issues += 1;
    }
  }

  // Stale brain locks
  const vaultsRoot = path.join(dataDir, "vaults");
  const stale: string[] = [];
  if (fs.existsSync(vaultsRoot)) {
    for (const vault of fs.readdirSync(vaultsRoot)) {
      const brainsRoot = path.join(vaultsRoot, vault, "brains");
      if (!fs.existsSync(brainsRoot)) continue;
      for (const app of fs.readdirSync(brainsRoot)) {
        const lockPath = path.join(brainsRoot, app, ".lock");
        const lock = inspectLock(lockPath);
        if (lock && isLockStale(lock)) {
          stale.push(`${vault}/${app}`);
        }
      }
    }
  }
  if (stale.length > 0) {
    lines.push(`✗ Stale brain locks: ${stale.join(", ")}`);
    issues += 1;
  } else {
    lines.push("✓ No stale brain locks.");
  }

  // Plan scan
  const scan = scanPlans(dataDir);
  const pending = scan.records.filter(
    (r) => r.plan.metadata.status === "awaiting-review",
  );
  if (pending.length > 0) {
    lines.push(`• ${pending.length} plan(s) awaiting your review.`);
  } else {
    lines.push("✓ No plans awaiting review.");
  }
  if (scan.unreadable.length > 0) {
    lines.push(`✗ ${scan.unreadable.length} unparseable plan file(s):`);
    for (const u of scan.unreadable) {
      lines.push(`    ${u.id} (${u.vault}/${u.app}): ${u.error}`);
    }
    issues += 1;
  }

  // Vaults
  const dbPath = dbFile(dataDir);
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const vaults = db
        .prepare("SELECT * FROM vault_state ORDER BY vault_id")
        .all() as Array<{
        vault_id: string;
        remote: string | null;
        last_pushed_at: string | null;
      }>;
      if (vaults.length > 0) {
        lines.push("Vaults:");
        for (const v of vaults) {
          const remote = v.remote ?? "(no remote)";
          const lastPushed = v.last_pushed_at ?? "never";
          lines.push(`  ${v.vault_id}: ${remote} (last pushed: ${lastPushed})`);
        }
      }
    } finally {
      db.close();
    }
  }

  console.log(lines.join("\n"));
  return issues > 0 ? 1 : 0;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
