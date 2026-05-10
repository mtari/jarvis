import fs from "node:fs";
import {
  createDaemonLogger,
  type DaemonLogger,
} from "../../orchestrator/daemon-logger.ts";
import {
  acquirePidFile,
  PidFileHeldError,
  releasePidFile,
  type PidFileData,
} from "../../orchestrator/daemon-pid.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { createAnalystService } from "../../integrations/analyst/service.ts";
import { createTriageService } from "../../integrations/triage/service.ts";
import { createDailyAuditService } from "../../integrations/daily-audit/service.ts";
import { createLearnTickService } from "../../integrations/learn-tick/service.ts";
import { createMarketerService } from "../../integrations/marketer/service.ts";
import { createPlanExecutorService } from "../../integrations/plan-executor/service.ts";
import { createPostSchedulerService } from "../../integrations/post-scheduler/service.ts";
import {
  createSlackService,
  readSlackEnv,
} from "../../integrations/slack/service.ts";
import {
  daemonPidFile,
  dbFile,
  envFile,
  getDataDir,
  logsDir,
} from "../paths.ts";

export interface DaemonContext {
  dataDir: string;
  logger: DaemonLogger;
  pidFile: PidFileData;
}

export interface DaemonService {
  name: string;
  start(ctx: DaemonContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface BootstrapOptions {
  dataDir?: string;
  services?: DaemonService[];
  now?: () => Date;
  echo?: boolean;
}

export interface DaemonHandle {
  ctx: DaemonContext;
  shutdown(reason?: string): Promise<void>;
}

export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

/**
 * Sets up the daemon's primitives (PID file + logger), starts each
 * registered service, returns a handle the caller can use to shut down.
 *
 * Throws PidFileHeldError if another live daemon is already running.
 * Throws DaemonError if the data dir hasn't been installed.
 */
export async function bootstrapDaemon(
  opts: BootstrapOptions = {},
): Promise<DaemonHandle> {
  const dataDir = opts.dataDir ?? getDataDir();
  if (!fs.existsSync(dbFile(dataDir))) {
    throw new DaemonError(
      `no install at ${dataDir}. Run 'yarn jarvis install' first.`,
    );
  }

  const pidPath = daemonPidFile(dataDir);
  const acquireOpts = opts.now ? { now: opts.now } : {};
  const pidFile = acquirePidFile(pidPath, acquireOpts);

  const loggerOpts = {
    logsDir: logsDir(dataDir),
    ...(opts.now && { now: opts.now }),
    ...(opts.echo !== undefined && { echo: opts.echo }),
  };
  const logger = createDaemonLogger(loggerOpts);
  logger.info("daemon starting", { pid: pidFile.pid });

  const ctx: DaemonContext = { dataDir, logger, pidFile };

  const services = [...(opts.services ?? [])];
  const started: DaemonService[] = [];
  for (const service of services) {
    try {
      await service.start(ctx);
      started.push(service);
      logger.info("service started", { service: service.name });
    } catch (err) {
      logger.error("service failed to start", err, { service: service.name });
      // Roll back: stop already-started services + release primitives.
      for (const s of [...started].reverse()) {
        try {
          await s.stop();
        } catch (stopErr) {
          logger.error("service failed to stop during rollback", stopErr, {
            service: s.name,
          });
        }
      }
      logger.close();
      releasePidFile(pidPath, { pid: pidFile.pid });
      throw err;
    }
  }

  let shutdownInvoked = false;
  const shutdown = async (reason?: string): Promise<void> => {
    if (shutdownInvoked) return;
    shutdownInvoked = true;
    logger.info("daemon shutting down", { ...(reason && { reason }) });
    for (const service of [...started].reverse()) {
      try {
        await service.stop();
        logger.info("service stopped", { service: service.name });
      } catch (err) {
        logger.error("service failed to stop", err, { service: service.name });
      }
    }
    logger.info("daemon stopped");
    logger.close();
    releasePidFile(pidPath, { pid: pidFile.pid });
  };

  return { ctx, shutdown };
}

export async function runDaemon(rawArgs: string[]): Promise<number> {
  if (rawArgs.length > 0) {
    console.error(`daemon: unexpected arguments: ${rawArgs.join(" ")}`);
    return 1;
  }

  // Load .env so SLACK_*_TOKEN etc. are available before service startup.
  const dataDir = getDataDir();
  loadEnvFile(envFile(dataDir));

  let handle: DaemonHandle;
  try {
    handle = await bootstrapDaemon({ services: defaultServices(dataDir) });
  } catch (err) {
    if (err instanceof PidFileHeldError) {
      console.error(`daemon: ${err.message}`);
      return 1;
    }
    if (err instanceof DaemonError) {
      console.error(`daemon: ${err.message}`);
      return 1;
    }
    console.error(
      `daemon: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(`Jarvis daemon running (pid ${process.pid}). Ctrl-C to stop.`);

  const shutdown = (signal: string): void => {
    process.stdout.write(`\nShutting down (${signal})...\n`);
    handle
      .shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(
          `daemon: error during shutdown: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Hold the event loop open until a signal arrives.
  await new Promise<void>(() => {});
  return 0;
}

/**
 * Default services bundled with the daemon. Heartbeat always; Slack lights up
 * when SLACK_BOT_TOKEN + SLACK_APP_TOKEN + JARVIS_SLACK_*_CHANNEL are present
 * in jarvis-data/.env.
 */
function defaultServices(dataDir: string): DaemonService[] {
  const services: DaemonService[] = [
    createHeartbeatService(),
    createPlanExecutorService({ dataDir }),
    createAnalystService({ dataDir }),
    createTriageService({ dataDir }),
    createMarketerService({ dataDir }),
    createPostSchedulerService({ dataDir }),
    createLearnTickService({ dataDir }),
    createDailyAuditService({ dataDir }),
  ];
  const slackConfig = readSlackEnv();
  if (slackConfig) {
    services.push(
      createSlackService({
        botToken: slackConfig.botToken,
        appToken: slackConfig.appToken,
        ...(slackConfig.signingSecret !== undefined && {
          signingSecret: slackConfig.signingSecret,
        }),
        inboxChannel: slackConfig.inboxChannel,
        alertsChannel: slackConfig.alertsChannel,
        dataDir,
      }),
    );
  }
  return services;
}

interface HeartbeatService extends DaemonService {
  intervalMs: number;
}

export function createHeartbeatService(
  intervalMs: number = 5 * 60_000,
): HeartbeatService {
  let timer: NodeJS.Timeout | null = null;
  let logger: DaemonLogger | null = null;
  return {
    name: "heartbeat",
    intervalMs,
    start(ctx) {
      logger = ctx.logger;
      timer = setInterval(() => {
        logger?.info("heartbeat", { uptime: process.uptime() });
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger = null;
    },
  };
}
