import Database from "better-sqlite3";
import {
  flagStaleWindowPosts,
  publishDuePosts,
} from "../../orchestrator/post-publisher.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  createFacebookAdapter,
  readFacebookEnv,
} from "../../tools/channels/facebook.ts";
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
   * Override the adapter set. When omitted, the service builds the
   * default set: file-stub catch-all + Facebook adapter (when
   * `FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN` are present in the
   * environment). Real FB/IG/X adapters override specific channels
   * in the order given via `buildAdapterMap`'s last-wins rule.
   */
  adapters?: ReadonlyArray<ChannelAdapter>;
  /** Test seam — fixed clock for the publisher's `dueBefore` cutoff. */
  now?: () => Date;
  /**
   * Grace window before a missed scheduled time escalates as
   * `post-window-missed`. Default 1h (per §10). Set to `null` to
   * disable stale-window flagging entirely.
   */
  staleGraceMs?: number | null;
  /** Test seam — overrides process.env when reading channel credentials. */
  env?: NodeJS.ProcessEnv;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

/**
 * Builds the default channel adapter set based on environment:
 *   - file-stub adapter (catch-all, always registered first)
 *   - Facebook adapter (registered last when `FB_PAGE_ID` +
 *     `FB_PAGE_ACCESS_TOKEN` are present in env, overriding stub for
 *     `facebook` channel via the last-wins rule)
 *
 * Future: Instagram, LinkedIn, X adapters slot in here the same way.
 */
export function buildDefaultAdapters(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [createFileStubAdapter({ dataDir })];
  const fbConfig = readFacebookEnv(env);
  if (fbConfig) {
    adapters.push(createFacebookAdapter(fbConfig));
  }
  return adapters;
}

export function createPostSchedulerService(
  opts: PostSchedulerServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const adapterList: ReadonlyArray<ChannelAdapter> =
    opts.adapters ?? buildDefaultAdapters(opts.dataDir, opts.env);
  const adapters: ChannelAdapterMap = buildAdapterMap(adapterList);
  const staleGraceMs =
    opts.staleGraceMs === undefined ? undefined : opts.staleGraceMs;

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  return {
    name: "post-scheduler",
    start(ctx: DaemonContext): void {
      ctx.logger.info("post-scheduler: adapter coverage", {
        adapterCount: adapterList.length,
        channels: Array.from(adapters.keys()),
      });
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
            ...(staleGraceMs !== undefined && { staleGraceMs }),
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
  /**
   * Grace before a missed window escalates. Default 1h. Pass `null`
   * to skip stale flagging entirely.
   */
  staleGraceMs?: number | null;
}

/**
 * The tick body — exported for direct invocation (tests + the
 * `posts publish-due` CLI). Opens its own DB handle, flags any
 * stale-window rows, runs the publisher, logs the outcome, closes.
 *
 * Stale flagging happens BEFORE publishing so a row that's both
 * stale and due gets the missed-window event AND publishes on the
 * same tick — operator sees the gap, the row still goes out.
 */
export async function runPostSchedulerTick(
  input: RunPostSchedulerTickInput,
): Promise<void> {
  const db = new Database(dbFile(input.dataDir));
  try {
    if (input.staleGraceMs !== null) {
      const stale = flagStaleWindowPosts({
        db,
        ...(input.staleGraceMs !== undefined && {
          graceMs: input.staleGraceMs,
        }),
        ...(input.now !== undefined && { now: input.now }),
      });
      if (stale.flagged.length > 0) {
        input.ctx.logger.warn("post-scheduler: stale windows", {
          flagged: stale.flagged.length,
          oldest: stale.flagged[0]?.postId,
          maxHoursLate: Math.max(...stale.flagged.map((s) => s.hoursLate)),
        });
        for (const row of stale.flagged) {
          input.ctx.logger.warn("post window missed", {
            postId: row.postId,
            channel: row.channel,
            scheduledAt: row.scheduledAt,
            hoursLate: row.hoursLate,
          });
        }
      }
    }

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
