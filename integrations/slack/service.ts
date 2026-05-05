import { App as BoltApp, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";
import {
  resolveChannels,
  type ResolvedChannels,
} from "./channel-resolver.ts";
import { registerHandlers } from "./handlers.ts";
import {
  runAlertTick,
  runSetupTaskDeliveryTick,
  runSurfaceTick,
  runTriageDeliveryTick,
  type AlertContext,
  type SurfaceContext,
} from "./surface.ts";
import type { SignalSeverity } from "../../tools/scanners/types.ts";

export interface SlackServiceOptions {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  inboxChannel: string;
  alertsChannel: string;
  dataDir: string;
  /** Tick interval for the auto-surface scan. Default 30s. */
  surfaceTickMs?: number;
  /**
   * Severity threshold for posting analyst signals to `#jarvis-alerts`.
   * Default `high` (alerts on `high` and `critical`). Set to `null` to
   * disable signal alerts entirely.
   */
  alertThreshold?: SignalSeverity | null;
  /**
   * Whether the surface tick should also deliver new triage reports
   * (`<dataDir>/triage/<YYYY-MM-DD>.md`) to `#jarvis-inbox`. Default
   * `true`. Set `false` to keep triage CLI-only.
   */
  triageDeliveryEnabled?: boolean;
  /**
   * Whether the surface tick should also deliver pending setup tasks
   * to `#jarvis-inbox`. Default `true`. Set `false` to keep setup
   * tasks CLI-only.
   */
  setupTaskDeliveryEnabled?: boolean;
  /** Allow tests to inject a fake client (skip the real Bolt connection). */
  buildBoltApp?: (opts: {
    botToken: string;
    appToken: string;
    signingSecret?: string;
  }) => BoltApp;
  buildAnthropicClient?: () => AnthropicClient;
}

const DEFAULT_SURFACE_TICK_MS = 30_000;

export function createSlackService(opts: SlackServiceOptions): DaemonService {
  let app: BoltApp | null = null;
  let webClient: WebClient | null = null;
  let channels: ResolvedChannels | null = null;
  let surfaceTimer: NodeJS.Timeout | null = null;
  let lazyClient: AnthropicClient | null = null;

  const surfaceCtxFor = (): SurfaceContext => {
    if (!channels) throw new Error("Slack channels not resolved yet");
    if (!webClient) throw new Error("Slack web client not available yet");
    return {
      dataDir: opts.dataDir,
      client: webClient,
      inboxChannelId: channels.inbox,
    };
  };

  const alertCtxFor = (): AlertContext => {
    if (!channels) throw new Error("Slack channels not resolved yet");
    if (!webClient) throw new Error("Slack web client not available yet");
    return {
      dataDir: opts.dataDir,
      client: webClient,
      inboxChannelId: channels.inbox,
      alertsChannelId: channels.alerts,
    };
  };

  const alertThreshold: SignalSeverity | null =
    opts.alertThreshold === undefined ? "high" : opts.alertThreshold;
  const triageDeliveryEnabled = opts.triageDeliveryEnabled ?? true;
  const setupTaskDeliveryEnabled = opts.setupTaskDeliveryEnabled ?? true;

  return {
    name: "slack",
    async start(ctx: DaemonContext): Promise<void> {
      // Resolve channels first via a plain WebClient — fail fast if the
      // tokens or channel names are wrong.
      webClient = new WebClient(opts.botToken);
      channels = await resolveChannels(webClient, {
        inboxName: opts.inboxChannel,
        alertsName: opts.alertsChannel,
      });
      ctx.logger.info("Slack channels resolved", {
        inbox: channels.inbox,
        alerts: channels.alerts,
      });

      // Build the Bolt app and register handlers
      app = opts.buildBoltApp
        ? opts.buildBoltApp({
            botToken: opts.botToken,
            appToken: opts.appToken,
            ...(opts.signingSecret !== undefined && {
              signingSecret: opts.signingSecret,
            }),
          })
        : new BoltApp({
            token: opts.botToken,
            appToken: opts.appToken,
            ...(opts.signingSecret !== undefined && {
              signingSecret: opts.signingSecret,
            }),
            socketMode: true,
            logLevel: LogLevel.WARN,
          });

      registerHandlers(app, {
        dataDir: opts.dataDir,
        surfaceCtx: surfaceCtxFor(),
        getAnthropicClient: () => {
          if (!lazyClient) {
            lazyClient = opts.buildAnthropicClient
              ? opts.buildAnthropicClient()
              : createSdkClient();
          }
          return lazyClient;
        },
        log: (message, meta) => ctx.logger.info(message, meta),
        logError: (message, error, meta) =>
          ctx.logger.error(message, error, meta),
      });

      await app.start();
      ctx.logger.info("Slack Socket Mode connected");

      // Initial surface scan + interval tick. Each tick runs both the
      // plan-review surface (#jarvis-inbox) and, when configured, the
      // signal-alert surface (#jarvis-alerts). Errors in one don't
      // abort the other.
      const tickFn = async (): Promise<void> => {
        try {
          const result = await runSurfaceTick(surfaceCtxFor());
          if (result.surfaced.length > 0) {
            ctx.logger.info("surfaced plans to slack", {
              count: result.surfaced.length,
              planIds: result.surfaced,
            });
          }
          for (const e of result.errors) {
            ctx.logger.error("surface failed", null, e);
          }
        } catch (err) {
          ctx.logger.error("surface tick errored", err);
        }
        if (alertThreshold !== null) {
          try {
            const alerts = await runAlertTick(alertCtxFor(), {
              threshold: alertThreshold,
            });
            if (
              alerts.alerted.length > 0 ||
              alerts.suppressedSkipped.length > 0
            ) {
              ctx.logger.info("alerted signals to slack", {
                alerted: alerts.alerted.length,
                suppressedSkipped: alerts.suppressedSkipped.length,
              });
            }
            for (const e of alerts.errors) {
              ctx.logger.error("signal alert failed", null, e);
            }
          } catch (err) {
            ctx.logger.error("alert tick errored", err);
          }
        }
        if (triageDeliveryEnabled) {
          try {
            const triage = await runTriageDeliveryTick(surfaceCtxFor());
            if (triage.posted.length > 0) {
              ctx.logger.info("delivered triage to slack", {
                count: triage.posted.length,
                dates: triage.posted,
              });
            }
            for (const e of triage.errors) {
              ctx.logger.error("triage delivery failed", null, e);
            }
          } catch (err) {
            ctx.logger.error("triage delivery tick errored", err);
          }
        }
        if (setupTaskDeliveryEnabled) {
          try {
            const setup = await runSetupTaskDeliveryTick(surfaceCtxFor());
            if (setup.posted.length > 0) {
              ctx.logger.info("delivered setup tasks to slack", {
                count: setup.posted.length,
                taskIds: setup.posted,
              });
            }
            for (const e of setup.errors) {
              ctx.logger.error("setup-task delivery failed", null, e);
            }
          } catch (err) {
            ctx.logger.error("setup-task delivery tick errored", err);
          }
        }
      };
      // Fire once immediately, then on interval
      void tickFn();
      const tickMs = opts.surfaceTickMs ?? DEFAULT_SURFACE_TICK_MS;
      surfaceTimer = setInterval(() => void tickFn(), tickMs);
      surfaceTimer.unref();
    },

    async stop(): Promise<void> {
      if (surfaceTimer) {
        clearInterval(surfaceTimer);
        surfaceTimer = null;
      }
      if (app) {
        try {
          await app.stop();
        } catch {
          // best-effort
        }
        app = null;
      }
      webClient = null;
      channels = null;
      lazyClient = null;
    },
  };
}

/** Helper: read Slack config from process.env, return null if any required value is missing. */
export function readSlackEnv(): {
  botToken: string;
  appToken: string;
  signingSecret: string | undefined;
  inboxChannel: string;
  alertsChannel: string;
} | null {
  const botToken = process.env["SLACK_BOT_TOKEN"];
  const appToken = process.env["SLACK_APP_TOKEN"];
  const inboxChannel = process.env["JARVIS_SLACK_INBOX_CHANNEL"];
  const alertsChannel = process.env["JARVIS_SLACK_ALERTS_CHANNEL"];
  if (!botToken || !appToken || !inboxChannel || !alertsChannel) return null;
  return {
    botToken,
    appToken,
    signingSecret: process.env["SLACK_SIGNING_SECRET"],
    inboxChannel,
    alertsChannel,
  };
}
