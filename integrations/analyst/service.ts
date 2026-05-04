import path from "node:path";
import {
  autoDraftFromSignals,
  runAnalystScan,
} from "../../agents/analyst.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import brokenLinksCollector from "../../tools/scanners/broken-links.ts";
import contentFreshnessCollector from "../../tools/scanners/content-freshness.ts";
import yarnAuditCollector from "../../tools/scanners/yarn-audit.ts";
import type {
  CollectorContext,
  SignalCollector,
  SignalSeverity,
} from "../../tools/scanners/types.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Default scanner set the daemon's analyst-tick runs against every app
 * with `brain.repo` configured. Adding a new collector here makes it
 * part of the hourly sweep automatically. Manual invocation still uses
 * the same set via `yarn jarvis scan` (see cli/commands/scan.ts).
 */
const DEFAULT_COLLECTORS: ReadonlyArray<SignalCollector> = [
  yarnAuditCollector,
  brokenLinksCollector,
  contentFreshnessCollector,
];

const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour

export interface AnalystServiceOptions {
  dataDir: string;
  /** Tick interval. Default 1 hour. */
  tickMs?: number;
  /** Override the collectors run on each tick (test seam). */
  collectors?: ReadonlyArray<SignalCollector>;
  /**
   * Severity threshold for auto-drafting. Default `critical`. Set to
   * `null` to disable auto-drafting entirely; the sweep will still
   * record signals but never call Strategist.
   */
  autoDraftThreshold?: SignalSeverity | null;
  /** Override the SDK client used for auto-drafting (test seam). */
  buildAnthropicClient?: () => AnthropicClient;
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
  const autoDraftThreshold =
    opts.autoDraftThreshold === undefined ? "critical" : opts.autoDraftThreshold;
  let lazyClient: AnthropicClient | null = null;
  const getClient = (): AnthropicClient => {
    if (!lazyClient) {
      lazyClient = opts.buildAnthropicClient
        ? opts.buildAnthropicClient()
        : createSdkClient();
    }
    return lazyClient;
  };

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
            ...(autoDraftThreshold !== null && {
              autoDraft: {
                threshold: autoDraftThreshold,
                getClient,
              },
            }),
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
  /**
   * Enable auto-draft hand-off. When set, signals at or above the
   * threshold get handed to Strategist for a plan draft. Idempotent on
   * `signal.dedupKey`. Omit to disable auto-drafting (signals are still
   * recorded in the event log).
   */
  autoDraft?: {
    threshold: SignalSeverity;
    getClient: () => AnthropicClient;
  };
}

export interface AnalystTickResult {
  scannedApps: number;
  skippedApps: number;
  totalSignals: number;
  /** Plans Analyst auto-drafted on this tick (across all apps). */
  autoDraftedPlanIds: string[];
  perApp: Array<{
    vault: string;
    app: string;
    cwd?: string;
    signalCount: number;
    autoDraftedCount?: number;
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
    autoDraftedPlanIds: [],
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

      let autoDraftedCount = 0;
      if (input.autoDraft && scan.signals.length > 0) {
        const draft = await autoDraftFromSignals({
          signals: scan.signals,
          app,
          vault,
          dataDir: input.dataDir,
          client: input.autoDraft.getClient(),
          severityThreshold: input.autoDraft.threshold,
        });
        autoDraftedCount = draft.draftedCount;
        for (const e of draft.entries) {
          if (e.planId) result.autoDraftedPlanIds.push(e.planId);
        }
        if (draft.errorCount > 0) {
          input.ctx.logger.error(
            "analyst: auto-draft errors",
            new Error(`${draft.errorCount} signal(s) failed to draft`),
            { app, errorCount: draft.errorCount },
          );
        }
      }

      result.perApp.push({
        vault,
        app,
        cwd,
        signalCount: scan.signals.length,
        ...(autoDraftedCount > 0 && { autoDraftedCount }),
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
      autoDraftedPlans: result.autoDraftedPlanIds.length,
    });
  }

  return result;
}
