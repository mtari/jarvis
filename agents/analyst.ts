import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadBrain } from "../orchestrator/brain.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import {
  findPlan,
  listPlans,
  savePlan,
  type PlanRecord,
} from "../orchestrator/plan-store.ts";
import { transitionPlan, type PlanStatus } from "../orchestrator/plan.ts";
import { isSuppressed } from "../orchestrator/suppressions.ts";
import { brainFile, dbFile } from "../cli/paths.ts";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { runStrategist, StrategistError } from "./strategist.ts";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
  SignalSeverity,
} from "../tools/scanners/types.ts";

/**
 * Runs the given collectors against an app's repo and records each signal
 * as a `signal` event in the SQLite event log. Returns the flat list of
 * signals so callers (CLI, daemon) can decide what to do next.
 *
 * Signals are recorded in the same transaction so a partial DB write
 * never leaves a half-recorded scan. If a collector throws (programming
 * bug — collectors are supposed to swallow runtime errors and return a
 * `low` signal instead), the error propagates and no signals are
 * recorded for that scan.
 *
 * For the Phase 2 entry, Analyst's job ends here: record signals + return
 * them. The Strategist hand-off ("auto-draft a plan when N high signals
 * land in 24h") and the suppressions filter land in subsequent plans.
 */
export interface AnalystScanInput {
  dataDir: string;
  app: string;
  vault: string;
  ctx: CollectorContext;
  collectors: ReadonlyArray<SignalCollector>;
}

export interface AnalystScanResult {
  signals: Signal[];
  /** Per-collector summary for the CLI output. */
  byCollector: Array<{
    kind: string;
    description: string;
    signalCount: number;
    durationMs: number;
    error?: string;
  }>;
}

export async function runAnalystScan(
  input: AnalystScanInput,
): Promise<AnalystScanResult> {
  const allSignals: Signal[] = [];
  const byCollector: AnalystScanResult["byCollector"] = [];

  for (const collector of input.collectors) {
    const start = Date.now();
    let signals: Signal[] = [];
    let errorMsg: string | undefined;
    try {
      signals = await collector.collect(input.ctx);
    } catch (err) {
      // Programming bug — note it and keep going. Collectors are
      // supposed to convert runtime failures into low-severity signals.
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - start;
    allSignals.push(...signals);
    byCollector.push({
      kind: collector.kind,
      description: collector.description,
      signalCount: signals.length,
      durationMs,
      ...(errorMsg !== undefined && { error: errorMsg }),
    });
  }

  // Record all signals in one DB transaction.
  if (allSignals.length > 0) {
    const db = new Database(dbFile(input.dataDir));
    try {
      db.transaction(() => {
        for (const s of allSignals) {
          appendEvent(db, {
            appId: input.app,
            vaultId: input.vault,
            kind: "signal",
            payload: {
              kind: s.kind,
              severity: s.severity,
              summary: s.summary,
              ...(s.details !== undefined && { details: s.details }),
              ...(s.dedupKey !== undefined && { dedupKey: s.dedupKey }),
            },
          });
        }
      })();
    } finally {
      db.close();
    }
  }

  return { signals: allSignals, byCollector };
}

// ---------------------------------------------------------------------------
// Auto-draft hand-off — Analyst → Strategist
//
// When a signal at or above a configurable severity threshold arrives,
// Analyst hands the signal to Strategist as the brief for an improvement
// plan. The plan goes through the normal review flow (`awaiting-review`
// → user approves → daemon fires Developer). Auto-drafted plans are
// idempotent on `signal.dedupKey`: if Analyst has already auto-drafted a
// plan for that dedup key, future scans skip it. Use `yarn jarvis
// reject` or revise the plan to clear it from the active queue;
// recurring signals don't re-spam.
// ---------------------------------------------------------------------------

/** Severity ranking. Used to compare against the threshold. */
const SEVERITY_RANK: Record<SignalSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Returns the dedup keys of every signal Analyst has already auto-drafted
 * a plan for. Used to short-circuit the auto-draft path on recurring
 * signals.
 */
export function readAutoDraftedDedupKeys(dbFilePath: string): Set<string> {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE kind = 'auto-drafted'")
      .all() as Array<{ payload: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { signalDedupKey?: string };
        if (typeof p.signalDedupKey === "string" && p.signalDedupKey.length > 0) {
          out.add(p.signalDedupKey);
        }
      } catch {
        // skip malformed
      }
    }
    return out;
  } finally {
    db.close();
  }
}

