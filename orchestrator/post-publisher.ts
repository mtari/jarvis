import type { Database } from "better-sqlite3";
import { appendEvent } from "./event-log.ts";
import {
  listScheduledPosts,
  type ScheduledPost,
} from "./scheduled-posts.ts";
import type {
  ChannelAdapterRegistry,
  PublishResult,
} from "../tools/channels/types.ts";

/** Default grace period before a missed window escalates. Matches §10. */
export const DEFAULT_STALE_GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Default exponential backoff schedule for transient adapter failures.
 * Index = retry number after a transient miss; value = ms to wait.
 * Matches §10 ("up to 3 retries with exponential backoff"):
 *   1st retry: ~1 minute
 *   2nd retry: ~5 minutes
 *   3rd retry: ~15 minutes
 *   beyond:    no more retries — row → failed
 */
export const DEFAULT_RETRY_BACKOFF_MS: ReadonlyArray<number> = [
  60_000,
  5 * 60_000,
  15 * 60_000,
];

/**
 * Post publisher — picks up due `pending` rows from `scheduled_posts`,
 * dispatches each to the right channel adapter, updates the row's
 * status. Runs from the daemon's post-scheduler tick (every ~60s) and
 * from `yarn jarvis posts publish-due` for manual single-shot fires.
 *
 * Idempotency relies on `status`: only `pending` rows are picked up
 * each tick, and a successful publish flips the row to `published`
 * so it never re-fires. A crash between the adapter call returning
 * and the row update CAN cause a double-publish on the platform —
 * the adapter contract asks adapters to detect already-published
 * state and return the existing id when supported, but we don't
 * promise zero double-fires. The stub adapter is intentionally
 * non-idempotent on the JSONL output so tests can detect the case.
 *
 * Failures: the row flips to `failed` with `failure_reason` set.
 * Retry / backoff (§10) lands when real adapters report transient
 * errors — the stub never fails, and the v1 publisher doesn't yet
 * track retry counts. Each tick re-tries `failed` rows: the row
 * STAYS in `failed` after each attempt; this v1 publisher does NOT
 * automatically re-pick failed rows. Operators run `posts edit` +
 * `posts skip` (a future surface might add `posts retry`).
 */

export interface PublishDuePostsInput {
  db: Database;
  adapters: ChannelAdapterRegistry;
  /**
   * Cutoff for "due" rows — only rows with `scheduled_at <= now` are
   * picked up. Defaults to wall clock.
   */
  now?: Date;
  /** Hard cap on rows handled per tick. Default 50. */
  maxPerTick?: number;
  /**
   * Backoff schedule for transient adapter failures. Length = max
   * retries; index `retryCount` is the wait before the (retryCount+1)th
   * attempt. After exhausting the schedule the row flips to `failed`.
   * Default: see DEFAULT_RETRY_BACKOFF_MS.
   */
  retryBackoffMs?: ReadonlyArray<number>;
}

export interface PublishedRow {
  postId: string;
  channel: string;
  publishedId: string;
}

export interface FailedRow {
  postId: string;
  channel: string;
  reason: string;
}

export interface SkippedRow {
  postId: string;
  channel: string;
  reason: string;
}

export interface RetriedRow {
  postId: string;
  channel: string;
  /** Retry attempt number that just failed (1-indexed). */
  attempt: number;
  reason: string;
  /** ISO datetime of the next attempt. */
  nextRetryAt: string;
}

export interface PublishDuePostsResult {
  /** Total candidate rows examined (pending + due before cap). */
  examined: number;
  published: PublishedRow[];
  failed: FailedRow[];
  /** Rows skipped because no adapter is registered for the channel. */
  skipped: SkippedRow[];
  /** Transient failures that were rescheduled — NOT counted in `failed`. */
  retrying: RetriedRow[];
}

