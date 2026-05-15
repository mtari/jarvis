import Database from "better-sqlite3";
import { runStrategist, StrategistError } from "./strategist.ts";
import {
  computeTelemetry,
  type TelemetryReport,
} from "./analyst-telemetry.ts";
import { runLearnScan, type LearnReport } from "./analyst-learn.ts";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { listPlans, openPlansContextBlock } from "../orchestrator/plan-store.ts";
import { dbFile } from "../cli/paths.ts";

/**
 * Daily self-audit (§5, §16). On schedule:
 *   1. Throughput gate: only run when ≥1 *project* plan (any app != "jarvis")
 *      reached `shipped-pending-impact` in the past 7 days.
 *   2. Backlog gate: only draft when the `jarvis` improvement-plan backlog
 *      depth (status ∈ {awaiting-review, approved}, subtype != "meta") is
 *      below `targetDepth` (default 3).
 *   3. Idempotency: skip if a `daily-audit-completed` event fired in the
 *      last 24h, regardless of whether it actually drafted. The 24h window
 *      is what enforces the once-per-day cadence — the daemon ticks hourly
 *      and the idempotency check makes every tick after the first a no-op
 *      until the window rolls.
 *
 * Until 2026-05-10 this was `friday-audit` and ran only on Fridays. The
 * day-of-week gate was dropped to give the audit a faster feedback loop;
 * the existing 24h idempotency already enforces the right cadence.
 *
 * When all gates pass, builds an input bundle (telemetry summary +
 * learn-scan findings) and asks Strategist to draft ONE improvement plan
 * for the `jarvis` app per run. Per-run drafting count caps prevent
 * proliferation; if depth stays below target the next day, another plan
 * gets drafted then.
 *
 * Subtype `meta` is *excluded* from the drafted output — those flow via
 * the learning loop. The daily audit drafts product improvements to
 * jarvis itself.
 */

const DEFAULT_TARGET_DEPTH = 3;
const DEFAULT_THROUGHPUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DRAFTS_PER_RUN = 1;
const JARVIS_APP = "jarvis";
const JARVIS_VAULT = "personal";

export type DailyAuditSkipReason =
  | "no-throughput"
  | "already-ran-recently"
  | "backlog-full"
  | "no-context";

export interface DailyAuditDraft {
  planId: string;
  planPath: string;
}

export interface DailyAuditResult {
  /** True if the run actually called Strategist; false on any gate skip. */
  ran: boolean;
  /** Populated when ran=false. */
  skipReason?: DailyAuditSkipReason;
  /** Backlog depth at time of run. */
  backlogDepth: number;
  /** Number of project shipments observed in the throughput window. */
  projectShipments: number;
  drafted: DailyAuditDraft[];
  errors: string[];
}

export interface RunDailyAuditInput {
  dataDir: string;
  client: AnthropicClient;
  /** Test seam — fixed clock. */
  now?: Date;
  /** Override for the day-of-week gate. Default 3. */
  targetDepth?: number;
  /** Override for the throughput-window. Default 7 days. */
  throughputWindowMs?: number;
  /** Override for the idempotency-window. Default 24 hours. */
  idempotencyWindowMs?: number;
  /** Cap on drafts per run. Default 1 — top up gradually. */
  maxDraftsPerRun?: number;
  /**
   * Bypass the no-throughput + already-ran gates (test + `--force`
   * from the CLI). Backlog-full is still respected because topping up
   * beyond the target depth would overshoot the spec.
   */
  force?: boolean;
  /** Build but don't draft. Lets the operator see what would fire. */
  dryRun?: boolean;
}