export interface AutoDraftFromSignalsInput {
  signals: ReadonlyArray<Signal>;
  app: string;
  vault: string;
  dataDir: string;
  client: AnthropicClient;
  /** Minimum severity that triggers auto-drafting. Defaults to "critical". */
  severityThreshold?: SignalSeverity;
}

export interface AutoDraftResultEntry {
  signal: Signal;
  /** Plan id when Strategist drafted successfully. */
  planId?: string;
  /** Reason why the signal was not auto-drafted (skipped, already drafted, error). */
  skippedReason?: string;
}

export interface AutoDraftFromSignalsResult {
  /** Per-signal outcome. */
  entries: AutoDraftResultEntry[];
  /** Count of plans actually drafted this call. */
  draftedCount: number;
  /** Count of signals skipped because their dedup key was already drafted. */
  alreadyDraftedCount: number;
  /** Count of signals skipped because severity was below the threshold. */
  belowThresholdCount: number;
  /** Count of signals skipped because they had no dedup key. */
  noDedupKeyCount: number;
  /** Count of signals skipped because their dedupKey is suppressed. */
  suppressedCount: number;
  /** Count of signals where the Strategist call failed. */
  errorCount: number;
}

/**
 * Walks `signals`, picks any whose severity meets `severityThreshold` and
 * whose `dedupKey` has not yet been auto-drafted, and asks Strategist to
 * draft an improvement plan for each. Records an `auto-drafted` event per
 * plan so future calls short-circuit on the same dedup key.
 *
 * Strategist runs with `challenge: false` because the daemon path has no
 * human to ask clarification questions. Failures (Strategist errors, plan
 * parse failures) are recorded in the per-signal entry and don't crash
 * the run — Analyst should be best-effort, not all-or-nothing.
 */
export async function autoDraftFromSignals(
  input: AutoDraftFromSignalsInput,
): Promise<AutoDraftFromSignalsResult> {
  const threshold = input.severityThreshold ?? "critical";
  const minRank = SEVERITY_RANK[threshold];
  const result: AutoDraftFromSignalsResult = {
    entries: [],
    draftedCount: 0,
    alreadyDraftedCount: 0,
    belowThresholdCount: 0,
    noDedupKeyCount: 0,
    suppressedCount: 0,
    errorCount: 0,
  };

  if (input.signals.length === 0) return result;

  const alreadyDrafted = readAutoDraftedDedupKeys(dbFile(input.dataDir));

  for (const signal of input.signals) {
    if (SEVERITY_RANK[signal.severity] < minRank) {
      result.entries.push({ signal, skippedReason: "below severity threshold" });
      result.belowThresholdCount += 1;
      continue;
    }
    if (!signal.dedupKey) {
      result.entries.push({
        signal,
        skippedReason:
          "no dedupKey — cannot guarantee idempotency, refusing to auto-draft",
      });
      result.noDedupKeyCount += 1;
      continue;
    }
    if (alreadyDrafted.has(signal.dedupKey)) {
      result.entries.push({
        signal,
        skippedReason: `already auto-drafted (dedupKey=${signal.dedupKey})`,
      });
      result.alreadyDraftedCount += 1;
      continue;
    }
    if (isSuppressed(dbFile(input.dataDir), signal.dedupKey)) {
      result.entries.push({
        signal,
        skippedReason: `suppressed (dedupKey=${signal.dedupKey})`,
      });
      result.suppressedCount += 1;
      continue;
    }

    const brief = composeBriefFromSignal(signal, input.app);
    let planId: string | undefined;
    try {
      const draft = await runStrategist({
        client: input.client,
        brief,
        app: input.app,
        vault: input.vault,
        dataDir: input.dataDir,
        type: "improvement",
        challenge: false,
      });
      planId = draft.planId;
    } catch (err) {
      const msg =
        err instanceof StrategistError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.entries.push({
        signal,
        skippedReason: `strategist error: ${msg}`,
      });
      result.errorCount += 1;
      continue;
    }

    // Record the auto-draft so future scans short-circuit on this dedupKey.
    const db = new Database(dbFile(input.dataDir));
    try {
      appendEvent(db, {
        appId: input.app,
        vaultId: input.vault,
        kind: "auto-drafted",
        payload: {
          signalKind: signal.kind,
          signalDedupKey: signal.dedupKey,
          signalSeverity: signal.severity,
          planId,
          actor: "analyst",
        },
      });
    } finally {
      db.close();
    }

    // Add to in-memory set so the same call doesn't re-draft on a duplicate signal.
    alreadyDrafted.add(signal.dedupKey);

    result.entries.push({ signal, planId });
    result.draftedCount += 1;
  }

  return result;
}

