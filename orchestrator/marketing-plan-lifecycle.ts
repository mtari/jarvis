import Database from "better-sqlite3";
import { appendEvent } from "./event-log.ts";
import {
  findPlan,
  savePlan,
  type PlanRecord,
} from "./plan-store.ts";
import {
  transitionPlan,
  type Plan,
  type PlanStatus,
} from "./plan.ts";
import { countScheduledPosts } from "./scheduled-posts.ts";

/**
 * Reconciles a marketing plan's status to its scheduled_posts state.
 * Idempotent — safe to call from any place that touches a row's
 * status. Walks two transitions when applicable:
 *
 *   1. `approved → executing`:
 *      Plan has been prepared (rows exist in scheduled_posts).
 *
 *   2. `executing → done`:
 *      All rows for the plan are in terminal state (published /
 *      failed / skipped). No `pending` or `awaiting-review` left.
 *
 * Plans without rows yet (count = 0) stay where they are. Empty
 * plans never auto-transition; user can `cancel` if needed.
 *
 * Non-marketing plans return immediately. Plans not in `approved`
 * or `executing` are left alone — terminal states (done / cancelled
 * / rejected) don't get pulled back, and earlier states (draft,
 * awaiting-review) are someone else's responsibility.
 */

export interface ReconcileResult {
  /** Sequence of transitions made this call. Empty when no-op. */
  transitioned: Array<{ from: PlanStatus; to: PlanStatus }>;
  /** True when no plan with this id exists. */
  planNotFound: boolean;
}

export interface ReconcileMarketingPlanInput {
  dataDir: string;
  dbFilePath: string;
  planId: string;
  /** Free-form actor tag; written into each plan-transition event payload. */
  actor: string;
}

export function reconcileMarketingPlanState(
  input: ReconcileMarketingPlanInput,
): ReconcileResult {
  const record = findPlan(input.dataDir, input.planId);
  if (!record) {
    return { transitioned: [], planNotFound: true };
  }
  if (record.plan.metadata.type !== "marketing") {
    return { transitioned: [], planNotFound: false };
  }
  const status = record.plan.metadata.status;
  if (status !== "approved" && status !== "executing") {
    return { transitioned: [], planNotFound: false };
  }

  const counts = readRowCounts(input.dbFilePath, input.planId);
  if (counts.total === 0) {
    return { transitioned: [], planNotFound: false };
  }

  const transitioned: Array<{ from: PlanStatus; to: PlanStatus }> = [];
  let current: Plan = record.plan;

  if (current.metadata.status === "approved") {
    current = transitionPlan(current, "executing");
    transitioned.push({ from: "approved", to: "executing" });
  }

  if (current.metadata.status === "executing" && counts.open === 0) {
    current = transitionPlan(current, "done");
    transitioned.push({ from: "executing", to: "done" });
  }

  if (transitioned.length === 0) {
    return { transitioned: [], planNotFound: false };
  }

  savePlan(record.path, current);
  writeTransitionEvents(input, record, transitioned);
  return { transitioned, planNotFound: false };
}

interface RowCounts {
  total: number;
  /** Rows still in `pending` or `awaiting-review`. Terminal once 0. */
  open: number;
}

function readRowCounts(dbFilePath: string, planId: string): RowCounts {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const total = countScheduledPosts(db, { planId });
    const pending = countScheduledPosts(db, { planId, status: "pending" });
    const awaiting = countScheduledPosts(db, {
      planId,
      status: "awaiting-review",
    });
    return { total, open: pending + awaiting };
  } finally {
    db.close();
  }
}

function writeTransitionEvents(
  input: ReconcileMarketingPlanInput,
  record: PlanRecord,
  transitions: ReadonlyArray<{ from: PlanStatus; to: PlanStatus }>,
): void {
  const db = new Database(input.dbFilePath);
  try {
    db.transaction(() => {
      for (const t of transitions) {
        appendEvent(db, {
          appId: record.app,
          vaultId: record.vault,
          kind: "plan-transition",
          payload: {
            planId: input.planId,
            from: t.from,
            to: t.to,
            actor: input.actor,
            reason: "marketing-rows-state",
          },
        });
      }
    })();
  } finally {
    db.close();
  }
}
