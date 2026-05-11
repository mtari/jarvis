import { runProjectAudit } from "../../agents/strategist-project-audit.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import type {
  DaemonContext,
  DaemonService,
} from "../../cli/commands/daemon.ts";

/**
 * Daemon service: runs a daily Strategist project audit for every
 * non-jarvis onboarded app. Tick is hourly; each app's own 24h
 * idempotency gate enforces once-per-day. Mirrors createDailyAuditService.
 */

const DEFAULT_TICK_MS = 60 * 60 * 1000;

export interface ProjectAuditServiceOptions {
  dataDir: string;
  tickMs?: number;
  buildAnthropicClient?: () => AnthropicClient;
  now?: () => Date;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
  /** @internal — override listOnboardedApps for tests. */
  _listApps?: typeof listOnboardedApps;
}

export function createProjectAuditService(
  opts: ProjectAuditServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const getApps = opts._listApps ?? listOnboardedApps;

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
    name: "project-audit",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          const apps = getApps(opts.dataDir).filter(
            (a) => a.app !== "jarvis",
          );
          for (const { app, vault } of apps) {
            try {
              const result = await runProjectAudit({
                dataDir: opts.dataDir,
                app,
                vault,
                client: getClient(),
                ...(opts.now !== undefined && { now: opts.now() }),
              });
              logResult(ctx, app, result);
            } catch (err) {
              ctx.logger.error("project-audit app errored", err, { app });
            }
          }
        } catch (err) {
          ctx.logger.error("project-audit tick errored", err);
        } finally {
          tickInFlight = false;
        }
      };

      void tickFn();
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

function logResult(
  ctx: DaemonContext,
  app: string,
  result: { ran: boolean; skipReason?: string; drafted: { planId: string }[]; errors: string[] },
): void {
  if (!result.ran) {
    if (result.skipReason === "already-ran-recently") return;
    ctx.logger.info("project-audit skipped", { app, reason: result.skipReason });
    return;
  }
  ctx.logger.info("project-audit ran", {
    app,
    drafted: result.drafted.map((d) => d.planId),
    errors: result.errors.length,
  });
}