/**
 * Composes a Strategist brief from one signal. The brief reads as if a
 * user had described the issue: it names the collector that produced the
 * finding, describes the problem in plain text, and points Strategist at
 * any structured details so it has enough context to propose a fix.
 */
function composeBriefFromSignal(signal: Signal, app: string): string {
  const lines: string[] = [];
  lines.push(`Auto-detected by Analyst (${signal.kind} collector) on app "${app}".`);
  lines.push("");
  lines.push(`Severity: ${signal.severity}`);
  lines.push(`Finding: ${signal.summary}`);
  if (signal.details && Object.keys(signal.details).length > 0) {
    lines.push("");
    lines.push("Details:");
    lines.push("```json");
    lines.push(JSON.stringify(signal.details, null, 2));
    lines.push("```");
  }
  lines.push("");
  lines.push(
    "Draft an improvement plan that addresses this finding. The plan should identify the affected code or dependency, propose a concrete fix (update, patch, replacement), include rollback steps, and note acceptance criteria for verifying the fix landed correctly.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Post-merge observation — Analyst → "did the plan actually move the needle?"
//
// Once a plan reaches `shipped-pending-impact`, the user (or a future
// daemon hook) can call `observeImpact()` to re-run the collectors and
// see whether the signal that triggered the plan is gone.
//
// Verdict logic (Phase 2 MVP — keep simple, refine later):
//   - source dedupKey absent in current scan → "success"
//   - source dedupKey still present         → "null-result"
//   - "regression" requires baseline comparison and isn't computed here;
//     a future PR can wire that on top of the same hook.
//
// On a clean verdict the plan transitions accordingly. Observation is
// idempotent: a second call re-scans but a plan already past
// `shipped-pending-impact` returns `wrong-status` instead of acting.
// ---------------------------------------------------------------------------

export type ImpactVerdict =
  | "success"
  | "null-result"
  | "no-baseline"
  | "wrong-status";

export interface ObserveImpactInput {
  dataDir: string;
  planId: string;
  /** Disambiguator when the same plan id exists in multiple vaults. */
  vault?: string;
  collectors: ReadonlyArray<SignalCollector>;
}

export interface ObserveImpactResult {
  verdict: ImpactVerdict;
  planId: string;
  vault: string;
  app: string;
  /** dedupKey of the signal that triggered the plan (when discoverable). */
  signalDedupKey?: string;
  /** True iff the source dedupKey is still produced by the current scan. */
  dedupKeyStillPresent?: boolean;
  /** Set when the plan transitioned status as a result of this observation. */
  newStatus?: PlanStatus;
  /** Number of signals the rescan produced (any severity). */
  newSignalCount?: number;
  /** Human-readable reason for non-acting verdicts. */
  message?: string;
}

export async function observeImpact(
  input: ObserveImpactInput,
): Promise<ObserveImpactResult> {
  const dbFilePath = dbFile(input.dataDir);

  const record = resolvePlan(input.dataDir, input.planId, input.vault);
  if (!record) {
    throw new Error(`plan not found: ${input.planId}`);
  }
  const { vault, app } = record;

  if (record.plan.metadata.status !== "shipped-pending-impact") {
    return {
      verdict: "wrong-status",
      planId: input.planId,
      vault,
      app,
      message: `plan is in status "${record.plan.metadata.status}" — observation only runs on plans in "shipped-pending-impact"`,
    };
  }

  const sourceDedupKey = readAutoDraftedDedupKeyForPlan(
    dbFilePath,
    input.planId,
  );
  if (sourceDedupKey === null) {
    return {
      verdict: "no-baseline",
      planId: input.planId,
      vault,
      app,
      message:
        "no auto-drafted event found for this plan — observation needs a triggering signal as baseline",
    };
  }

  const brain = loadBrain(brainFile(input.dataDir, vault, app));
  if (!brain.repo) {
    throw new Error(
      `app "${app}" has no brain.repo configured — cannot run collectors`,
    );
  }
  const cwd = brain.repo.monorepoPath
    ? path.join(brain.repo.rootPath, brain.repo.monorepoPath)
    : brain.repo.rootPath;

  const scan = await runAnalystScan({
    dataDir: input.dataDir,
    app,
    vault,
    ctx: { cwd, app },
    collectors: input.collectors,
  });

  const stillPresent = scan.signals.some((s) => s.dedupKey === sourceDedupKey);
  const verdict: ImpactVerdict = stillPresent ? "null-result" : "success";
  const newStatus: PlanStatus = stillPresent ? "null-result" : "success";

  const newPlan = transitionPlan(record.plan, newStatus);
  savePlan(record.path, newPlan);

  const db = new Database(dbFilePath);
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "impact-observed",
      payload: {
        planId: input.planId,
        sourceDedupKey,
        verdict,
        dedupKeyStillPresent: stillPresent,
        newStatus,
        newSignalCount: scan.signals.length,
      },
    });
  } finally {
    db.close();
  }

  return {
    verdict,
    planId: input.planId,
    vault,
    app,
    signalDedupKey: sourceDedupKey,
    dedupKeyStillPresent: stillPresent,
    newStatus,
    newSignalCount: scan.signals.length,
  };
}

