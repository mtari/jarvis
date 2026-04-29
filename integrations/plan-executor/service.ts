import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  detectDeveloperMode,
  draftImplementationPlan,
  DeveloperError,
  executePlan,
} from "../../agents/developer.ts";
import {
  RateLimitedError,
  type RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { listPlans, type PlanRecord } from "../../orchestrator/plan-store.ts";
import { readTodayCallCount } from "../../cli/commands/cost.ts";
import { dbFile } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_DAILY_CALL_CAP = 150;

export interface PlanExecutorOptions {
  dataDir: string;
  /** Tick interval for the auto-fire scan. Default 30s. */
  tickMs?: number;
  /** Apps the executor will fire Developer for. Default: ["jarvis"] until multi-repo lands. */
  enabledApps?: ReadonlyArray<string>;
  /** Override repo root for assertCleanMain (tests inject a fixture repo). */
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

const DEFAULT_ENABLED_APPS: ReadonlyArray<string> = ["jarvis"];

interface FiredPayload {
  planId: string;
  app: string;
  mode: "draft-impl" | "execute" | "not-runnable" | "skipped";
  reason?: string;
  result?: Record<string, unknown>;
  durationMs?: number;
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
 * Returns the set of plan ids that already have a `plan-executor-fired`
 * event recorded. Used to keep the auto-fire idempotent across ticks.
 */
export function readFiredPlanIds(dbFilePath: string): Set<string> {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'plan-executor-fired'",
      )
      .all() as Array<{ payload: string }>;
    const ids = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as FiredPayload;
        if (p.planId) ids.add(p.planId);
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
  repoRoot?: string;
  transport?: RunAgentTransport;
}

async function fireDeveloper(
  record: PlanRecord,
  fire: FireOnce,
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
      ...(fire.repoRoot !== undefined && { repoRoot: fire.repoRoot }),
      ...(fire.transport !== undefined && { transport: fire.transport }),
    });
    return {
      planId,
      app,
      mode: "execute",
      durationMs: Date.now() - start,
      result: {
        done: result.done,
        blocked: result.blocked,
        numTurns: result.numTurns,
        subtype: result.subtype,
        ...(result.branch !== undefined && { branch: result.branch }),
        ...(result.prUrl !== undefined && { prUrl: result.prUrl }),
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
      return {
        planId,
        app,
        mode,
        reason: `RATE_LIMITED: ${err.rateLimitType ?? "unknown"} resets at ${reset}`,
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
  try {
    assertCleanMain(fire.repoRoot);
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
  return fireDeveloper(record, fire);
}

export interface TickInput {
  dataDir: string;
  enabledApps: ReadonlyArray<string>;
  ctx: DaemonContext;
  /** Override repo root (tests inject a fixture path). */
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

function buildFireOnce(input: TickInput): FireOnce {
  const base: FireOnce = {
    dataDir: input.dataDir,
    ctx: input.ctx,
  };
  if (input.repoRoot !== undefined) {
    base.repoRoot = input.repoRoot;
  }
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
    const enabled = input.enabledApps.includes(candidate.app);
    if (!enabled) {
      const payload: FiredPayload = {
        planId: candidate.id,
        app: candidate.app,
        mode: "skipped",
        reason: `auto-fire only enabled for ${input.enabledApps.join(", ")} (Phase 1 limitation; multi-repo lands later)`,
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

    const fire = buildFireOnce(input);

    if (mode === "execute") {
      // Serialise execute fires through the module-level queue so concurrent
      // ticks never run two execute fires at the same time.
      const capturedCandidate = candidate;
      const capturedFire = fire;
      const firedRef: FiredPayload[] = fired;
      const dataDirRef = input.dataDir;
      executeQueue = executeQueue.then(async () => {
        const payload = await runExecute(capturedCandidate, capturedFire);
        writeFiredEvent(dataDirRef, capturedCandidate, payload);
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
  const enabledApps = opts.enabledApps ?? DEFAULT_ENABLED_APPS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;

  // Guards against overlapping ticks: if a tick is still running when the
  // interval fires again, the new interval callback returns immediately.
  // The flag is always reset in a `finally` block so a thrown/rejected tick
  // never permanently stalls the executor.
  let tickInFlight = false;

  return {
    name: "plan-executor",
    start(ctx: DaemonContext): void {
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
            enabledApps,
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
