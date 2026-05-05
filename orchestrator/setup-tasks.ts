import fs from "node:fs";
import Database from "better-sqlite3";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { appendEvent } from "./event-log.ts";
import { setupQueueFile } from "../cli/paths.ts";

/**
 * Setup tasks are short, actionable items that block or accompany
 * normal plan flow but aren't themselves plans — "create the GitHub
 * webhook", "set the Stripe restricted key in `.env`", "decide which
 * Slack workspace to install the bot in". Other agents (Strategist on
 * onboarding, Developer mid-amendment) drop tasks into the queue;
 * the user resolves them via CLI or Slack.
 *
 * Storage shape: one JSON object per line in
 * `<dataDir>/setup-queue.jsonl`. Pending tasks are present; resolved
 * tasks are removed from the file (atomic rewrite) AND get a
 * `setup-task-resolved` event written to the event log so the audit
 * trail survives.
 *
 * Slice 4 ships the read/append/resolve primitives + the Slack
 * surface. Producers of setup tasks (onboarding, amendments, etc.)
 * land in subsequent PRs as those flows demand.
 */

export interface SetupTaskSource {
  /** Free-form provenance tag — e.g. "onboard", "amendment", "manual". */
  kind: string;
  /** Optional pointer to the originating object (plan id, app name, …). */
  refId?: string;
}

export interface SetupTask {
  /** Stable id; the resolution log keys on this. */
  id: string;
  /** One-line summary shown in inbox / Slack. */
  title: string;
  /** Optional multi-line detail rendered in the Slack section block. */
  detail?: string;
  createdAt: string;
  source?: SetupTaskSource;
}

export type SetupTaskResolutionStatus = "done" | "skipped";

export interface ResolveSetupTaskInput {
  status: SetupTaskResolutionStatus;
  actor: string;
  skipReason?: string;
}

export interface ResolveResult {
  ok: boolean;
  /** Set when ok=false; e.g. "task not found". */
  message?: string;
  /** The resolved task, when found. */
  task?: SetupTask;
}

export function listPendingSetupTasks(dataDir: string): SetupTask[] {
  const filePath = setupQueueFile(dataDir);
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: SetupTask[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const task = JSON.parse(trimmed) as SetupTask;
      if (typeof task.id === "string" && typeof task.title === "string") {
        out.push(task);
      }
    } catch {
      // Skip malformed lines silently — corrupt entries shouldn't take
      // down the rest of the queue.
    }
  }
  return out;
}

/**
 * Appends a new task to the queue file. No SQLite event is recorded
 * here — producers can do that in the same transaction as their own
 * domain event if they need a paired audit trail.
 */
export function appendSetupTask(dataDir: string, task: SetupTask): void {
  const filePath = setupQueueFile(dataDir);
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
  const trimmed = existing.replace(/\s+$/, "");
  const next = trimmed.length > 0 ? `${trimmed}\n${JSON.stringify(task)}\n` : `${JSON.stringify(task)}\n`;
  atomicWriteFileSync(filePath, next);
}

/**
 * Removes the task from the queue file and records a
 * `setup-task-resolved` event. Returns `{ok: false, ...}` when the
 * task id is not present (already resolved, or never existed).
 *
 * Atomic at the file-write level: the queue is rewritten via
 * `atomicWriteFileSync`. The event-log write happens after the file
 * write, so an SQLite failure leaves the queue updated and the user
 * sees the task as resolved either way (the next read won't find it).
 */
export function resolveSetupTask(
  dataDir: string,
  dbFilePath: string,
  taskId: string,
  input: ResolveSetupTaskInput,
): ResolveResult {
  const tasks = listPendingSetupTasks(dataDir);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { ok: false, message: `setup task "${taskId}" not found in queue.` };
  }
  const task = tasks[idx]!;
  const remaining = tasks.filter((t) => t.id !== taskId);
  const filePath = setupQueueFile(dataDir);
  const body = remaining.map((t) => JSON.stringify(t)).join("\n");
  atomicWriteFileSync(filePath, body.length > 0 ? `${body}\n` : "");

  const db = new Database(dbFilePath);
  try {
    appendEvent(db, {
      // Setup tasks are portfolio-level by default; producers can
      // attach app-scope via `source.refId` but the resolution event
      // itself goes against the meta-app channel.
      appId: "jarvis",
      vaultId: "personal",
      kind: "setup-task-resolved",
      payload: {
        taskId,
        title: task.title,
        status: input.status,
        actor: input.actor,
        ...(input.skipReason !== undefined && { skipReason: input.skipReason }),
        ...(task.source !== undefined && { source: task.source }),
      },
    });
  } finally {
    db.close();
  }
  return { ok: true, task };
}
