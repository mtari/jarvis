import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { findPlan, savePlan } from "../../orchestrator/plan-store.ts";
import { prioritySchema, type Plan } from "../../orchestrator/plan.ts";
import { dbFile, getDataDir } from "../paths.ts";

const REPRIORITIZE_ALLOWED_STATES: ReadonlySet<string> = new Set([
  "awaiting-review",
  "approved",
]);

export async function runReprioritize(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        plan: { type: "string" },
        priority: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`reprioritize: ${(err as Error).message}`);
    return 1;
  }

  const { app: appArg, plan: planArg, priority: priorityArg } = parsed.values;
  if (!appArg || !planArg || !priorityArg) {
    console.error(
      "reprioritize: --app, --plan, and --priority are all required. Usage: yarn jarvis reprioritize --app <name> --plan <id> --priority <level>",
    );
    return 1;
  }

  const priorityResult = prioritySchema.safeParse(priorityArg);
  if (!priorityResult.success) {
    console.error(
      `reprioritize: invalid --priority "${priorityArg}" (must be low, normal, high, or blocking).`,
    );
    return 1;
  }
  const newPriority = priorityResult.data;

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planArg);
  if (!record) {
    console.error(`reprioritize: plan ${planArg} not found.`);
    return 1;
  }
  if (record.app !== appArg) {
    console.error(
      `reprioritize: plan ${planArg} belongs to app "${record.app}", not "${appArg}".`,
    );
    return 1;
  }
  if (!REPRIORITIZE_ALLOWED_STATES.has(record.plan.metadata.status)) {
    console.error(
      `reprioritize: plan ${planArg} is in state "${record.plan.metadata.status}", ` +
        "not awaiting-review or approved. Reprioritize only applies to backlog plans.",
    );
    return 1;
  }

  const previousPriority = record.plan.metadata.priority;
  if (previousPriority === newPriority) {
    console.log(
      `reprioritize: plan ${planArg} is already ${newPriority}; no change.`,
    );
    return 0;
  }

  const updatedPlan: Plan = {
    ...record.plan,
    metadata: { ...record.plan.metadata, priority: newPriority },
  };

  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-reprioritize",
        payload: {
          planId: planArg,
          from: previousPriority,
          to: newPriority,
        },
      });
      recordFeedback(db, {
        kind: "reprioritize",
        actor: "user",
        targetType: "plan",
        targetId: planArg,
        contextSnapshot: { from: previousPriority, to: newPriority },
      });
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, updatedPlan);
  console.log(
    `✓ Plan ${planArg} priority: ${previousPriority} → ${newPriority}.`,
  );
  return 0;
}
