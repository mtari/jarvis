// Pure plan-lifecycle operations shared by the CLI commands and the Slack
// action handlers. Each function returns a structured result; callers handle
// I/O (stdout, Slack post, etc.).

import fs from "node:fs";
import Database from "better-sqlite3";
import {
  applyBrainUpdates,
  type ApplyBrainUpdatesResult,
} from "./brain-update-applier.ts";
import { appendEvent } from "./event-log.ts";
import { recordFeedback } from "./feedback-store.ts";
import {
  findPlan,
  savePlan,
  type PlanRecord,
} from "./plan-store.ts";
import { transitionPlan, type Plan } from "./plan.ts";

export type LifecycleErrorReason =
  | "not-found"
  | "wrong-state"
  | "destructive-not-confirmed";

export interface LifecycleError {
  ok: false;
  reason: LifecycleErrorReason;
  message: string;
  /** Plan record when found; included so callers can show context. */
  record?: PlanRecord;
}

export interface ApproveResult {
  ok: true;
  record: PlanRecord;
  next: Plan;
  parentTransitioned?: { id: string; from: string; to: "executing" };
  /**
   * Set when the approved plan was an improvement/meta plan that
   * carried a parseable `## Brain changes (proposed)` section. The
   * applier mutates `brain.json` in place; the result reports each
   * applied / skipped / errored change so the CLI / Slack surface
   * can render it for the operator.
   */
  brainChangesApplied?: ApplyBrainUpdatesResult;
}

export interface ApproveOptions {
  actor?: string;
  confirmDestructive?: boolean;
}

