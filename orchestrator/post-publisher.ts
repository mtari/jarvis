import type { Database } from "better-sqlite3";
import { appendEvent } from "./event-log.ts";
import {
  listScheduledPosts,
  type ScheduledPost,
} from "./scheduled-posts.ts";
import type {
  ChannelAdapterMap,
  PublishResult,
} from "../tools/channels/types.ts";

/** Default grace period before a missed window escalates. Matches §10. */
export const DEFAULT_STALE_GRACE_MS = 60 * 60 * 1000; // 1 hour

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
  adapters: ChannelAdapterMap;
  /**
   * Cutoff for "due" rows — only rows with `scheduled_at <= now` are
   * picked up. Defaults to wall clock.
   */
  now?: Date;
  /** Hard cap on rows handled per tick. Default 50. */
  maxPerTick?: number;
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

export interface PublishDuePostsResult {
  /** Total candidate rows examined (pending + due before cap). */
  examined: number;
  published: PublishedRow[];
  failed: FailedRow[];
  /** Rows skipped because no adapter is registered for the channel. */
  skipped: SkippedRow[];
}

export async function publishDuePosts(
  input: PublishDuePostsInput,
): Promise<PublishDuePostsResult> {
  const now = input.now ?? new Date();
  const maxPerTick = input.maxPerTick ?? 50;
  const candidates = listScheduledPosts(input.db, {
    status: "pending",
    dueBefore: now.toISOString(),
    limit: maxPerTick,
  });

  const result: PublishDuePostsResult = {
    examined: candidates.length,
    published: [],
    failed: [],
    skipped: [],
  };

  for (const row of candidates) {
    const adapter = input.adapters.get(row.channel);
    if (!adapter) {
      const reason = `no adapter registered for channel "${row.channel}"`;
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
      const reason = `adapter threw: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(input.db, row, reason);
      result.failed.push({ postId: row.id, channel: row.channel, reason });
      continue;
    }
    if (publishResult.ok) {
      markPublished(input.db, row, publishResult.publishedId, now);
      result.published.push({
        postId: row.id,
        channel: row.channel,
        publishedId: publishResult.publishedId,
      });
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
              failure_reason = NULL
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
              failure_reason = ?
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
      },
    });
  })();
}