export async function publishDuePosts(
  input: PublishDuePostsInput,
): Promise<PublishDuePostsResult> {
  const now = input.now ?? new Date();
  const maxPerTick = input.maxPerTick ?? 50;
  const backoff = input.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const candidates = listScheduledPosts(input.db, {
    status: "pending",
    dueBefore: now.toISOString(),
    retryReadyAt: now.toISOString(),
    limit: maxPerTick,
  });

  const result: PublishDuePostsResult = {
    examined: candidates.length,
    published: [],
    failed: [],
    skipped: [],
    retrying: [],
  };

  for (const row of candidates) {
    const adapter = input.adapters.get(row.channel, row.appId);
    if (!adapter) {
      // Missing adapter is a config error, not a transient one — fail
      // immediately so the operator notices.
      const reason = `no adapter registered for channel "${row.channel}" + app "${row.appId}"`;
      markFailed(input.db, row, reason);
      result.failed.push({
        postId: row.id,
        channel: row.channel,
        reason,
      });
      continue;
    }
    let publishResult: PublishResult;
    try {
      publishResult = await adapter.publish({
        postId: row.id,
        planId: row.planId,
        appId: row.appId,
        content: row.content,
        assets: row.assets,
        channel: row.channel,
      });
    } catch (err) {
      // Adapter threw → treat as transient (network glitch, etc.). The
      // contract asks adapters to return ok:false transient:true for
      // these, but defense in depth.
      const reason = `adapter threw: ${err instanceof Error ? err.message : String(err)}`;
      handleTransient(input.db, row, reason, now, backoff, result);
      continue;
    }
    if (publishResult.ok) {
      markPublished(input.db, row, publishResult.publishedId, now);
      result.published.push({
        postId: row.id,
        channel: row.channel,
        publishedId: publishResult.publishedId,
      });
      continue;
    }
    if (publishResult.transient === true) {
      handleTransient(
        input.db,
        row,
        publishResult.reason,
        now,
        backoff,
        result,
      );
    } else {
      markFailed(input.db, row, publishResult.reason);
      result.failed.push({
        postId: row.id,
        channel: row.channel,
        reason: publishResult.reason,
      });
    }
  }

  return result;
}

function handleTransient(
  db: Database,
  row: ScheduledPost,
  reason: string,
  now: Date,
  backoff: ReadonlyArray<number>,
  result: PublishDuePostsResult,
): void {
  // retryCount = how many retries already happened. The next attempt
  // would be retry #(retryCount+1). If that's beyond the schedule, the
  // row's done retrying.
  const nextAttempt = row.retryCount + 1;
  if (nextAttempt > backoff.length) {
    const reasonWithCounter = `${reason} (after ${row.retryCount} retr${row.retryCount === 1 ? "y" : "ies"})`;
    markFailed(db, row, reasonWithCounter);
    result.failed.push({
      postId: row.id,
      channel: row.channel,
      reason: reasonWithCounter,
    });
    return;
  }
  const waitMs = backoff[nextAttempt - 1]!;
  const nextRetryAt = new Date(now.getTime() + waitMs).toISOString();
  scheduleRetry(db, row, reason, nextRetryAt, nextAttempt);
  result.retrying.push({
    postId: row.id,
    channel: row.channel,
    attempt: nextAttempt,
    reason,
    nextRetryAt,
  });
}

// ---------------------------------------------------------------------------
// Stale-window escalation (§10)
// ---------------------------------------------------------------------------

export interface FlagStaleWindowInput {
  db: Database;
  /** Bumped past `scheduled_at` by this many ms before a row counts as stale. */
  graceMs?: number;
  /** Test seam — fixed clock for the cutoff. */
  now?: Date;
  /** Hard cap on rows examined per call. Default 200. */
  maxPerCall?: number;
}

export interface StaleRow {
  postId: string;
  planId: string;
  appId: string;
  channel: string;
  scheduledAt: string;
  /** Hours past the scheduled window. */
  hoursLate: number;
}

export interface FlagStaleWindowResult {
  /** Newly-escalated rows (those that didn't already have a missed event). */
  flagged: StaleRow[];
  /** Rows that were already past-due AND already had a missed event — re-checked, not re-flagged. */
  alreadyFlagged: number;
}

/**
 * Walks `pending` rows whose `scheduled_at + graceMs` is past `now`,
 * emits one `post-window-missed` event per row that hasn't already
 * been flagged. Idempotent: re-running on the same stale row is a
 * no-op (the existing event is the de-dup key).
 *
 * Rows STAY in status=pending — the publisher will publish them on
 * the next due tick ("publish late" is the default per §10). To
 * skip a stale row, the operator runs `yarn jarvis posts skip <id>`.
 */