function resolvePlan(
  dataDir: string,
  planId: string,
  vault: string | undefined,
): PlanRecord | null {
  if (vault === undefined) {
    return findPlan(dataDir, planId);
  }
  return (
    listPlans(dataDir).find((r) => r.id === planId && r.vault === vault) ?? null
  );
}

/**
 * Plans in `shipped-pending-impact` whose mtime is at least `delayHours`
 * old AND for which no `impact-observed` event has been recorded yet.
 * Used by the daemon's analyst tick to auto-fire observations.
 */
export interface PendingImpactObservation {
  planId: string;
  vault: string;
  app: string;
  /** Hours since the plan file was last modified — proxy for "shipped how long ago". */
  ageHours: number;
}

export interface FindPendingObservationsInput {
  dataDir: string;
  now: Date;
  delayHours: number;
}

export function findPlansAwaitingImpactObservation(
  input: FindPendingObservationsInput,
): PendingImpactObservation[] {
  const observed = readImpactObservedPlanIds(dbFile(input.dataDir));
  const out: PendingImpactObservation[] = [];
  for (const r of listPlans(input.dataDir)) {
    if (r.plan.metadata.status !== "shipped-pending-impact") continue;
    if (observed.has(r.id)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(r.path);
    } catch {
      continue;
    }
    const ageHours = (input.now.getTime() - stat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours < input.delayHours) continue;
    out.push({
      planId: r.id,
      vault: r.vault,
      app: r.app,
      ageHours,
    });
  }
  return out;
}

function readImpactObservedPlanIds(dbFilePath: string): Set<string> {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE kind = 'impact-observed'")
      .all() as Array<{ payload: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { planId?: string };
        if (typeof p.planId === "string") out.add(p.planId);
      } catch {
        // skip malformed
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function readAutoDraftedDedupKeyForPlan(
  dbFilePath: string,
  planId: string,
): string | null {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE kind = 'auto-drafted'")
      .all() as Array<{ payload: string }>;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as {
          planId?: string;
          signalDedupKey?: string;
        };
        if (
          p.planId === planId &&
          typeof p.signalDedupKey === "string" &&
          p.signalDedupKey.length > 0
        ) {
          return p.signalDedupKey;
        }
      } catch {
        // skip malformed
      }
    }
    return null;
  } finally {
    db.close();
  }
}
