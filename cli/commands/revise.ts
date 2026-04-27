import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { findPlan, savePlan } from "../../orchestrator/plan-store.ts";
import { transitionPlan } from "../../orchestrator/plan.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runRevise(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        note: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`revise: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      'revise: plan id and feedback required. Usage: yarn jarvis revise <id> "<feedback>"',
    );
    return 1;
  }

  let note = parsed.values.note;
  if (note === undefined && parsed.positionals.length > 1) {
    note = parsed.positionals.slice(1).join(" ");
  }
  if (!note) {
    console.error(
      'revise: feedback required. Usage: yarn jarvis revise <id> "<feedback>" (or --note "<feedback>")',
    );
    return 1;
  }

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planId);
  if (!record) {
    console.error(`revise: plan ${planId} not found.`);
    return 1;
  }

  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    console.error(
      `revise: plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
    );
    return 1;
  }

  const next = transitionPlan(record.plan, "draft");

  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: { planId, from: fromStatus, to: "draft", note },
      });
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: planId,
        note,
      });
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, next);
  console.log(`✓ Plan ${planId} sent back to draft with feedback.`);
  return 0;
}
