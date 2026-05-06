import Database from "better-sqlite3";
import {
  flagStaleWindowPosts,
  publishDuePosts,
} from "../../orchestrator/post-publisher.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  createFacebookAdapter,
  readFacebookEnv,
} from "../../tools/channels/facebook.ts";
import { createFileStubAdapter } from "../../tools/channels/file-stub.ts";
import {
  buildAdapterRegistry,
  type ChannelAdapterRegistry,
  type RegisteredAdapter,
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
   * Override the registry. When omitted, the service walks every
   * onboarded brain at start, registers a per-app Facebook adapter
   * for any brain whose `connections.facebook` declares both
   * `pageId` and `tokenEnvVar` (with the env var resolvable). The
   * legacy global `FB_PAGE_ID` / `FB_PAGE_ACCESS_TOKEN` env vars
   * stay supported as a `facebook` fallback. The file-stub catch-all
   * is always present so unmatched channels still get JSONL output.
   */
  registry?: ChannelAdapterRegistry;
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

export interface BuildDefaultRegistryOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Optional logger for diagnostics ("brain X named env var Y but it's unset"). */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Builds the default channel-adapter registry. Order of registration:
 *   1. File-stub catch-all (every channel; fallback).
 *   2. Legacy global FB env vars (`FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN`)
 *      → `facebook` fallback when set. Kept for back-compat with the
 *      single-Page setup in PR #61.
 *   3. Per-app FB adapter for every onboarded brain whose
 *      `connections.facebook` declares both `pageId` and `tokenEnvVar`
 *      AND the env var resolves. Per-app entries win over fallbacks.
 *
 * Brains without `connections.facebook` (or with malformed entries)
 * still publish — they fall through to the legacy fallback or stub.
 */
export function buildDefaultRegistry(
  opts: BuildDefaultRegistryOptions,
): ChannelAdapterRegistry {
  const env = opts.env ?? process.env;
  const registered: RegisteredAdapter[] = [];

  registered.push({
    adapter: createFileStubAdapter({ dataDir: opts.dataDir }),
    name: "file-stub",
  });

  const legacyFb = readFacebookEnv(env);
  if (legacyFb) {
    registered.push({
      adapter: createFacebookAdapter(legacyFb),
      name: "facebook:legacy-env",
    });
  }

  for (const onboarded of listOnboardedApps(opts.dataDir)) {
    const fbConn = readFacebookConnection(onboarded.brain.connections, env);
    // Brain has no FB connection block at all → silent skip.
    if (
      fbConn.pageId === undefined &&
      fbConn.accessToken === undefined &&
      fbConn.problem === undefined
    ) {
      continue;
    }
    if (fbConn.problem !== undefined) {
      opts.logger?.warn(
        "facebook adapter skipped for app — connection misconfigured",
        { app: onboarded.app, problem: fbConn.problem },
      );
      continue;
    }
    if (fbConn.pageId === undefined || fbConn.accessToken === undefined) {
      // Defensive — readFacebookConnection should always return either a
      // problem or both fields once the brain has a connection block.
      continue;
    }
    registered.push({
      adapter: createFacebookAdapter({
        pageId: fbConn.pageId,
        accessToken: fbConn.accessToken,
      }),
      appId: onboarded.app,
      name: `facebook:${onboarded.app}`,
    });
  }

  return buildAdapterRegistry(registered);
}

interface ResolvedFacebookConnection {
  /** Set when the brain declares a pageId. */
  pageId?: string;
  /** Set when the brain references an env var AND it resolved to a non-empty value. */
  accessToken?: string;
  /** Set when the brain config looks malformed and we want to log. */
  problem?: string;
}

/**
 * Reads the brain's Facebook connection and resolves both the pageId
 * and the access token.
 *
 * The recommended shape places **both** values in `<dataDir>/.env`
 * and references them by env-var name in the brain:
 *
 *   "facebook": {
 *     "pageIdEnvVar": "FB_PAGE_ID_ERDEI",
 *     "tokenEnvVar":  "FB_TOKEN_ERDEI"
 *   }
 *
 * For back-compat with PR #62 (the initial per-app shape), a literal
 * `pageId` field is still accepted. When both `pageIdEnvVar` and
 * `pageId` are present, `pageIdEnvVar` wins — encourages migration to
 * the .env-only shape over time.
 */
function readFacebookConnection(
  connections: Record<string, Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): ResolvedFacebookConnection {
  const fb = connections["facebook"];
  if (!fb || typeof fb !== "object") return {};

  const pageIdEnvRaw = fb["pageIdEnvVar"];
  const pageIdLiteral = fb["pageId"];
  const tokenEnvRaw = fb["tokenEnvVar"];

  const hasAnyField =
    pageIdEnvRaw !== undefined ||
    pageIdLiteral !== undefined ||
    tokenEnvRaw !== undefined;
  if (!hasAnyField) return {};

  // ---- pageId resolution ----
  let pageId: string | undefined;
  if (pageIdEnvRaw !== undefined) {
    if (typeof pageIdEnvRaw !== "string" || pageIdEnvRaw.trim().length === 0) {
      return {
        problem:
          "connections.facebook.pageIdEnvVar must be a non-empty string",
      };
    }
    const v = env[pageIdEnvRaw];
    if (v === undefined || v.trim().length === 0) {
      return {
        problem: `env var ${pageIdEnvRaw} (referenced by brain.connections.facebook.pageIdEnvVar) is unset or empty`,
      };
    }
    pageId = v.trim();
  } else if (pageIdLiteral !== undefined) {
    if (
      typeof pageIdLiteral !== "string" ||
      pageIdLiteral.trim().length === 0
    ) {
      return {
        problem: "connections.facebook.pageId must be a non-empty string",
      };
    }
    pageId = pageIdLiteral.trim();
  }

  // ---- token resolution ----
  if (typeof tokenEnvRaw !== "string" || tokenEnvRaw.trim().length === 0) {
    return {
      ...(pageId !== undefined && { pageId }),
      problem: "connections.facebook.tokenEnvVar must be a non-empty string",
    };
  }
  const accessToken = env[tokenEnvRaw];
  if (accessToken === undefined || accessToken.trim().length === 0) {
    return {
      ...(pageId !== undefined && { pageId }),
      problem: `env var ${tokenEnvRaw} (referenced by brain.connections.facebook.tokenEnvVar) is unset or empty`,
    };
  }
  if (pageId === undefined) {
    return {
      problem:
        "connections.facebook missing pageIdEnvVar (or legacy pageId)",
    };
  }
  return {
    pageId,
    accessToken: accessToken.trim(),
  };
}

export function createPostSchedulerService(
  opts: PostSchedulerServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let registry: ChannelAdapterRegistry | null = opts.registry ?? null;
  const staleGraceMs =
    opts.staleGraceMs === undefined ? undefined : opts.staleGraceMs;

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  return {
    name: "post-scheduler",
    start(ctx: DaemonContext): void {
      if (!registry) {
        registry = buildDefaultRegistry({
          dataDir: opts.dataDir,
          ...(opts.env !== undefined && { env: opts.env }),
          logger: { warn: (m, meta) => ctx.logger.warn(m, meta) },
        });
      }
      ctx.logger.info("post-scheduler: adapter coverage", {
        registry: registry.describe(),
        channels: Array.from(registry.channels()),
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
            registry: registry!,
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
  registry: ChannelAdapterRegistry;
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
      adapters: input.registry,
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
