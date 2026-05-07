import Database from "better-sqlite3";
import { appendEvent } from "../orchestrator/event-log.ts";
import { dbFile } from "../cli/paths.ts";

/**
 * Self-telemetry — system-quality metrics over a configurable window.
 * Computed purely from the SQLite event log + feedback table; no
 * agent calls. Output is structured so the learning-loop drafter
 * (PR #75) can reference these metrics in its proposals.
 *
 * Metrics surfaced (Phase 4 v1):
 *   - Plan transitions by status (count of `plan-transition` events to
 *     each status, plus `plan-drafted` count)
 *   - Override rate: per plan-type, how often reviewers reject/revise
 *     vs approve. Lower override rate = better Strategist quality.
 *   - Average revise rounds before terminal state
 *   - Escalation frequency + acknowledgement rate
 *   - Learning-loop activity (scans completed, meta plans drafted)
 *
 * Outside v1 scope (deferred):
 *   - Bug rate per shipped plan (needs `bugfix` plan attribution)
 *   - Context-efficiency (token usage per plan; cost.ts has the raw
 *     data but per-plan attribution needs more wiring)
 */

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ComputeTelemetryInput {
  dataDir: string;
  /** ISO datetime — events from this moment forward are counted. Default: 30d ago. */
  since?: string;
  /** Test seam — fixed clock for the recorded event. */
  now?: Date;
}

export interface PlanTransitionCounts {
  drafted: number;
  approved: number;
  revised: number;
  rejected: number;
  executing: number;
  done: number;
  shippedPendingImpact: number;
  success: number;
  nullResult: number;
  regression: number;
  cancelled: number;
}

export interface OverrideRate {
  type: string;
  /** Total review decisions made (approve + reject + revise). */
  reviewed: number;
  approved: number;
  rejected: number;
  revised: number;
  /** (rejected + revised) / reviewed, rounded to 2dp. 0..1. */
  rate: number;
}

export interface EscalationStats {
  recorded: number;
  acknowledged: number;
  outstanding: number;
}

export interface LearningLoopActivity {
  scansCompleted: number;
  metaPlansDrafted: number;
}

export interface TelemetryReport {
  since: string;
  /** Window length in days, derived from since → now. */
  windowDays: number;
  planTransitions: PlanTransitionCounts;
  overrideRates: OverrideRate[];
  averageReviseRounds: number;
  escalations: EscalationStats;
  learningLoop: LearningLoopActivity;
}

export function computeTelemetry(
  input: ComputeTelemetryInput,
): TelemetryReport {
  const now = input.now ?? new Date();
  const since = input.since ?? new Date(now.getTime() - DEFAULT_WINDOW_MS).toISOString();
  const windowMs = now.getTime() - new Date(since).getTime();
  const windowDays = Math.max(1, Math.round(windowMs / (24 * 60 * 60 * 1000)));

  const db = new Database(dbFile(input.dataDir), { readonly: true });
  let report: TelemetryReport;
  try {
    const planTransitions = countPlanTransitions(db, since);
    const overrideRates = computeOverrideRates(db, since);
    const averageReviseRounds = computeAverageReviseRounds(db, since);
    const escalations = computeEscalationStats(db, since);
    const learningLoop = computeLearningLoopActivity(db, since);
    report = {
      since,
      windowDays,
      planTransitions,
      overrideRates,
      averageReviseRounds,
      escalations,
      learningLoop,
    };
  } finally {
    db.close();
  }

  // Record the telemetry event so the loop can reference it. Best-
  // effort — failures here don't block the caller (CLI prints what
  // it has).
  try {
    const writeDb = new Database(dbFile(input.dataDir));
    try {
      appendEvent(writeDb, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "telemetry-computed",
        payload: {
          since,
          windowDays,
          planTransitions: report.planTransitions,
          overrideRateCount: report.overrideRates.length,
          averageReviseRounds: report.averageReviseRounds,
          escalations: report.escalations,
          learningLoop: report.learningLoop,
        },
        ...(input.now !== undefined && { createdAt: input.now.toISOString() }),
      });
    } finally {
      writeDb.close();
    }
  } catch {
    // best-effort — telemetry computation succeeded even if the audit
    // event failed.
  }

  return report;
}

// ---------------------------------------------------------------------------
// Plan transition counts
// ---------------------------------------------------------------------------