export function approvePlan(
  dataDir: string,
  dbFilePath: string,
  planId: string,
  opts: ApproveOptions = {},
): ApproveResult | LifecycleError {
  const record = findPlan(dataDir, planId);
  if (!record) {
    return {
      ok: false,
      reason: "not-found",
      message: `plan ${planId} not found.`,
    };
  }
  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    return {
      ok: false,
      reason: "wrong-state",
      message: `plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
      record,
    };
  }
  if (record.plan.metadata.destructive && !opts.confirmDestructive) {
    return {
      ok: false,
      reason: "destructive-not-confirmed",
      message: `plan ${planId} is marked Destructive: true.`,
      record,
    };
  }

  const next = transitionPlan(record.plan, "approved");

  // §4: when an implementation plan is approved, the parent improvement
  // plan transitions approved → executing.
  let parentChain:
    | { record: PlanRecord; next: Plan; transition: { id: string; from: string; to: "executing" } }
    | null = null;
  if (
    record.plan.metadata.type === "implementation" &&
    record.plan.metadata.parentPlan
  ) {
    const parent = findPlan(dataDir, record.plan.metadata.parentPlan);
    if (parent && parent.plan.metadata.status === "approved") {
      parentChain = {
        record: parent,
        next: transitionPlan(parent.plan, "executing"),
        transition: {
          id: parent.id,
          from: "approved",
          to: "executing",
        },
      };
    }
  }

  const actor = opts.actor ?? "user";
  const db = new Database(dbFilePath);
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: { planId, from: fromStatus, to: "approved", actor },
      });
      recordFeedback(db, {
        kind: "approve",
        actor,
        targetType: "plan",
        targetId: planId,
      });
      if (parentChain) {
        appendEvent(db, {
          appId: parentChain.record.app,
          vaultId: parentChain.record.vault,
          kind: "plan-transition",
          payload: {
            planId: parentChain.record.id,
            from: "approved",
            to: "executing",
            actor: "system",
            reason: `child impl plan ${planId} approved`,
          },
        });
      }
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, next);
  if (parentChain) savePlan(parentChain.record.path, parentChain.next);

  const result: ApproveResult = { ok: true, record, next };
  if (parentChain) result.parentTransitioned = parentChain.transition;

  // Auto-apply brain updates for meta plans. Best-effort: the
  // approval has already landed; an applier failure is reported in
  // `brainChangesApplied.errors` rather than rolling back the
  // approve.
  if (
    next.metadata.type === "improvement" &&
    next.metadata.subtype === "meta"
  ) {
    try {
      const planMarkdown = fs.readFileSync(record.path, "utf8");
      const applyResult = applyBrainUpdates({
        dataDir,
        vault: record.vault,
        app: record.app,
        planMarkdown,
      });
      if (applyResult.hasChanges) {
        result.brainChangesApplied = applyResult;
        const writeDb = new Database(dbFilePath);
        try {
          appendEvent(writeDb, {
            appId: record.app,
            vaultId: record.vault,
            kind: "brain-updated",
            payload: {
              planId,
              applied: applyResult.applied.map((a) => ({
                path: a.path,
                op: a.op,
              })),
              skipped: applyResult.skipped.map((s) => ({
                path: s.path,
                op: s.op,
                reason: s.reason,
              })),
              errors: applyResult.errors.map((e) => ({
                path: e.path,
                op: e.op,
                reason: e.reason,
              })),
              actor,
            },
          });
        } finally {
          writeDb.close();
        }
      }
    } catch (err) {
      result.brainChangesApplied = {
        hasChanges: true,
        applied: [],
        skipped: [],
        errors: [
          {
            path: "*",
            op: "refine",
            reason: `applier crashed: ${err instanceof Error ? err.message : String(err)}`,
            rawValueText: "",
          },
        ],
      };
    }
  }

  return result;
}

export interface ReviseResult {
  ok: true;
  record: PlanRecord;
  next: Plan;
  /** Number of revise feedback rows already on the plan BEFORE this one. */
  priorRevisions: number;
}

export interface ReviseOptions {
  actor?: string;
}

export function revisePlan(
  dataDir: string,
  dbFilePath: string,
  planId: string,
  note: string,
  opts: ReviseOptions = {},
): ReviseResult | LifecycleError {
  const record = findPlan(dataDir, planId);
  if (!record) {
    return {
      ok: false,
      reason: "not-found",
      message: `plan ${planId} not found.`,
    };
  }
  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    return {
      ok: false,
      reason: "wrong-state",
      message: `plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
      record,
    };
  }

  let priorRevisions = 0;
  {
    const readDb = new Database(dbFilePath, { readonly: true });
    try {
      const row = readDb
        .prepare(
          "SELECT COUNT(*) AS c FROM feedback WHERE kind = 'revise' AND target_id = ?",
        )
        .get(planId) as { c: number };
      priorRevisions = row.c;
    } finally {
      readDb.close();
    }
  }

  const next = transitionPlan(record.plan, "draft");
  const actor = opts.actor ?? "user";

  const db = new Database(dbFilePath);
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: { planId, from: fromStatus, to: "draft", note, actor },
      });
      recordFeedback(db, {
        kind: "revise",
        actor,
        targetType: "plan",
        targetId: planId,
        note,
      });
    })();
  } finally {
    db.close();
  }
  savePlan(record.path, next);

  return { ok: true, record, next, priorRevisions };
}

export interface RejectResult {
  ok: true;
  record: PlanRecord;
  next: Plan;
}

export interface RejectOptions {
  actor?: string;
  category?: string;
  note?: string;
}

export function rejectPlan(
  dataDir: string,
  dbFilePath: string,
  planId: string,
  opts: RejectOptions = {},
): RejectResult | LifecycleError {
  const record = findPlan(dataDir, planId);
  if (!record) {
    return {
      ok: false,
      reason: "not-found",
      message: `plan ${planId} not found.`,
    };
  }
  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    return {
      ok: false,
      reason: "wrong-state",
      message: `plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
      record,
    };
  }

  const next = transitionPlan(record.plan, "rejected");
  const actor = opts.actor ?? "user";

  const db = new Database(dbFilePath);
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
          actor,
          ...(opts.category !== undefined && { category: opts.category }),
          ...(opts.note !== undefined && { note: opts.note }),
        },
      });
      recordFeedback(db, {
        kind: "reject",
        actor,
        targetType: "plan",
        targetId: planId,
        ...(opts.note !== undefined && { note: opts.note }),
        ...(opts.category !== undefined && {
          contextSnapshot: { category: opts.category },
        }),
      });
    })();
  } finally {
    db.close();
  }
  savePlan(record.path, next);
  return { ok: true, record, next };
}
