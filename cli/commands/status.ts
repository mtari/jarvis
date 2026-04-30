import fs from "node:fs";
import Database from "better-sqlite3";
import {
  defaultIsPidAlive,
  readPidFile,
} from "../../orchestrator/daemon-pid.ts";
import { scanPlans } from "../../orchestrator/plan-store.ts";
import { daemonPidFile, dbFile, getDataDir } from "../paths.ts";

interface LastCallRow {
  created_at: string;
  payload: string;
}

const STATUS_ORDER = [
  "awaiting-review",
  "approved",
  "executing",
  "done",
  "rejected",
  "draft",
];

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

export async function runStatus(_rawArgs: string[]): Promise<number> {
  const dataDir = getDataDir();
  const lines: string[] = [];

  // Daemon
  const pidPath = daemonPidFile(dataDir);
  if (!fs.existsSync(pidPath)) {
    lines.push("daemon: stopped");
  } else {
    const pidData = readPidFile(pidPath);
    if (!pidData || !defaultIsPidAlive(pidData.pid)) {
      lines.push("daemon: stopped");
    } else {
      lines.push(
        `daemon: running (pid ${pidData.pid}, up ${formatUptime(pidData.startedAt)})`,
      );
    }
  }

  // Plans
  const scan = scanPlans(dataDir);
  const counts = new Map<string, number>();
  for (const r of scan.records) {
    const s = r.plan.metadata.status;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const s of STATUS_ORDER) {
    const n = counts.get(s);
    if (n && n > 0) parts.push(`${n} ${s}`);
  }
  for (const [s, n] of counts) {
    if (!STATUS_ORDER.includes(s) && n > 0) parts.push(`${n} ${s}`);
  }
  lines.push(`plans: ${parts.length > 0 ? parts.join(", ") : "none"}`);

  // Last agent call
  const dbPath = dbFile(dataDir);
  let lastCall = "none";
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          "SELECT created_at, payload FROM events WHERE kind = 'agent-call' ORDER BY id DESC LIMIT 1",
        )
        .get() as LastCallRow | undefined;
      if (row) {
        try {
          const payload = JSON.parse(row.payload) as { agent?: string };
          const agent = payload.agent ?? "unknown";
          lastCall = `${row.created_at} (${agent})`;
        } catch {
          lastCall = row.created_at;
        }
      }
    } finally {
      db.close();
    }
  }
  lines.push(`last agent call: ${lastCall}`);

  console.log(lines.join("\n"));
  return 0;
}