function countPlanTransitions(
  db: Database.Database,
  since: string,
): PlanTransitionCounts {
  const out: PlanTransitionCounts = {
    drafted: 0,
    approved: 0,
    revised: 0,
    rejected: 0,
    executing: 0,
    done: 0,
    shippedPendingImpact: 0,
    success: 0,
    nullResult: 0,
    regression: 0,
    cancelled: 0,
  };

  // plan-drafted is its own event kind.
  const draftedRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'plan-drafted' AND created_at >= ?",
    )
    .get(since) as { c: number };
  out.drafted = draftedRow.c;

  // plan-transition payloads carry { from, to, ... }. We count by the
  // destination state.
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE kind = 'plan-transition' AND created_at >= ?",
    )
    .all(since) as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { to?: unknown };
      if (typeof p.to !== "string") continue;
      switch (p.to) {
        case "approved":
          out.approved += 1;
          break;
        case "draft":
          // Plan returned to draft = a revise. Count separately.
          out.revised += 1;
          break;
        case "rejected":
          out.rejected += 1;
          break;
        case "executing":
          out.executing += 1;
          break;
        case "done":
          out.done += 1;
          break;
        case "shipped-pending-impact":
          out.shippedPendingImpact += 1;
          break;
        case "success":
          out.success += 1;
          break;
        case "null-result":
          out.nullResult += 1;
          break;
        case "regression":
          out.regression += 1;
          break;
        case "cancelled":
          out.cancelled += 1;
          break;
        default:
          // ignore unrecognised states
          break;
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Override rate per plan-type (approve / reject / revise feedback)
// ---------------------------------------------------------------------------

interface PlanTypeMeta {
  type: string;
}

function computeOverrideRates(
  db: Database.Database,
  since: string,
): OverrideRate[] {
  // Read all approve/reject/revise feedback rows in the window.
  const rows = db
    .prepare(
      `SELECT kind, target_id, created_at FROM feedback
       WHERE kind IN ('approve', 'reject', 'revise')
         AND target_type = 'plan'
         AND created_at >= ?`,
    )
    .all(since) as Array<{
    kind: string;
    target_id: string;
    created_at: string;
  }>;
  if (rows.length === 0) return [];

  // Look up each plan's type via plan-drafted events (best-effort —
  // a plan that hasn't been drafted in our event log is bucketed as
  // "unknown" so the operator notices).
  const planTypeById = readPlanTypeById(db);

  type Bucket = {
    type: string;
    approved: number;
    rejected: number;
    revised: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const type = planTypeById.get(r.target_id) ?? "unknown";
    let b = buckets.get(type);
    if (!b) {
      b = { type, approved: 0, rejected: 0, revised: 0 };
      buckets.set(type, b);
    }
    if (r.kind === "approve") b.approved += 1;
    else if (r.kind === "reject") b.rejected += 1;
    else if (r.kind === "revise") b.revised += 1;
  }

  const out: OverrideRate[] = [];
  for (const b of buckets.values()) {
    const reviewed = b.approved + b.rejected + b.revised;
    if (reviewed === 0) continue;
    const overrides = b.rejected + b.revised;
    const rate = Math.round((overrides / reviewed) * 100) / 100;
    out.push({
      type: b.type,
      reviewed,
      approved: b.approved,
      rejected: b.rejected,
      revised: b.revised,
      rate,
    });
  }
  // Worst-rate first; tie-break by reviewed count desc.
  out.sort((a, b) => b.rate - a.rate || b.reviewed - a.reviewed);
  return out;
}

function readPlanTypeById(
  db: Database.Database,
): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db
    .prepare("SELECT payload FROM events WHERE kind = 'plan-drafted'")
    .all() as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as {
        planId?: unknown;
        type?: unknown;
        brief?: unknown;
      };
      if (typeof p.planId !== "string") continue;
      // The plan-drafted payload doesn't always carry `type` — earlier
      // events recorded brief only. We backfill via a parsed-plan
      // lookup as a follow-up; for now any missing types bucket as
      // "unknown" via the caller.
      if (typeof p.type === "string") {
        out.set(p.planId, p.type);
      }
    } catch {
      // skip
    }
  }
  // Fallback: scan plan-transition events; their payloads sometimes
  // include `type` too. Prefer the first hit for stability.
  const transitions = db
    .prepare(
      "SELECT payload FROM events WHERE kind = 'plan-transition'",
    )
    .all() as Array<{ payload: string }>;
  for (const r of transitions) {
    try {
      const p = JSON.parse(r.payload) as {
        planId?: unknown;
        type?: unknown;
      };
      if (
        typeof p.planId === "string" &&
        typeof p.type === "string" &&
        !out.has(p.planId)
      ) {
        out.set(p.planId, p.type);
      }
    } catch {
      // skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Average revise rounds (per plan that eventually reached a terminal state)
// ---------------------------------------------------------------------------

function computeAverageReviseRounds(
  db: Database.Database,
  since: string,
): number {
  // Rough proxy: count revise-feedback rows / number of plans with at
  // least one terminal transition (approved | rejected) in the window.
  const reviseRows = db
    .prepare(
      "SELECT COUNT(*) AS c FROM feedback WHERE kind = 'revise' AND target_type = 'plan' AND created_at >= ?",
    )
    .get(since) as { c: number };
  const terminalRows = db
    .prepare(
      `SELECT COUNT(DISTINCT target_id) AS c FROM feedback
       WHERE kind IN ('approve', 'reject') AND target_type = 'plan'
         AND created_at >= ?`,
    )
    .get(since) as { c: number };
  if (terminalRows.c === 0) return 0;
  return Math.round((reviseRows.c / terminalRows.c) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Escalation stats
// ---------------------------------------------------------------------------

function computeEscalationStats(
  db: Database.Database,
  since: string,
): EscalationStats {
  const recordedRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'escalation' AND created_at >= ?",
    )
    .get(since) as { c: number };
  const acknowledgedRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'escalation-acknowledged' AND created_at >= ?",
    )
    .get(since) as { c: number };
  return {
    recorded: recordedRow.c,
    acknowledged: acknowledgedRow.c,
    outstanding: Math.max(0, recordedRow.c - acknowledgedRow.c),
  };
}

// ---------------------------------------------------------------------------
// Learning loop activity
// ---------------------------------------------------------------------------

function computeLearningLoopActivity(
  db: Database.Database,
  since: string,
): LearningLoopActivity {
  const scansRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'learn-scan-completed' AND created_at >= ?",
    )
    .get(since) as { c: number };
  const draftsRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'learn-meta-drafted' AND created_at >= ?",
    )
    .get(since) as { c: number };
  return {
    scansCompleted: scansRow.c,
    metaPlansDrafted: draftsRow.c,
  };
}
