import Database from "better-sqlite3";
import { publishDuePosts } from "../../orchestrator/post-publisher.ts";
import { dbFile } from "../../cli/paths.ts";
import { createFileStubAdapter } from "../../tools/channels/file-stub.ts";
import {
  buildAdapterMap,
  type ChannelAdapter,
  type ChannelAdapterMap,
} from "../../tools/channels/types.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Daemon service: every ~60s, picks up due `pending` rows from
 * `scheduled_posts` and publishes them through the registered
 * channel adapters. Phase 3 v1 ships only the file-stub adapter
 * (writes JSONL to sandbox/) — real FB/IG adapters override
 * specific channels in a follow-up via the last-wins rule in
 * `buildAdapterMap`.
 *
 * Mirrors the analyst-tick pattern: `tickInFlight` guard, `_tickBody`
 * test seam, errors logged + isolated so a single bad row can't
 * blackhole the queue.
 */

const DEFAULT_TICK_MS = 60 * 1000; // 1 minute, per §10

export interface PostSchedulerServiceOptions {
  dataDir: string;
  /** Tick interval. Default 60s. */
  tickMs?: number;
  /**
   * Override the adapter set. Defaults to a single file-stub adapter
   * serving every SUPPORTED_CHANNELS. Real FB/IG adapters land in
   * follow-up PRs and replace specific channels.
   */
  adapters?: ReadonlyArray<ChannelAdapter>;
  /** Test seam — fixed clock for the publisher's `dueBefore` cutoff. */
  now?: () => Date;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

export function createPostSchedulerService(
  opts: PostSchedulerServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const adapters: ChannelAdapterMap = buildAdapterMap(
    opts.adapters ?? [createFileStubAdapter({ dataDir: opts.dataDir })],
  );

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  return {
    name: "post-scheduler",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          await runPostSchedulerTick({
            dataDir: opts.dataDir,
            adapters,
            ctx,
            ...(opts.now !== undefined && { now: opts.now() }),
          });
        } catch (err) {
          ctx.logger.error("post-scheduler tick errored", err);
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

export interface RunPostSchedulerTickInput {
  dataDir: string;
  adapters: ChannelAdapterMap;
  ctx: DaemonContext;
  now?: Date;
}

/**
 * The tick body — exported for direct invocation (tests + the
 * `posts publish-due` CLI). Opens its own DB handle, runs the
 * publisher, logs the outcome, closes.
 */
export async function runPostSchedulerTick(
  input: RunPostSchedulerTickInput,
): Promise<void> {
  const db = new Database(dbFile(input.dataDir));
  try {
    const result = await publishDuePosts({
      db,
      adapters: input.adapters,
      ...(input.now !== undefined && { now: input.now }),
    });
    if (
      result.examined === 0 &&
      result.published.length === 0 &&
      result.failed.length === 0
    ) {
      // Most ticks return here — silent on the happy path so logs don't fill up.
      return;
    }
    input.ctx.logger.info("post-scheduler tick", {
      examined: result.examined,
      published: result.published.length,
      failed: result.failed.length,
    });
    for (const f of result.failed) {
      input.ctx.logger.warn("post-publish failed", {
        postId: f.postId,
        channel: f.channel,
        reason: f.reason,
      });
    }
  } finally {
    db.close();
  }
}