export function flagStaleWindowPosts(
  input: FlagStaleWindowInput,
): FlagStaleWindowResult {
  const graceMs = input.graceMs ?? DEFAULT_STALE_GRACE_MS;
  const now = input.now ?? new Date();
  const maxPerCall = input.maxPerCall ?? 200;
  const cutoffMs = now.getTime() - graceMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Candidates: pending rows whose scheduled_at + graceMs has passed.
  // listScheduledPosts(dueBefore) selects scheduled_at <= cutoff, which
  // is exactly the stale window.
  const candidates = listScheduledPosts(input.db, {
    status: "pending",
    dueBefore: cutoffIso,
    limit: maxPerCall,
  });

  if (candidates.length === 0) {
    return { flagged: [], alreadyFlagged: 0 };
  }

  // Pull the set of post ids that already have a `post-window-missed`
  // event so we don't double-flag. One query is cheaper than per-row
  // checks for any reasonable candidate count.
  const flaggedSet = readFlaggedPostIds(input.db);

  const flagged: StaleRow[] = [];
  let alreadyFlagged = 0;
  for (const row of candidates) {
    if (flaggedSet.has(row.id)) {
      alreadyFlagged += 1;
      continue;
    }
    const scheduledMs = Date.parse(row.scheduledAt);
    const hoursLate = Number.isFinite(scheduledMs)
      ? Math.max(0, (now.getTime() - scheduledMs) / (60 * 60 * 1000))
      : 0;
    appendEvent(input.db, {
      appId: row.appId,
      vaultId: "personal",
      kind: "post-window-missed",
      payload: {
        postId: row.id,
        planId: row.planId,
        channel: row.channel,
        scheduledAt: row.scheduledAt,
        graceHours: graceMs / (60 * 60 * 1000),
        hoursLate: Number(hoursLate.toFixed(2)),
      },
    });
    flagged.push({
      postId: row.id,
      planId: row.planId,
      appId: row.appId,
      channel: row.channel,
      scheduledAt: row.scheduledAt,
      hoursLate: Number(hoursLate.toFixed(2)),
    });
  }
  return { flagged, alreadyFlagged };
}

/**
 * Reads the set of post ids that already have a `post-window-missed`
 * event. SQLite's JSON1 isn't available here uniformly, so we extract
 * the post id by string-parsing the payload — cheap because the
 * payload is a small JSON object.
 */
function readFlaggedPostIds(db: Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE kind = 'post-window-missed'",
    )
    .all() as Array<{ payload: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.payload) as { postId?: unknown };
      if (typeof parsed.postId === "string") out.add(parsed.postId);
    } catch {
      // Malformed payload — skip; never breaks the dedup pass.
    }
  }
  return out;
}

function markPublished(
  db: Database,
  row: ScheduledPost,
  publishedId: string,
  now: Date,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE scheduled_posts
          SET status = 'published',
              published_at = ?,
              published_id = ?,
              failure_reason = NULL,
              next_retry_at = NULL
        WHERE id = ?`,
    ).run(now.toISOString(), publishedId, row.id);
    appendEvent(db, {
      appId: row.appId,
      vaultId: "personal",
      kind: "post-published",
      payload: {
        postId: row.id,
        planId: row.planId,
        channel: row.channel,
        publishedId,
        publishedAt: now.toISOString(),
        ...(row.retryCount > 0 && { retriesSpent: row.retryCount }),
      },
    });
  })();
}

/**
 * Bumps `retry_count`, sets `next_retry_at`, keeps status='pending'
 * so the row stays in the publisher's queue. Records a
 * `post-publish-retry` event for audit. failure_reason holds the
 * latest reason so operators can see why retries are happening.
 */
function scheduleRetry(
  db: Database,
  row: ScheduledPost,
  reason: string,
  nextRetryAt: string,
  attempt: number,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE scheduled_posts
          SET retry_count = ?,
              next_retry_at = ?,
              failure_reason = ?
        WHERE id = ?`,
    ).run(attempt, nextRetryAt, reason, row.id);
    appendEvent(db, {
      appId: row.appId,
      vaultId: "personal",
      kind: "post-publish-retry",
      payload: {
        postId: row.id,
        planId: row.planId,
        channel: row.channel,
        attempt,
        reason,
        nextRetryAt,
      },
    });
  })();
}

function markFailed(
  db: Database,
  row: ScheduledPost,
  reason: string,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE scheduled_posts
          SET status = 'failed',
              failure_reason = ?,
              next_retry_at = NULL
        WHERE id = ?`,
    ).run(reason, row.id);
    appendEvent(db, {
      appId: row.appId,
      vaultId: "personal",
      kind: "post-publish-failed",
      payload: {
        postId: row.id,
        planId: row.planId,
        channel: row.channel,
        reason,
        ...(row.retryCount > 0 && { retriesSpent: row.retryCount }),
      },
    });
  })();
}
