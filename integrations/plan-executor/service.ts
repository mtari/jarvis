import { execSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import {
  detectDeveloperMode,
  draftImplementationPlan,
  DeveloperError,
  executePlan,
  isAmendmentResume,
} from "../../agents/developer.ts";
import {
  CashInGateViolatedError,
  RateLimitedError,
  type RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { recordEscalation } from "../../orchestrator/escalations.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { loadBrain } from "../../orchestrator/brain.ts";
import { findPlan, listPlans, savePlan, type PlanRecord } from "../../orchestrator/plan-store.ts";
import { transitionPlan, type PlanStatus } from "../../orchestrator/plan.ts";
import { readTodayCallCount } from "../../cli/commands/cost.ts";
import { brainFile, dbFile } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_DAILY_CALL_CAP = 150;

export interface PlanExecutorOptions {
  dataDir: string;
  /** Tick interval for the auto-fire scan. Default 30s. */
  tickMs?: number;
  /**
   * Override repo root for ALL fires — tests inject a fixture repo so
   * assertCleanMain doesn't run against the real working tree. When set,
   * brain-based per-app cwd lookup is bypassed.
   */
  repoRoot?: string;
  /**
   * Daily UTC cap on `agent-call` events. When today's count >= cap, the
   * tick body returns early without firing — protects the user's MAX
   * subscription rate-limit window. Default 150. See §18.
   */
  dailyCallCap?: number;
  /** Test injection — overrides the SDK transport for every Developer fire. */
  transport?: RunAgentTransport;
  /**
   * Override the tick body for testing. When provided, replaces the default
   * runPlanExecutorTick call so tests can inject timing-controlled stubs
   * without spying on module internals.
   *
   * @internal — not part of the public API.
   */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

interface FiredPayload {
  planId: string;
  app: string;
  mode: "draft-impl" | "execute" | "not-runnable" | "skipped" | "claim-recovered" | "recovery-exhausted";
  reason?: string;
  result?: Record<string, unknown>;
  durationMs?: number;
  priorClaimEventId?: number;
}

export interface StaleExecutingPlan {
  planId: string;
  app: string;
  vaultId: string;
  lastEventAt: string;
}

interface OrphanedClaim {
  eventId: number;
  planId: string;
  app: string;
  vaultId: string;
  claimedAt: string;
}

/**
 * Returns claim rows that have no later plan-executor-fired event for the
 * same planId. These arise when the daemon is killed between writing the
 * claim and writing the result — the plan stays stuck in "executing" until
 * the executor rewrites a recovery event.
 */
export function findOrphanedClaims(dbFilePath: string): OrphanedClaim[] {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT e.id AS eventId,
                json_extract(e.payload, '$.planId') AS planId,
                e.app_id AS app,
                e.vault_id AS vaultId,
                e.created_at AS claimedAt
         FROM events e
         WHERE e.kind = 'plan-executor-fired'
           AND json_extract(e.payload, '$.mode') = 'skipped'
           AND json_extract(e.payload, '$.reason') = 'claimed; result pending'
           AND NOT EXISTS (
             SELECT 1 FROM events e2
             WHERE e2.kind = 'plan-executor-fired'
               AND json_extract(e2.payload, '$.planId') = json_extract(e.payload, '$.planId')
               AND e2.id > e.id
               AND (
                 (json_extract(e2.payload, '$.mode') = 'skipped'
                  AND json_extract(e2.payload, '$.reason') = 'claimed; result pending')
                 OR json_extract(e2.payload, '$.mode') = 'not-runnable'
                 OR (json_extract(e2.payload, '$.mode') IN ('draft-impl', 'execute')
                     AND (json_extract(e2.payload, '$.reason') IS NULL
                          OR (json_extract(e2.payload, '$.reason') NOT LIKE 'BLOCKED:%'
                              AND json_extract(e2.payload, '$.reason') NOT LIKE 'RATE_LIMITED:%')))
               )
           )`,
      )
      .all() as Array<{
        eventId: number;
        planId: string;
        app: string;
        vaultId: string;
        claimedAt: string;
      }>;
    return rows.filter((r) => r.planId != null);
  } finally {
    db.close();
  }
}

/**
 * For each orphaned claim, appends a plan-executor-fired event with
 * mode = 'claim-recovered' so the planId re-enters the eligibility set
 * on the next tick. Logs one info line per recovered orphan; emits nothing
 * when the sweep finds zero.
 */
export function recoverOrphanedClaims(
  dbFilePath: string,
  logger: DaemonContext["logger"],
): void {
  const orphans = findOrphanedClaims(dbFilePath);
  if (orphans.length === 0) return;

  const dataDir = path.dirname(dbFilePath);
  const recoveredAt = new Date().toISOString();
  const db = new Database(dbFilePath);
  try {
    for (const orphan of orphans) {
      // If the plan is stuck in executing, transition it back to approved so
      // the next tick can re-fire it. Skip the transition if it's already in
      // a non-executing state (e.g., user manually moved it).
      const record = findPlan(dataDir, orphan.planId);
      if (record && record.plan.metadata.status === "executing") {
        applyPlanTransition(dataDir, record, "approved", "plan-executor", "orphaned-claim recovery");
      }
      appendEvent(db, {
        appId: orphan.app,
        vaultId: orphan.vaultId,
        kind: "plan-executor-fired",
        payload: {
          planId: orphan.planId,
          app: orphan.app,
          mode: "claim-recovered",
          reason: `orphaned by daemon restart at ${recoveredAt}`,
          priorClaimEventId: orphan.eventId,
        } satisfies FiredPayload,
      });
      logger.info("plan-executor: recovered orphaned claim", {
        planId: orphan.planId,
        claimedAt: orphan.claimedAt,
        priorClaimEventId: orphan.eventId,
      });
    }
  } finally {
    db.close();
  }
}

/**
 * Writes a plan-transition event and updates the plan file atomically.
 * Callers are responsible for guarding against invalid transitions (e.g.,
 * check `record.plan.metadata.status` before calling).
 */
function applyPlanTransition(
  dataDir: string,
  record: PlanRecord,
  to: PlanStatus,
  actor: string,
  reason: string,
): void {
  const next = transitionPlan(record.plan, to);
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: record.app,
      vaultId: record.vault,
      kind: "plan-transition",
      payload: {
        planId: record.id,
        from: record.plan.metadata.status,
        to,
        actor,
        reason,
      },
    });
  } finally {
    db.close();
  }
  savePlan(record.path, next);
}

/**
 * Counts plan-executor-fired events for a planId where the fire was an
 * execute that returned done=false (identified by the BLOCKED:done=false
 * reason prefix). Used to decide whether to retry or permanently block.
 */
function countDoneFalseAttempts(db: Database.Database, planId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM events
       WHERE kind = 'plan-executor-fired'
         AND json_extract(payload, '$.planId') = ?
         AND json_extract(payload, '$.mode') = 'execute'
         AND json_extract(payload, '$.reason') LIKE 'BLOCKED: done=false%'`,
    )
    .get(planId) as { cnt: number };
  return row?.cnt ?? 0;
}

/**
 * Counts plan-executor-fired events with mode=claim-recovered for a planId
 * that occurred after the most recent agent-call event for the same planId
 * (or after windowCutoffIso if no such agent-call exists), bounded by the
 * 24-hour window. Used to enforce the stale-executing recovery cap.
 */
export function countRecoveriesSinceLastAgentCall(
  db: Database.Database,
  planId: string,
  windowCutoffIso: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM events
       WHERE kind = 'plan-executor-fired'
         AND json_extract(payload, '$.mode') = 'claim-recovered'
         AND json_extract(payload, '$.planId') = ?
         AND created_at > MAX(
           COALESCE(
             (SELECT MAX(created_at) FROM events
              WHERE kind = 'agent-call'
                AND json_extract(payload, '$.planId') = ?),
             '1970-01-01T00:00:00.000Z'
           ),
           ?
         )`,
    )
    .get(planId, planId, windowCutoffIso) as { cnt: number };
  return row?.cnt ?? 0;
}

/**
 * Returns plans that are currently in executing state (per event log: latest
 * plan-transition has to='executing' with no later plan-transition) AND whose
 * last plan-transition or agent-call event is older than `nowMs - thresholdMs`.
 * Default threshold: 30 minutes.
 */
export function findStaleExecuting(
  dbFilePath: string,
  nowMs: number,
  thresholdMs = 30 * 60_000,
): StaleExecutingPlan[] {
  const db = new Database(dbFilePath, { readonly: true });
  const cutoff = new Date(nowMs - thresholdMs).toISOString();
  try {
    const rows = db
      .prepare(
        `SELECT
           json_extract(e.payload, '$.planId') AS planId,
           e.app_id                            AS app,
           e.vault_id                          AS vaultId,
           (
             SELECT MAX(e3.created_at)
             FROM events e3
             WHERE (e3.kind = 'plan-transition' OR e3.kind = 'agent-call')
               AND json_extract(e3.payload, '$.planId') = json_extract(e.payload, '$.planId')
           ) AS lastEventAt
         FROM events e
         WHERE e.kind = 'plan-transition'
           AND json_extract(e.payload, '$.to') = 'executing'
           AND json_extract(e.payload, '$.planId') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM events e2
             WHERE e2.kind = 'plan-transition'
               AND json_extract(e2.payload, '$.planId') = json_extract(e.payload, '$.planId')
               AND e2.id > e.id
           )
           AND (
             SELECT MAX(e3.created_at)
             FROM events e3
             WHERE (e3.kind = 'plan-transition' OR e3.kind = 'agent-call')
               AND json_extract(e3.payload, '$.planId') = json_extract(e.payload, '$.planId')
           ) < ?`,
      )
      .all(cutoff) as StaleExecutingPlan[];
    return rows;
  } finally {
    db.close();
  }
}

/**
 * For each plan stuck in executing with no recent activity, transitions it
 * back to approved and writes a claim-recovered event so the next tick
 * can re-fire it. After 3 recoveries within 24h with no intervening
 * agent-call, transitions the plan to blocked instead.
 */
export function recoverStaleExecuting(
  dbFilePath: string,
  logger: DaemonContext["logger"],
  nowMs = Date.now(),
  thresholdMs?: number,
): void {
  const stale = findStaleExecuting(dbFilePath, nowMs, thresholdMs);
  if (stale.length === 0) return;

  const dataDir = path.dirname(dbFilePath);
  const windowCutoffIso = new Date(nowMs - 24 * 3600_000).toISOString();
  const db = new Database(dbFilePath);
  try {
    for (const entry of stale) {
      const count = countRecoveriesSinceLastAgentCall(db, entry.planId, windowCutoffIso);
      if (count >= 3) {
        const record = findPlan(dataDir, entry.planId);
        if (record && record.plan.metadata.status === "executing") {
          applyPlanTransition(
            dataDir,
            record,
            "blocked",
            "plan-executor",
            `recovered ${count} times in 24h without Developer progress — manual intervention required`,
          );
        }
        appendEvent(db, {
          appId: entry.app,
          vaultId: entry.vaultId,
          kind: "plan-executor-fired",
          payload: {
            planId: entry.planId,
            app: entry.app,
            mode: "recovery-exhausted",
            reason: `stale-executing recovery exhausted after ${count} recoveries — plan blocked`,
          } satisfies FiredPayload,
        });
        logger.info("plan-executor: recovery exhausted — plan blocked", {
          planId: entry.planId,
          recoveryCount: count,
        });
      } else {
        const record = findPlan(dataDir, entry.planId);
        if (record && record.plan.metadata.status === "executing") {
          applyPlanTransition(dataDir, record, "approved", "plan-executor", "stale-executing recovery");
        }
        appendEvent(db, {
          appId: entry.app,
          vaultId: entry.vaultId,
          kind: "plan-executor-fired",
          payload: {
            planId: entry.planId,
            app: entry.app,
            mode: "claim-recovered",
            reason: `stale-executing recovery — last activity at ${entry.lastEventAt}`,
          } satisfies FiredPayload,
        });
        logger.info("plan-executor: recovered stale executing plan", {
          planId: entry.planId,
          trigger: "stale-executing",
          lastEventAt: entry.lastEventAt,
        });
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Throws if the repo at `root` is not on the main branch with a clean
 * working tree. This is a hard gate — execute fires must never start with
 * dirty state or on the wrong branch.
 */
export function assertCleanMain(root?: string): void {
  const cwd = root ?? process.cwd();
  const branch = execSync("git branch --show-current", { cwd })
    .toString()
    .trim();
  if (branch !== "main") {
    throw new DeveloperError(
      `assertCleanMain: HEAD is on branch "${branch}", not "main" — aborting execute fire`,
    );
  }
  const status = execSync("git status --porcelain", { cwd })
    .toString()
    .trim();
  if (status !== "") {
    throw new DeveloperError(
      `assertCleanMain: working tree is dirty — aborting execute fire\n${status}`,
    );
  }
}

/**
 * Returns true when the given fired-event payload represents a *terminal*
 * outcome — either a successful fire, a fire that errored mid-flight, or
 * an in-flight claim that another tick must not race against. Refusals
 * (skip reasons that may become valid later — e.g. obsolete enabledApps
 * filters from prior versions, "no brain.repo configured", or recoverable
 * BLOCKED/RATE_LIMITED gates) return false so the next tick can re-evaluate
 * the plan once the underlying condition resolves.
 *
 * Without this filter, any historical refusal silently shadows the plan
 * forever and the user has to delete events from jarvis.db by hand.
 */
function isFinalFiredEvent(p: FiredPayload): boolean {
  if (p.mode === "claim-recovered") {
    // Recovery event written by startup sweep — plan re-enters eligibility.
    return false;
  }
  if (p.mode === "skipped") {
    // The only skipped row that locks is the in-flight claim written
    // before the fire. Every other "skipped" reason is a refusal whose
    // condition may change.
    return p.reason === "claimed; result pending";
  }
  if (p.mode === "recovery-exhausted") {
    // Recovery cap hit — plan blocked; no further auto-recovery.
    return true;
  }
  if (p.mode === "not-runnable") {
    // Plan is in the wrong state for Developer; needs human action.
    return true;
  }
  // mode === "draft-impl" | "execute"
  if (typeof p.reason === "string") {
    if (p.reason.startsWith("BLOCKED:")) return false;
    if (p.reason.startsWith("RATE_LIMITED:")) return false;
  }
  return true;
}

/**
 * Returns the set of plan ids that have a *terminal* `plan-executor-fired`
 * event recorded. Events are processed in insertion order; a
 * `claim-recovered` event removes its planId from the set so the plan
 * re-enters the eligibility set on the next tick. See `isFinalFiredEvent`.
 */
export function readFiredPlanIds(dbFilePath: string): Set<string> {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'plan-executor-fired' ORDER BY id ASC",
      )
      .all() as Array<{ payload: string }>;
    const ids = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as FiredPayload;
        if (!p.planId) continue;
        if (p.mode === "claim-recovered") {
          ids.delete(p.planId);
        } else if (isFinalFiredEvent(p)) {
          ids.add(p.planId);
        }
      } catch {
        // malformed → skip
      }
    }
    return ids;
  } finally {
    db.close();
  }
}

interface FireOnce {
  dataDir: string;
  ctx: DaemonContext;
  /**
   * Working directory passed to the SDK / asserted clean before execute
   * fires. Derived from the candidate's brain.repo (rootPath joined with
   * monorepoPath) — or the test override on PlanExecutorOptions.repoRoot.
   */
  cwd: string;
  transport?: RunAgentTransport;
}

/**
 * Resolve the SDK cwd for a candidate plan from its app's brain. Returns
 * null when the brain doesn't exist, fails to parse, or has no `repo`
 * field — those apps are not enabled for auto-fire.
 */
export function resolveAppCwd(
  dataDir: string,
  vault: string,
  app: string,
): string | null {
  let brain;
  try {
    brain = loadBrain(brainFile(dataDir, vault, app));
  } catch {
    return null;
  }
  if (!brain.repo) return null;
  const root = brain.repo.rootPath;
  const sub = brain.repo.monorepoPath;
  return sub ? path.join(root, sub) : root;
}

async function fireDeveloper(
  record: PlanRecord,
  fire: FireOnce,
  resume = false,
): Promise<FiredPayload> {
  const planId = record.id;
  const app = record.app;
  const mode = detectDeveloperMode(record.plan);
  if (mode === null) {
    return {
      planId,
      app,
      mode: "not-runnable",
      reason: `type=${record.plan.metadata.type}, status=${record.plan.metadata.status}`,
    };
  }

  const start = Date.now();
  try {
    if (mode === "draft-impl") {
      const result = await draftImplementationPlan({
        parentPlanId: planId,
        app,
        vault: record.vault,
        dataDir: fire.dataDir,
        repoRoot: fire.cwd,
        ...(fire.transport !== undefined && { transport: fire.transport }),
      });
      return {
        planId,
        app,
        mode: "draft-impl",
        durationMs: Date.now() - start,
        result: {
          implPlanId: result.planId,
          numTurns: result.numTurns,
        },
      };
    }
    const result = await executePlan({
      planId,
      app,
      vault: record.vault,
      dataDir: fire.dataDir,
      repoRoot: fire.cwd,
      resume,
      ...(fire.transport !== undefined && { transport: fire.transport }),
    });

    // On a successful execute (Developer opened a PR), return the local
    // checkout to `main` so the operator's shell doesn't sit on the feature
    // branch. Failures here are non-fatal — the PR is open regardless.
    if (result.done && result.prUrl !== undefined) {
      try {
        execSync("git checkout main", {
          cwd: fire.cwd,
          stdio: "pipe",
        });
        fire.ctx.logger.info("plan-executor: checked out main after success", {
          planId,
          cwd: fire.cwd,
        });
      } catch (err) {
        fire.ctx.logger.error(
          "plan-executor: failed to checkout main after success",
          err,
          {
            planId,
            cwd: fire.cwd,
          },
        );
      }
    }

    return {
      planId,
      app,
      mode: "execute",
      durationMs: Date.now() - start,
      result: {
        done: result.done,
        blocked: result.blocked,
        amended: result.amended,
        numTurns: result.numTurns,
        subtype: result.subtype,
        resume,
        ...(result.branch !== undefined && { branch: result.branch }),
        ...(result.prUrl !== undefined && { prUrl: result.prUrl }),
        ...(result.amendmentReason !== undefined && {
          amendmentReason: result.amendmentReason,
        }),
      },
    };
  } catch (err) {
    if (err instanceof RateLimitedError) {
      const reset = err.resetsAt ? err.resetsAt.toISOString() : "unknown";
      fire.ctx.logger.error(
        "plan-executor: rate limit hit on Claude Code subscription",
        err,
        {
          planId,
          mode,
          rateLimitType: err.rateLimitType ?? "unknown",
          resetsAt: reset,
        },
      );
      recordEscalation(dbFile(fire.dataDir), {
        kind: "rate-limit",
        severity: "high",
        summary: `Claude Code subscription rate limit hit during ${mode} fire on ${planId}`,
        detail: `rate limit type: ${err.rateLimitType ?? "unknown"}\nresets at: ${reset}\nplan execution paused; will resume after the window expires.`,
        planId,
        app,
      });
      return {
        planId,
        app,
        mode,
        reason: `RATE_LIMITED: ${err.rateLimitType ?? "unknown"} resets at ${reset}`,
        durationMs: Date.now() - start,
      };
    }
    if (err instanceof CashInGateViolatedError) {
      // Developer made a commit but kept running other tools instead of
      // immediately pushing + opening the PR. The runtime interrupted the
      // SDK query. Surface as BLOCKED so the refusal-aware filter treats
      // it as recoverable — the user can manually push + open the PR for
      // the partial work, then re-fire the plan if needed.
      fire.ctx.logger.error(
        "plan-executor: cash-in-commit-early gate violated",
        err,
        { planId, mode, postCommitBashCount: err.postCommitBashCount },
      );
      recordEscalation(dbFile(fire.dataDir), {
        kind: "cash-in-violation",
        severity: "critical",
        summary: `Cash-in gate fired on ${planId} — partial commit on disk needs manual salvage`,
        detail: `Developer committed but exceeded the ${err.postCommitBashCount}-call post-commit bash budget without pushing or opening a PR.\nThe runtime interrupted the SDK query.\nSalvage steps: cd into the app repo, push the branch, then open the PR by hand. After that, re-fire the plan if needed.`,
        planId,
        app,
      });
      return {
        planId,
        app,
        mode,
        reason: `BLOCKED: cash-in-gate (${err.postCommitBashCount} bash calls after commit without push) — salvage the partial branch by hand`,
        durationMs: Date.now() - start,
      };
    }
    const message =
      err instanceof DeveloperError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    fire.ctx.logger.error("plan-executor: developer fire failed", err, {
      planId,
      mode,
    });
    return {
      planId,
      app,
      mode,
      reason: `error: ${message}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Module-level serial queue for `execute`-mode fires. Each execute fire is
 * chained onto this promise so fires that arrive within the same event-loop
 * tick (or from rapid ticks) never run concurrently. Errors inside a fire are
 * caught by `runExecute` and never break the chain.
 *
 * `draft-impl` fires bypass the queue because they do not touch the git tree.
 */
let executeQueue: Promise<void> = Promise.resolve();

/**
 * Wraps a single execute fire with:
 * 1. `assertCleanMain` — hard gate: abort if tree is dirty or HEAD is not main.
 * 2. Error isolation — any thrown error is caught and resolved so the queue
 *    continues processing subsequent fires.
 *
 * Returns the FiredPayload (including the error reason when the gate or fire
 * throws).
 */
async function runExecute(
  record: PlanRecord,
  fire: FireOnce,
): Promise<FiredPayload> {
  // Amendment resume runs from the saved branch with a deliberately
  // dirty tree — the previous execution stopped mid-flight and we're
  // picking up where it left off. The clean-tree gate would reject
  // that state, so skip it for resume fires.
  const resume = isAmendmentResume(record.id, fire.dataDir);
  if (!resume) {
    try {
      assertCleanMain(fire.cwd);
    } catch (err) {
      const message =
        err instanceof DeveloperError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      fire.ctx.logger.error(
        "plan-executor: assertCleanMain blocked execute fire",
        err,
        { planId: record.id },
      );
      return {
        planId: record.id,
        app: record.app,
        mode: "execute",
        reason: `BLOCKED: ${message}`,
      };
    }
  }
  return fireDeveloper(record, fire, resume);
}

export interface TickInput {
  dataDir: string;
  ctx: DaemonContext;
  /**
   * Override repo root for ALL fires this tick (test fixture path). When
   * unset, each fire's cwd is resolved per-app from the brain.
   */
  repoRoot?: string;
  /** Daily UTC cap on `agent-call` events. Default 150. See §18. */
  dailyCallCap?: number;
  /** Test injection — overrides the SDK transport for every Developer fire. */
  transport?: RunAgentTransport;
}

export interface TickResult {
  fired: FiredPayload[];
  skipped: Array<{ planId: string; reason: string }>;
}

function buildFireOnce(input: TickInput, cwd: string): FireOnce {
  const base: FireOnce = {
    dataDir: input.dataDir,
    ctx: input.ctx,
    cwd,
  };
  if (input.transport !== undefined) {
    base.transport = input.transport;
  }
  return base;
}

/**
 * One tick: scans approved plans that haven't been fired yet and fires
 * Developer on each. Records a plan-executor-fired event before the call so a
 * mid-fire crash doesn't double-fire on restart (the user can manually
 * re-fire via `yarn jarvis run developer <id>`).
 *
 * Execute-mode fires are serialised through `executeQueue`. Draft-impl fires
 * run immediately (they don't touch the git tree).
 */
export async function runPlanExecutorTick(
  input: TickInput,
): Promise<TickResult> {
  const fired: FiredPayload[] = [];
  const skipped: Array<{ planId: string; reason: string }> = [];

  // Run recovery sweeps at the top of every tick so a single tick surfaces
  // and re-enables all three stall patterns before the daily-cap gate.
  recoverOrphanedClaims(dbFile(input.dataDir), input.ctx.logger);
  recoverStaleExecuting(dbFile(input.dataDir), input.ctx.logger);

  // Daily cap gate. If today's UTC call count is at or over the cap,
  // skip *all* fires for this tick. Resumes automatically at 00:00 UTC.
  const dailyCap = input.dailyCallCap ?? DEFAULT_DAILY_CALL_CAP;
  const todayCount = readTodayCallCount(dbFile(input.dataDir));
  if (todayCount >= dailyCap) {
    input.ctx.logger.info(
      "plan-executor: daily cap reached, deferring all fires until 00:00 UTC",
      { todayCount, cap: dailyCap },
    );
    return { fired, skipped };
  }

  const alreadyFired = readFiredPlanIds(dbFile(input.dataDir));
  const candidates = listPlans(input.dataDir).filter(
    (r) =>
      r.plan.metadata.status === "approved" &&
      !alreadyFired.has(r.id),
  );

  for (const candidate of candidates) {
    // Resolve the cwd for this app. Test override > brain.repo lookup.
    // Apps without a populated `brain.repo` are skipped — they were never
    // onboarded with a code-repo path, so Developer has nowhere to run.
    const cwd =
      input.repoRoot ??
      resolveAppCwd(input.dataDir, candidate.vault, candidate.app);
    if (cwd === null) {
      const payload: FiredPayload = {
        planId: candidate.id,
        app: candidate.app,
        mode: "skipped",
        reason: `no brain.repo configured for app "${candidate.app}" — re-onboard with --repo to enable auto-fire`,
      };
      writeFiredEvent(input.dataDir, candidate, payload);
      skipped.push({ planId: candidate.id, reason: payload.reason ?? "" });
      continue;
    }

    const mode = detectDeveloperMode(candidate.plan);

    // Claim the work BEFORE the fire, so a mid-fire crash doesn't re-fire.
    writeFiredEvent(input.dataDir, candidate, {
      planId: candidate.id,
      app: candidate.app,
      mode: "skipped",
      reason: "claimed; result pending",
    });

    const fire = buildFireOnce(input, cwd);

    if (mode === "execute") {
      // Serialise execute fires through the module-level queue so concurrent
      // ticks never run two execute fires at the same time.
      const capturedCandidate = candidate;
      const capturedFire = fire;
      const firedRef: FiredPayload[] = fired;
      const dataDirRef = input.dataDir;
      executeQueue = executeQueue.then(async () => {
        let payload = await runExecute(capturedCandidate, capturedFire);

        // done:false hook: Developer finished without a DONE/BLOCKED/AMEND
        // marker. Retry up to 2 times (transition back to approved); on the
        // third done:false permanently block the plan.
        const result = payload.result as Record<string, unknown> | undefined;
        if (
          payload.mode === "execute" &&
          result?.done === false &&
          !result?.blocked &&
          result?.subtype === "success"
        ) {
          const db = new Database(dbFile(dataDirRef));
          const attempts = countDoneFalseAttempts(db, capturedCandidate.id);
          db.close();
          const attemptN = attempts + 1;
          if (attempts < 2) {
            payload = {
              ...payload,
              reason: `BLOCKED: done=false attempt ${attemptN} — queued for resume`,
            };
            const record = findPlan(dataDirRef, capturedCandidate.id);
            if (record && record.plan.metadata.status === "executing") {
              applyPlanTransition(dataDirRef, record, "approved", "plan-executor", `done=false attempt ${attemptN}`);
            }
            capturedFire.ctx.logger.info("plan-executor: done=false — queued for resume", {
              planId: capturedCandidate.id,
              attemptN,
            });
          } else {
            payload = {
              ...payload,
              reason: `developer returned done=false after ${attemptN} attempts — manual intervention required`,
            };
            const record = findPlan(dataDirRef, capturedCandidate.id);
            if (record && record.plan.metadata.status === "executing") {
              applyPlanTransition(dataDirRef, record, "blocked", "plan-executor", "done=false max attempts");
            }
            capturedFire.ctx.logger.info("plan-executor: done=false — blocking after max attempts", {
              planId: capturedCandidate.id,
              attemptN,
            });
          }
        }

        writeFiredEvent(dataDirRef, capturedCandidate, payload);

        // For retry cases, also write a claim-recovered event so the plan
        // re-enters eligibility on this tick's readFiredPlanIds pass rather
        // than waiting for the next tick's orphan sweep.
        if (
          typeof payload.reason === "string" &&
          payload.reason.startsWith("BLOCKED: done=false")
        ) {
          writeFiredEvent(dataDirRef, capturedCandidate, {
            planId: capturedCandidate.id,
            app: capturedCandidate.app,
            mode: "claim-recovered",
            reason: payload.reason,
          });
        }

        firedRef.push(payload);
      });
      // Await the queue so the tick result includes this fire's outcome.
      await executeQueue;
    } else {
      // draft-impl and not-runnable bypass the execute queue.
      const payload = await fireDeveloper(candidate, fire);
      writeFiredEvent(input.dataDir, candidate, payload);
      fired.push(payload);
    }
  }

  return { fired, skipped };
}

function writeFiredEvent(
  dataDir: string,
  record: PlanRecord,
  payload: FiredPayload,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: record.app,
      vaultId: record.vault,
      kind: "plan-executor-fired",
      payload,
    });
  } finally {
    db.close();
  }
}

