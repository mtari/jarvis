import fs from "node:fs";
import Database from "better-sqlite3";
import { listPlans } from "../../orchestrator/plan-store.ts";
import { dbFile, getDataDir, setupQueueFile } from "../paths.ts";

export interface RunInboxDeps {
  /** Override the data dir (test seam). */
  dataDir?: string;
}

export async function runInbox(
  _rawArgs: string[],
  deps: RunInboxDeps = {},
): Promise<number> {
  const dataDir = deps.dataDir ?? getDataDir();
  const plans = listPlans(dataDir);
  const pending = plans.filter(
    (p) => p.plan.metadata.status === "awaiting-review",
  );
  const amendmentPlanIds = readPendingAmendmentPlanIds(dbFile(dataDir));

  let setupCount = 0;
  const setupPath = setupQueueFile(dataDir);
  if (fs.existsSync(setupPath)) {
    setupCount = fs
      .readFileSync(setupPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
  }

  const amendments = pending.filter((p) => amendmentPlanIds.has(p.id));
  const reviews = pending.filter((p) => !amendmentPlanIds.has(p.id));

  if (
    reviews.length === 0 &&
    amendments.length === 0 &&
    setupCount === 0
  ) {
    console.log("Inbox is empty.");
    return 0;
  }

  const lines: string[] = [];
  if (amendments.length > 0) {
    lines.push(`Pending amendment reviews (${amendments.length}):`);
    for (const p of amendments) {
      const subtype = p.plan.metadata.subtype
        ? `/${p.plan.metadata.subtype}`
        : "";
      lines.push(
        `  ${p.id}  [${p.plan.metadata.type}${subtype}]  [AMEND]  [${p.plan.metadata.priority}]  ${p.plan.metadata.title}`,
      );
    }
  }

  if (reviews.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Pending plan reviews (${reviews.length}):`);
    for (const p of reviews) {
      const subtype = p.plan.metadata.subtype
        ? `/${p.plan.metadata.subtype}`
        : "";
      lines.push(
        `  ${p.id}  [${p.plan.metadata.type}${subtype}]  [${p.plan.metadata.priority}]  ${p.plan.metadata.title}`,
      );
    }
  }

  if (setupCount > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Pending setup tasks (${setupCount}):`);
    lines.push(`  See ${setupPath}`);
  }

  console.log(lines.join("\n"));
  return 0;
}

/**
 * Plan ids with an `amendment-proposed` event that hasn't yet been
 * superseded by an `amendment-applied` event (slice 3 will record the
 * latter when the resume completes). Used to tag inbox entries so the
 * user can distinguish "first review" from "amendment review".
 */
export function readPendingAmendmentPlanIds(dbFilePath: string): Set<string> {
  if (!fs.existsSync(dbFilePath)) return new Set();
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const proposed = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'amendment-proposed'",
      )
      .all() as Array<{ payload: string }>;
    const applied = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'amendment-applied'",
      )
      .all() as Array<{ payload: string }>;

    const proposedIds = new Set<string>();
    for (const r of proposed) {
      try {
        const p = JSON.parse(r.payload) as { planId?: string };
        if (typeof p.planId === "string") proposedIds.add(p.planId);
      } catch {
        // skip malformed
      }
    }
    for (const r of applied) {
      try {
        const p = JSON.parse(r.payload) as { planId?: string };
        if (typeof p.planId === "string") proposedIds.delete(p.planId);
      } catch {
        // skip malformed
      }
    }
    return proposedIds;
  } finally {
    db.close();
  }
}
