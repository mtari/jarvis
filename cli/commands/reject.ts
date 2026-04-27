import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { findPlan, savePlan } from "../../orchestrator/plan-store.ts";
import { transitionPlan } from "../../orchestrator/plan.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runReject(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        category: { type: "string" },
        note: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`reject: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      'reject: plan id required. Usage: yarn jarvis reject <id> [--category <cat>] [--note "..."]',
    );
    return 1;
  }

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planId);
  if (!record) {
    console.error(`reject: plan ${planId} not found.`);
    return 1;
  }

  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    console.error(
      `reject: plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
    );
    return 1;
  }

  const next = transitionPlan(record.plan, "rejected");

  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: {
          planId,
          from: fromStatus,
          to: "rejected",
          category: parsed.values.category,
          note: parsed.values.note,
        },
      });
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: planId,
        ...(parsed.values.note !== undefined && { note: parsed.values.note }),
        ...(parsed.values.category !== undefined && {
          contextSnapshot: { category: parsed.values.category },
        }),
      });
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, next);
  console.log(`✓ Rejected plan ${planId}.`);
  return 0;
}
