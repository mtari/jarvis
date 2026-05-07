import {
  runFridayAudit,
  type FridayAuditResult,
} from "../../agents/strategist-friday-audit.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import type {
  DaemonContext,
  DaemonService,
} from "../../cli/commands/daemon.ts";

/**
 * Daemon service: runs the Strategist Friday self-audit on a recurring
 * cadence. Tick is hourly; the audit's own gates (day-of-week,
 * throughput, idempotency) keep it a no-op outside its window. Mirrors
 * the learn-tick pattern: `tickInFlight` guard, `_tickBody` test seam,
 * lazy AnthropicClient.
 */

/** Tick interval. The audit's own day-of-week + idempotency gates keep
 * the service quiet outside Fridays. */
const DEFAULT_TICK_MS = 60 * 60 * 1000;

export interface FridayAuditServiceOptions {
  dataDir: string;
  tickMs?: number;
  /** Override for the SDK client (test seam). */
  buildAnthropicClient?: () => AnthropicClient;
  /** Test seam — fixed clock. */
  now?: () => Date;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

export function createFridayAuditService(
  opts: FridayAuditServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;

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
    name: "friday-audit",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          const result = await runFridayAudit({
            dataDir: opts.dataDir,
            client: getClient(),
            ...(opts.now !== undefined && { now: opts.now() }),
          });
          logResult(ctx, result);
        } catch (err) {
          ctx.logger.error("friday-audit errored", err);
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

function logResult(ctx: DaemonContext, result: FridayAuditResult): void {
  if (!result.ran) {
    // Silent on the common skip paths to keep the daemon log clean.
    if (
      result.skipReason === "not-friday" ||
      result.skipReason === "already-ran-recently"
    ) {
      return;
    }
    ctx.logger.info("friday-audit skipped", {
      reason: result.skipReason,
      backlogDepth: result.backlogDepth,
      projectShipments: result.projectShipments,
    });
    return;
  }
  ctx.logger.info("friday-audit ran", {
    drafted: result.drafted.map((d) => d.planId),
    errors: result.errors.length,
    backlogDepth: result.backlogDepth,
    projectShipments: result.projectShipments,
  });
}