/** DaemonService wrapper around runPlanExecutorTick. */
export function createPlanExecutorService(
  opts: PlanExecutorOptions,
): DaemonService {
  let timer: NodeJS.Timeout | null = null;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;

  // Guards against overlapping ticks: if a tick is still running when the
  // interval fires again, the new interval callback returns immediately.
  // The flag is always reset in a `finally` block so a thrown/rejected tick
  // never permanently stalls the executor.
  let tickInFlight = false;

  return {
    name: "plan-executor",
    start(ctx: DaemonContext): void {
      recoverOrphanedClaims(dbFile(opts.dataDir), ctx.logger);
      recoverStaleExecuting(dbFile(opts.dataDir), ctx.logger);

      const tickFn = async (): Promise<void> => {
        if (tickInFlight) {
          return;
        }
        tickInFlight = true;
        try {
          // When a test-only tick body is injected, use it directly.
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          // Developer authenticates via the local `claude` CLI (~/.claude),
          // not via an API key, so the daemon doesn't need to gate on
          // ANTHROPIC_API_KEY any more. If `claude` isn't installed or
          // authenticated, the SDK call inside Developer's runAgent will
          // fail at fire time with a clear error.
          const tickInput: TickInput = {
            dataDir: opts.dataDir,
            ctx,
          };
          if (opts.repoRoot !== undefined) {
            tickInput.repoRoot = opts.repoRoot;
          }
          if (opts.transport !== undefined) {
            tickInput.transport = opts.transport;
          }
          if (opts.dailyCallCap !== undefined) {
            tickInput.dailyCallCap = opts.dailyCallCap;
          }
          const result = await runPlanExecutorTick(tickInput);
          if (result.fired.length > 0) {
            ctx.logger.info("plan-executor: fired", {
              count: result.fired.length,
              fires: result.fired.map((f) => ({
                planId: f.planId,
                mode: f.mode,
              })),
            });
          }
          if (result.skipped.length > 0) {
            ctx.logger.info("plan-executor: skipped", {
              count: result.skipped.length,
            });
          }
        } catch (err) {
          ctx.logger.error("plan-executor tick errored", err);
        } finally {
          tickInFlight = false;
        }
      };

      void tickFn(); // initial fire
      timer = setInterval(() => void tickFn(), tickMs);
      timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
