import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  detectDeveloperMode,
  draftImplementationPlan,
  DeveloperError,
  executePlan,
} from "../../agents/developer.ts";
import {
  createAnthropicClient,
  type AnthropicClient,
} from "../../orchestrator/anthropic-client.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { listPlans, type PlanRecord } from "../../orchestrator/plan-store.ts";
import { dbFile } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

const DEFAULT_TICK_MS = 30_000;

export interface PlanExecutorOptions {
  dataDir: string;
  /** Tick interval for the auto-fire scan. Default 30s. */
  tickMs?: number;
  /** Lazy client builder; defaults to createAnthropicClient(). */
  buildAnthropicClient?: () => AnthropicClient;
  /** Apps the executor will fire Developer for. Default: ["jarvis"] until multi-repo lands. */
  enabledApps?: ReadonlyArray<string>;
  /** Override repo root for assertCleanMain (tests inject a fixture repo). */
  repoRoot?: string;
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
  client: AnthropicClient;
  dataDir: string;
  ctx: DaemonContext;
  repoRoot?: string;
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

  const recorder = buildAgentCallRecorder(fire.client, dbFile(fire.dataDir), {
    app,
    vault: record.vault,
    agent: "developer",
    planId,
  });

  const start = Date.now();
  try {
    if (mode === "draft-impl") {
      const result = await draftImplementationPlan({
        client: recorder.client,
        parentPlanId: planId,
        app,
        vault: record.vault,
        dataDir: fire.dataDir,
      });
      recorder.ctx.planId = result.planId;
      recorder.flush();
      return {
        planId,
        app,
        mode: "draft-impl",
        durationMs: Date.now() - start,
        result: {
          implPlanId: result.planId,
          iterations: result.iterations,
        },
      };
    }
    const result = await executePlan({
      client: recorder.client,
      planId,
      app,
      vault: record.vault,
      dataDir: fire.dataDir,
      ...(fire.repoRoot !== undefined && { repoRoot: fire.repoRoot }),
    });
    recorder.flush();
    return {
      planId,
      app,
      mode: "execute",
      durationMs: Date.now() - start,
      result: {
        done: result.done,
        blocked: result.blocked,
        iterations: result.iterations,
        toolCalls: result.toolCallCount,
        ...(result.branch !== undefined && { branch: result.branch }),
        ...(result.prUrl !== undefined && { prUrl: result.prUrl }),
      },
    };
  } catch (err) {
    recorder.flush();
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
  client: AnthropicClient;
  ctx: DaemonContext;
  /** Override repo root (tests inject a fixture path). */
  repoRoot?: string;
}

export interface TickResult {
  fired: FiredPayload[];
  skipped: Array<{ planId: string; reason: string }>;
}

function buildFireOnce(input: TickInput): FireOnce {
  const base: FireOnce = {
    client: input.client,
    dataDir: input.dataDir,
    ctx: input.ctx,
  };
  if (input.repoRoot !== undefined) {
    base.repoRoot = input.repoRoot;
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
  let lazyClient: AnthropicClient | null = null;
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
          // When a test-only tick body is injected, use it directly and skip
          // the API-key check and client setup below.
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          // Lazy-build the Anthropic client so the daemon can boot when the
          // API key is missing — the auto-fire just won't have anything to do.
          if (!process.env["ANTHROPIC_API_KEY"]) {
            return;
          }
          if (!lazyClient) {
            lazyClient = opts.buildAnthropicClient
              ? opts.buildAnthropicClient()
              : createAnthropicClient();
          }
          const tickInput: TickInput = {
            dataDir: opts.dataDir,
            enabledApps,
            client: lazyClient,
            ctx,
          };
          if (opts.repoRoot !== undefined) {
            tickInput.repoRoot = opts.repoRoot;
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
      lazyClient = null;
    },
  };
}
