import { execSync } from "node:child_process";
import type { ExecSyncOptions } from "node:child_process";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

export type ExecSeam = (cmd: string, opts: { cwd: string; stdio: "pipe" }) => Buffer;

export interface DataSyncServiceOptions {
  dataDir: string;
  /** Polling interval. Default 60s. */
  intervalMs?: number;
  /** Minimum time between pushes. Default 5 min. */
  pushDebounceMs?: number;
  /**
   * Whether the service is active. Default: reads JARVIS_DATA_SYNC_ENABLED
   * (true unless set to 'false').
   */
  enabled?: boolean;
  /** Inject a custom exec for tests. */
  _exec?: ExecSeam;
  /** Override the tick body for lifecycle tests. @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_PUSH_DEBOUNCE_MS = 300_000;

function readEnabled(): boolean {
  return process.env["JARVIS_DATA_SYNC_ENABLED"] !== "false";
}

export function createDataSyncService(opts: DataSyncServiceOptions): DaemonService {
  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;
  let lastPushAt: number | null = null;

  const intervalMs =
    opts.intervalMs ??
    (process.env["JARVIS_DATA_SYNC_INTERVAL_MS"]
      ? parseInt(process.env["JARVIS_DATA_SYNC_INTERVAL_MS"]!, 10)
      : DEFAULT_INTERVAL_MS);

  const pushDebounceMs =
    opts.pushDebounceMs ??
    (process.env["JARVIS_DATA_SYNC_PUSH_DEBOUNCE_MS"]
      ? parseInt(process.env["JARVIS_DATA_SYNC_PUSH_DEBOUNCE_MS"]!, 10)
      : DEFAULT_PUSH_DEBOUNCE_MS);

  const enabled = opts.enabled ?? readEnabled();

  const exec: ExecSeam = opts._exec ?? ((cmd, o) => execSync(cmd, o as ExecSyncOptions) as Buffer);

  return {
    name: "data-sync",
    start(ctx: DaemonContext): void {
      if (!enabled) return;

      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          const result = await runDataSyncTick({
            dataDir: opts.dataDir,
            pushDebounceMs,
            lastPushAt,
            now: Date.now(),
            exec,
            ctx,
          });
          if (result.newLastPushAt !== undefined) {
            lastPushAt = result.newLastPushAt;
          }
        } catch (err) {
          ctx.logger.error(
            "data-sync tick errored",
            err instanceof Error ? err : new Error(String(err)),
          );
        } finally {
          tickInFlight = false;
        }
      };

      void tickFn();
      timer = setInterval(() => void tickFn(), intervalMs);
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

export interface RunDataSyncTickInput {
  dataDir: string;
  pushDebounceMs: number;
  lastPushAt: number | null;
  now: number;
  exec: ExecSeam;
  ctx: DaemonContext;
}

export interface RunDataSyncTickResult {
  action: "no-op" | "committed" | "committed-and-pushed" | "pushed" | "skipped-debounce" | "skipped-conflict";
  filesChanged?: number;
  newLastPushAt?: number;
}

export async function runDataSyncTick(
  input: RunDataSyncTickInput,
): Promise<RunDataSyncTickResult> {
  const { dataDir, pushDebounceMs, lastPushAt, now, exec, ctx } = input;
  const cwd = dataDir;
  const execOpts = { cwd, stdio: "pipe" as const };

  let committed = false;
  let filesChanged = 0;

  // Step 1: check working tree and commit if dirty
  try {
    const statusOut = exec("git status --porcelain", execOpts).toString().trim();
    if (statusOut.length > 0) {
      const lines = statusOut.split("\n").filter(Boolean);
      filesChanged = lines.length;
      const paths = lines.map((l) => l.slice(3).trim());
      const MAX_LISTED = 5;
      const listed = paths.slice(0, MAX_LISTED).join(", ");
      const extra = paths.length > MAX_LISTED ? `, ... and ${paths.length - MAX_LISTED} more` : "";
      const msg = `Sync ${filesChanged} file(s): ${listed}${extra}`;

      exec("git add -A", execOpts);
      exec(`git commit -m "${msg}"`, execOpts);
      committed = true;
    }
  } catch (err) {
    ctx.logger.error(
      "data-sync: commit failed — check git user.name/email in jarvis-data/",
      err instanceof Error ? err : new Error(String(err)),
    );
    return { action: "no-op" };
  }

  // Step 2: check if ahead of remote
  let aheadCount = 0;
  try {
    const revOut = exec("git rev-list --count @{u}..HEAD", execOpts).toString().trim();
    aheadCount = parseInt(revOut, 10);
    if (isNaN(aheadCount)) aheadCount = 0;
  } catch {
    ctx.logger.info("data-sync: no upstream, skipping push check");
    return committed ? { action: "committed", filesChanged } : { action: "no-op" };
  }

  if (aheadCount === 0) {
    return committed ? { action: "committed", filesChanged } : { action: "no-op" };
  }

  // Step 3: debounce check
  const elapsed = now - (lastPushAt ?? 0);
  if (elapsed < pushDebounceMs) {
    return committed
      ? { action: "committed", filesChanged }
      : { action: "skipped-debounce" };
  }

  // Step 4: pull --rebase then push
  try {
    exec("git pull --rebase", execOpts);
  } catch (err) {
    ctx.logger.warn("data-sync: pull --rebase failed, skipping push", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: "skipped-conflict", ...(committed && { filesChanged }) };
  }

  try {
    exec("git push", execOpts);
  } catch (err) {
    ctx.logger.error(
      "data-sync: push failed",
      err instanceof Error ? err : new Error(String(err)),
    );
    return { action: "skipped-conflict", ...(committed && { filesChanged }) };
  }

  return {
    action: "committed-and-pushed",
    ...(committed && { filesChanged }),
    newLastPushAt: now,
  };
}