export async function runDailyAudit(
  input: RunDailyAuditInput,
): Promise<DailyAuditResult> {
  const now = input.now ?? new Date();
  const targetDepth = input.targetDepth ?? DEFAULT_TARGET_DEPTH;
  const throughputWindowMs =
    input.throughputWindowMs ?? DEFAULT_THROUGHPUT_WINDOW_MS;
  const idempotencyWindowMs =
    input.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
  const maxDrafts = input.maxDraftsPerRun ?? DEFAULT_MAX_DRAFTS_PER_RUN;

  const backlogDepth = countJarvisBacklogDepth(input.dataDir);
  const projectShipments = countProjectShipments(
    input.dataDir,
    new Date(now.getTime() - throughputWindowMs).toISOString(),
  );

  const baseResult = {
    backlogDepth,
    projectShipments,
    drafted: [] as DailyAuditDraft[],
    errors: [] as string[],
  };

  if (!input.force) {
    if (projectShipments === 0) {
      return { ran: false, skipReason: "no-throughput", ...baseResult };
    }
    if (
      hasRecentAuditCompletion(
        input.dataDir,
        new Date(now.getTime() - idempotencyWindowMs).toISOString(),
      )
    ) {
      return {
        ran: false,
        skipReason: "already-ran-recently",
        ...baseResult,
      };
    }
  }

  if (backlogDepth >= targetDepth) {
    return { ran: false, skipReason: "backlog-full", ...baseResult };
  }

  // Build the context bundle. Both calls are pure DB reads (computeTelemetry
  // also writes a telemetry-computed event but that's fine — it's
  // self-documenting).
  const telemetry = computeTelemetry({ dataDir: input.dataDir, now });
  const learnReport = runLearnScan({ dataDir: input.dataDir, now });
  const openPlans = openPlansContextBlock(input.dataDir, JARVIS_APP);
  const brief = composeBrief({
    telemetry,
    learnReport,
    now,
    ...(openPlans !== null && { openPlans }),
  });

  // Bail out cleanly when there's truly nothing to point at — no plan
  // transitions, no feedback, nothing in the learning loop. Avoids
  // inviting Strategist to invent grievances.
  if (!hasMeaningfulSignal({ telemetry, learnReport })) {
    return { ran: false, skipReason: "no-context", ...baseResult };
  }

  if (input.dryRun) {
    recordAuditCompletion(input.dataDir, {
      now,
      drafted: [],
      backlogDepth,
      projectShipments,
      mode: "dry-run",
      brief,
    });
    return { ran: true, ...baseResult };
  }

  const slotsAvailable = Math.min(maxDrafts, targetDepth - backlogDepth);
  for (let i = 0; i < slotsAvailable; i += 1) {
    try {
      const draft = await runStrategist({
        client: input.client,
        brief,
        app: JARVIS_APP,
        vault: JARVIS_VAULT,
        dataDir: input.dataDir,
        type: "improvement",
        challenge: false,
      });
      baseResult.drafted.push({
        planId: draft.planId,
        planPath: draft.planPath,
      });
    } catch (err) {
      const msg =
        err instanceof StrategistError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      baseResult.errors.push(`strategist error: ${msg}`);
      // Stop on first error to avoid retry storms; tomorrow tries again.
      break;
    }
  }

  recordAuditCompletion(input.dataDir, {
    now,
    drafted: baseResult.drafted,
    backlogDepth,
    projectShipments,
    mode: "live",
    brief,
  });

  return { ran: true, ...baseResult };
}

// ---------------------------------------------------------------------------
// Backlog-depth measurement
// ---------------------------------------------------------------------------

const BACKLOG_STATUSES: ReadonlySet<string> = new Set([
  "awaiting-review",
  "approved",
]);

function countJarvisBacklogDepth(dataDir: string): number {
  const records = listPlans(dataDir);
  let depth = 0;
  for (const r of records) {
    if (r.app !== JARVIS_APP) continue;
    if (r.plan.metadata.type !== "improvement") continue;
    if (r.plan.metadata.subtype === "meta") continue;
    if (!BACKLOG_STATUSES.has(r.plan.metadata.status)) continue;
    depth += 1;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Throughput gate
// ---------------------------------------------------------------------------

function countProjectShipments(dataDir: string, sinceIso: string): number {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT app_id, payload FROM events
         WHERE kind = 'plan-transition' AND created_at >= ?`,
      )
      .all(sinceIso) as Array<{ app_id: string; payload: string }>;
    let count = 0;
    for (const r of rows) {
      if (r.app_id === JARVIS_APP) continue;
      try {
        const p = JSON.parse(r.payload) as { to?: unknown };
        if (p.to === "shipped-pending-impact") count += 1;
      } catch {
        // skip malformed
      }
    }
    return count;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function hasRecentAuditCompletion(
  dataDir: string,
  sinceIso: string,
): boolean {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM events WHERE kind = 'daily-audit-completed'
         AND created_at >= ? LIMIT 1`,
      )
      .get(sinceIso);
    return row !== undefined;
  } finally {
    db.close();
  }
}

interface RecordAuditArgs {
  now: Date;
  drafted: DailyAuditDraft[];
  backlogDepth: number;
  projectShipments: number;
  mode: "live" | "dry-run";
  brief: string;
}

