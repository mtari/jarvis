import Database from "better-sqlite3";
import {
  draftMetaPlansFromScan,
  runLearnScan,
  DEFAULT_DRAFT_THRESHOLD,
  type DraftMetaPlansFromScanResult,
} from "../../agents/analyst-learn.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { dbFile } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Daemon service: runs Analyst's learning loop on a recurring cadence
 * (default weekly per §16). On each tick:
 *
 *   1. Check the most recent `learn-scan-completed` event. Skip if it
 *      fired within the last `minIntervalMs` (default 7 days).
 *   2. Run `learn scan` to surface recent themes / low-approval buckets.
 *   3. If `autoDraft` is on, call Strategist per finding above
 *      `draftThreshold`. Idempotent across runs via the existing
 *      14-day `learn-meta-drafted` window in `draftMetaPlansFromScan`.
 *
 * Mirrors the analyst-tick pattern: `tickInFlight` guard, `_tickBody`
 * test seam, error-isolated so a bad finding doesn't blackhole the
 * service. Lazy client — only instantiated when autoDraft fires.
 */

/** Service tick frequency. The minimum interval between scans is
 * decoupled (so the polling tick can be more frequent than the scan
 * cadence and still not over-scan). Default tick: 6 hours. */
const DEFAULT_TICK_MS = 6 * 60 * 60 * 1000;

/** Minimum gap between actual scans. Default: 7 days (§16 weekly). */
const DEFAULT_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LearnTickServiceOptions {
  dataDir: string;
  /** Tick interval — how often to wake up and check. Default 6h. */
  tickMs?: number;
  /**
   * Minimum gap between actual scans. The tick wakes more often than
   * this; if a scan has run within this window, the tick is a no-op.
   * Default 7 days.
   */
  minIntervalMs?: number;
  /** Run draftMetaPlansFromScan after the scan. Default true. */
  autoDraft?: boolean;
  /** Threshold passed to drafter. Default DEFAULT_DRAFT_THRESHOLD (5). */
  draftThreshold?: number;
  /** Cap on drafts per tick. Default 5. */
  maxDrafts?: number;
  /** Override the SDK client (test seam). */
  buildAnthropicClient?: () => AnthropicClient;
  /** Test seam — fixed clock. */
  now?: () => Date;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

export function createLearnTickService(
  opts: LearnTickServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const autoDraft = opts.autoDraft ?? true;
  const draftThreshold = opts.draftThreshold ?? DEFAULT_DRAFT_THRESHOLD;
  const maxDrafts = opts.maxDrafts ?? 5;

  let lazyClient: AnthropicClient | null = null;
  const getClient = (): AnthropicClient => {
    if (!lazyClient) {
      lazyClient = opts.buildAnthropicClient
        ? opts.buildAnthropicClient()
        : createSdkClient();
    }
    return lazyClient;
  };

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  return {
    name: "learn-tick",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          await runLearnTick({
            dataDir: opts.dataDir,
            ctx,
            minIntervalMs,
            autoDraft,
            draftThreshold,
            maxDrafts,
            getClient,
            ...(opts.now !== undefined && { now: opts.now() }),
          });
        } catch (err) {
          ctx.logger.error("learn-tick errored", err);
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

export interface RunLearnTickInput {
  dataDir: string;
  ctx: DaemonContext;
  minIntervalMs: number;
  autoDraft: boolean;
  draftThreshold: number;
  maxDrafts: number;
  getClient: () => AnthropicClient;
  now?: Date;
}

export interface LearnTickResult {
  /** True when the tick actually scanned (vs skipped due to recency). */
  scanned: boolean;
  /** Number of feedback rows the scan saw, when scanned. */
  scannedFeedbackRows?: number;
  /** Drafts produced this tick, when autoDraft + scanned. */
  drafted: number;
  skipped: number;
  errors: number;
  /** Reason for skip when not scanned. */
  skipReason?: "recent-scan";
}

/**
 * The tick body — exported for direct invocation in tests. Reads the
 * most recent learn-scan-completed event timestamp; runs scan + draft
 * when the window has elapsed, otherwise no-ops.
 */
export async function runLearnTick(
  input: RunLearnTickInput,
): Promise<LearnTickResult> {
  const now = input.now ?? new Date();
  const lastScanIso = readLastScanTime(input.dataDir);
  if (lastScanIso !== null) {
    const elapsedMs = now.getTime() - new Date(lastScanIso).getTime();
    if (elapsedMs < input.minIntervalMs) {
      return {
        scanned: false,
        drafted: 0,
        skipped: 0,
        errors: 0,
        skipReason: "recent-scan",
      };
    }
  }

  const report = runLearnScan({
    dataDir: input.dataDir,
    ...(input.now !== undefined && { now: input.now }),
  });
  input.ctx.logger.info("learn-tick scan", {
    scannedFeedbackRows: report.scannedFeedbackRows,
    rejectionThemes: report.rejectionThemes.length,
    reviseThemes: report.reviseThemes.length,
    lowApprovalRates: report.lowApprovalRates.length,
    recommendations: report.recommendations.length,
  });

  if (!input.autoDraft) {
    return {
      scanned: true,
      scannedFeedbackRows: report.scannedFeedbackRows,
      drafted: 0,
      skipped: 0,
      errors: 0,
    };
  }

  let draftResult: DraftMetaPlansFromScanResult;
  try {
    draftResult = await draftMetaPlansFromScan({
      dataDir: input.dataDir,
      client: input.getClient(),
      report,
      threshold: input.draftThreshold,
      maxDrafts: input.maxDrafts,
      ...(input.now !== undefined && { now: input.now }),
    });
  } catch (err) {
    input.ctx.logger.error("learn-tick draft failed", err);
    return {
      scanned: true,
      scannedFeedbackRows: report.scannedFeedbackRows,
      drafted: 0,
      skipped: 0,
      errors: 1,
    };
  }

  if (
    draftResult.drafted.length > 0 ||
    draftResult.errors.length > 0 ||
    draftResult.skipped.length > 0
  ) {
    input.ctx.logger.info("learn-tick draft", {
      drafted: draftResult.drafted.map((d) => d.planId),
      skipped: draftResult.skipped.length,
      errors: draftResult.errors.length,
    });
  }

  return {
    scanned: true,
    scannedFeedbackRows: report.scannedFeedbackRows,
    drafted: draftResult.drafted.length,
    skipped: draftResult.skipped.length,
    errors: draftResult.errors.length,
  };
}

/**
 * Returns the ISO timestamp of the most recent learn-scan-completed
 * event, or null when none exists.
 */
function readLastScanTime(dataDir: string): string | null {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT created_at FROM events WHERE kind = 'learn-scan-completed' ORDER BY id DESC LIMIT 1",
      )
      .get() as { created_at?: string } | undefined;
    return row?.created_at ?? null;
  } finally {
    db.close();
  }
}
