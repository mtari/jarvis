import path from "node:path";
import { runAnalystScan } from "../../agents/analyst.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import yarnAuditCollector from "../../tools/scanners/yarn-audit.ts";
import type {
  CollectorContext,
  SignalCollector,
} from "../../tools/scanners/types.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Default scanner set the daemon's analyst-tick runs against every app
 * with `brain.repo` configured. Adding a new collector here makes it
 * part of the hourly sweep automatically. Manual invocation still uses
 * the same set via `yarn jarvis scan` (see cli/commands/scan.ts).
 */
const DEFAULT_COLLECTORS: ReadonlyArray<SignalCollector> = [yarnAuditCollector];

const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour

export interface AnalystServiceOptions {
  dataDir: string;
  /** Tick interval. Default 1 hour. */
  tickMs?: number;
  /** Override the collectors run on each tick (test seam). */
  collectors?: ReadonlyArray<SignalCollector>;
  /**
   * Override the tick body for testing — replaces the per-tick scan
   * loop with a custom function.
   *
   * @internal — not part of the public API.
   */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

/**
 * Hourly signal-collection sweep. For every app in the data dir whose
 * brain has `repo` configured, runs the registered collectors and
 * records resulting signals as `signal` events in the SQLite event log.
 *
 * Apps without `brain.repo` are skipped (Developer wouldn't be able to
 * fire on them anyway). Collectors that throw are recorded in the
 * per-collector summary; the sweep continues with the next collector.
 *
 * Mirrors the plan-executor service pattern: tickInFlight guard,
 * `_tickBody` test seam, error-isolation per-app so one broken brain
 * can't blackhole the whole sweep.
 */
export function createAnalystService(
  opts: AnalystServiceOptions,
): DaemonService {
  let timer: NodeJS.Timeout | null = null;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const collectors = opts.collectors ?? DEFAULT_COLLECTORS;

  // Guards against overlapping ticks: if the prior sweep is still in
  // flight when setInterval fires again, the new callback returns
  // immediately. Flag reset in `finally` so a thrown sweep never
  // permanently stalls the service.
  let tickInFlight = false;

  return {
    name: "analyst",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          await runAnalystTick({
            dataDir: opts.dataDir,
            collectors,
            ctx,
          });
        } catch (err) {
          ctx.logger.error("analyst tick errored", err);
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

export interface AnalystTickInput {
  dataDir: string;
  collectors: ReadonlyArray<SignalCollector>;
  ctx: DaemonContext;
}

export interface AnalystTickResult {
  scannedApps: number;
  skippedApps: number;
  totalSignals: number;
  perApp: Array<{
    vault: string;
    app: string;
    cwd?: string;
    signalCount: number;
    error?: string;
  }>;
}

/**
 * One sweep across every onboarded app. Exported for direct invocation
 * from tests + future "yarn jarvis scan-all" command if we want one.
 */
export async function runAnalystTick(
  input: AnalystTickInput,
): Promise<AnalystTickResult> {
  const apps = listOnboardedApps(input.dataDir);
  const result: AnalystTickResult = {
    scannedApps: 0,
    skippedApps: 0,
    totalSignals: 0,
    perApp: [],
  };

  for (const { vault, app, brain } of apps) {
    if (!brain.repo) {
      result.skippedApps += 1;
      result.perApp.push({
        vault,
        app,
        signalCount: 0,
        error: "no brain.repo configured",
      });
      continue;
    }
    const cwd = brain.repo.monorepoPath
      ? path.join(brain.repo.rootPath, brain.repo.monorepoPath)
      : brain.repo.rootPath;
    const ctx: CollectorContext = { cwd, app };

    try {
      const scan = await runAnalystScan({
        dataDir: input.dataDir,
        app,
        vault,
        ctx,
        collectors: input.collectors,
      });
      result.scannedApps += 1;
      result.totalSignals += scan.signals.length;
      result.perApp.push({
        vault,
        app,
        cwd,
        signalCount: scan.signals.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.skippedApps += 1;
      result.perApp.push({
        vault,
        app,
        cwd,
        signalCount: 0,
        error: `scan failed: ${message}`,
      });
    }
  }

  if (result.scannedApps > 0 || result.skippedApps > 0) {
    input.ctx.logger.info("analyst: sweep complete", {
      scannedApps: result.scannedApps,
      skippedApps: result.skippedApps,
      totalSignals: result.totalSignals,
    });
  }

  return result;
}