function recordAuditCompletion(
  dataDir: string,
  args: RecordAuditArgs,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: JARVIS_APP,
      vaultId: JARVIS_VAULT,
      kind: "daily-audit-completed",
      payload: {
        mode: args.mode,
        drafted: args.drafted.map((d) => d.planId),
        backlogDepthBefore: args.backlogDepth,
        projectShipments: args.projectShipments,
        briefBytes: args.brief.length,
      },
      createdAt: args.now.toISOString(),
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Brief composition + signal-meaningfulness check
// ---------------------------------------------------------------------------

function hasMeaningfulSignal(args: {
  telemetry: TelemetryReport;
  learnReport: LearnReport;
}): boolean {
  const t = args.telemetry.planTransitions;
  const totalActivity =
    t.drafted +
    t.approved +
    t.rejected +
    t.revised +
    t.executing +
    t.done +
    t.shippedPendingImpact +
    t.success +
    t.nullResult +
    t.regression +
    t.cancelled;
  if (totalActivity > 0) return true;
  if (args.telemetry.escalations.recorded > 0) return true;
  if (args.telemetry.overrideRates.length > 0) return true;
  if (args.learnReport.rejectionThemes.length > 0) return true;
  if (args.learnReport.reviseThemes.length > 0) return true;
  if (args.learnReport.lowApprovalRates.length > 0) return true;
  return false;
}

function composeBrief(args: {
  telemetry: TelemetryReport;
  learnReport: LearnReport;
  now: Date;
  /** Currently-open `jarvis` plans from `openPlansContextBlock(...)`. Optional. */
  openPlans?: string;
}): string {
  const lines: string[] = [];
  lines.push("Daily self-audit for the `jarvis` app itself.");
  lines.push("");
  lines.push(
    "You are drafting ONE improvement plan against the `jarvis` source tree, derived from the operational signals below. Constraints:",
  );
  lines.push(
    "- Subtype must be one of: new-feature, rework, refactor, security-fix, dep-update, bugfix. NOT `meta` — meta plans flow through the learning loop, not this audit.",
  );
  lines.push(
    "- Tie the success metric to a measurable line in the telemetry below (override-rate, escalation count, average revise rounds, plan-success rate, etc.) so the operator can verify the change actually moves the needle.",
  );
  lines.push(
    "- Pick the highest-leverage gap. If multiple metrics are concerning, prefer the one with the largest sample size.",
  );
  lines.push("");

  lines.push(
    `Telemetry — last ${args.telemetry.windowDays} day(s) (since ${args.telemetry.since})`,
  );
  const t = args.telemetry.planTransitions;
  lines.push(
    `- Plan transitions: drafted=${t.drafted}, approved=${t.approved}, revised=${t.revised}, rejected=${t.rejected}, executing=${t.executing}, done=${t.done}, shipped-pending=${t.shippedPendingImpact}, success=${t.success}, null-result=${t.nullResult}, regression=${t.regression}, cancelled=${t.cancelled}`,
  );
  lines.push(
    `- Average revise rounds: ${args.telemetry.averageReviseRounds.toFixed(2)}`,
  );
  lines.push(
    `- Escalations: recorded=${args.telemetry.escalations.recorded}, acknowledged=${args.telemetry.escalations.acknowledged}, outstanding=${args.telemetry.escalations.outstanding}`,
  );
  if (args.telemetry.overrideRates.length === 0) {
    lines.push("- Override rates: (no review decisions recorded)");
  } else {
    lines.push("- Override rates per plan-type (worst first):");
    for (const r of args.telemetry.overrideRates) {
      lines.push(
        `  - ${r.type}: ${(r.rate * 100).toFixed(0)}% (approved=${r.approved}, rejected=${r.rejected}, revised=${r.revised}, n=${r.reviewed})`,
      );
    }
  }
  lines.push(
    `- Learning loop: scans=${args.telemetry.learningLoop.scansCompleted}, meta plans drafted=${args.telemetry.learningLoop.metaPlansDrafted}`,
  );
  lines.push("");

  lines.push("Recurring feedback themes (last 30 days):");
  if (args.learnReport.rejectionThemes.length === 0) {
    lines.push("- Rejection themes: none above threshold");
  } else {
    lines.push("- Rejection themes:");
    for (const th of args.learnReport.rejectionThemes.slice(0, 5)) {
      lines.push(
        `  - "${th.token}" (count=${th.count}, examples: ${th.examplePlanIds.join(", ")})`,
      );
    }
  }
  if (args.learnReport.reviseThemes.length === 0) {
    lines.push("- Revise themes: none above threshold");
  } else {
    lines.push("- Revise themes:");
    for (const th of args.learnReport.reviseThemes.slice(0, 5)) {
      lines.push(
        `  - "${th.token}" (count=${th.count}, examples: ${th.examplePlanIds.join(", ")})`,
      );
    }
  }
  if (args.learnReport.lowApprovalRates.length === 0) {
    lines.push("- Low-approval categories: none");
  } else {
    lines.push("- Low-approval categories:");
    for (const lar of args.learnReport.lowApprovalRates.slice(0, 5)) {
      lines.push(
        `  - ${lar.type}${lar.subtype ? `/${lar.subtype}` : ""}: ${Math.round(
          lar.rate * 100,
        )}% approved (${lar.approved}/${lar.total})`,
      );
    }
  }
  if (args.learnReport.recommendations.length > 0) {
    lines.push("");
    lines.push("Operator-readable recommendations from the learning loop:");
    for (const r of args.learnReport.recommendations.slice(0, 5)) {
      lines.push(`- ${r}`);
    }
  }
  if (args.openPlans) {
    lines.push("");
    lines.push(args.openPlans);
  }
  return lines.join("\n");
}
