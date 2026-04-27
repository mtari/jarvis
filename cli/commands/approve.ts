import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { findPlan, savePlan } from "../../orchestrator/plan-store.ts";
import { transitionPlan } from "../../orchestrator/plan.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runApprove(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        "confirm-destructive": { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`approve: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      "approve: plan id required. Usage: yarn jarvis approve <id>",
    );
    return 1;
  }

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planId);
  if (!record) {
    console.error(`approve: plan ${planId} not found.`);
    return 1;
  }

  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    console.error(
      `approve: plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
    );
    return 1;
  }

  if (
    record.plan.metadata.destructive &&
    !parsed.values["confirm-destructive"]
  ) {
    console.error(
      `approve: plan ${planId} is marked Destructive: true. Re-run with --confirm-destructive.`,
    );
    return 1;
  }

  const next = transitionPlan(record.plan, "approved");

  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: { planId, from: fromStatus, to: "approved" },
      });
      recordFeedback(db, {
        kind: "approve",
        actor: "user",
        targetType: "plan",
        targetId: planId,
      });
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, next);
  console.log(`✓ Approved plan ${planId}.`);
  return 0;
}
