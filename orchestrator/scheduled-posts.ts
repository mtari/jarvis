import type { Database } from "better-sqlite3";

/**
 * `scheduled_posts` table — runtime authoritative state for everything
 * the Marketer schedules. The plan markdown is the declarative source;
 * this table is what the daemon's scheduler tick reads to publish
 * (see §10 Scheduled-post persistence).
 *
 * Phase 3 v1 ships insert/list/find/count helpers + the Marketer
 * `prepare` flow that populates `pending` rows from a plan's content
 * calendar. The publishing path (status: pending → published) lands
 * with the FB/IG tools + scheduler tick in a follow-up.
 *
 * Schema columns (from migrations/db/001-initial-schema.ts):
 *   id, plan_id, app_id, channel, content (humanized),
 *   assets (JSON), scheduled_at, status, published_at,
 *   published_id, failure_reason, edit_history (JSON)
 */

export type ScheduledPostStatus =
  | "awaiting-review"
  | "pending"
  | "published"
  | "failed"
  | "skipped"
  | "edited";

export interface ScheduledPostInput {
  id: string;
  planId: string;
  appId: string;
  channel: string;
  /** Humanized post text — what actually goes out. */
  content: string;
  assets: ReadonlyArray<string>;
  /** ISO datetime when the row should publish. */
  scheduledAt: string;
  /** Defaults to "pending" when omitted. */
  status?: ScheduledPostStatus;
}

export interface ScheduledPost {
  id: string;
  planId: string;
  appId: string;
  channel: string;
  content: string;
  assets: string[];
  scheduledAt: string;
  status: ScheduledPostStatus;
  publishedAt: string | null;
  publishedId: string | null;
  failureReason: string | null;
  editHistory: unknown[];
  /** How many transient retries have been spent on this row (0 = never retried). */
  retryCount: number;
  /**
   * Earliest moment the publisher should re-attempt. Null when no
   * retry is pending. The publisher's "due" filter requires
   * (next_retry_at IS NULL OR next_retry_at <= now).
   */
  nextRetryAt: string | null;
}

interface RawRow {
  id: string;
  plan_id: string;
  app_id: string;
  channel: string;
  content: string;
  assets: string;
  scheduled_at: string;
  status: string;
  published_at: string | null;
  published_id: string | null;
  failure_reason: string | null;
  edit_history: string;
  retry_count: number;
  next_retry_at: string | null;
}

export class ScheduledPostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPostsError";
  }
}

/**
 * Inserts one row. Caller is responsible for picking ids that don't
 * collide — the helper surfaces the SQLite UNIQUE-constraint error
 * unwrapped so duplicate-prepare attempts fail loudly.
 */
export function insertScheduledPost(
  db: Database,
  input: ScheduledPostInput,
): void {
  db.prepare(
    `INSERT INTO scheduled_posts
       (id, plan_id, app_id, channel, content, assets, scheduled_at, status,
        published_at, published_id, failure_reason, edit_history)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')`,
  ).run(
    input.id,
    input.planId,
    input.appId,
    input.channel,
    input.content,
    JSON.stringify(input.assets),
    input.scheduledAt,
    input.status ?? "pending",
  );
}

export interface ListScheduledPostsFilter {
  planId?: string;
  appId?: string;
  status?: ScheduledPostStatus;
  /** ISO datetime; rows with `scheduled_at <= dueBefore` only. */
  dueBefore?: string;
  /**
   * ISO datetime; when set, rows must satisfy
   * `next_retry_at IS NULL OR next_retry_at <= retryReadyAt`.
   * Used by the publisher to skip rows whose retry backoff hasn't
   * elapsed.
   */
  retryReadyAt?: string;
  limit?: number;
}

export function listScheduledPosts(
  db: Database,
  filter: ListScheduledPostsFilter = {},
): ScheduledPost[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.planId !== undefined) {
    where.push("plan_id = ?");
    params.push(filter.planId);
  }
  if (filter.appId !== undefined) {
    where.push("app_id = ?");
    params.push(filter.appId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.dueBefore !== undefined) {
    where.push("scheduled_at <= ?");
    params.push(filter.dueBefore);
  }
  if (filter.retryReadyAt !== undefined) {
    where.push("(next_retry_at IS NULL OR next_retry_at <= ?)");
    params.push(filter.retryReadyAt);
  }
  let sql =
    "SELECT * FROM scheduled_posts" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY scheduled_at ASC";
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  const rows = db.prepare(sql).all(...params) as RawRow[];
  return rows.map(toScheduledPost);
}

export function findScheduledPost(
  db: Database,
  id: string,
): ScheduledPost | null {
  const row = db
    .prepare("SELECT * FROM scheduled_posts WHERE id = ?")
    .get(id) as RawRow | undefined;
  if (!row) return null;
  return toScheduledPost(row);
}

export function countScheduledPosts(
  db: Database,
  filter: ListScheduledPostsFilter = {},
): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.planId !== undefined) {
    where.push("plan_id = ?");
    params.push(filter.planId);
  }
  if (filter.appId !== undefined) {
    where.push("app_id = ?");
    params.push(filter.appId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const sql =
    "SELECT COUNT(*) AS c FROM scheduled_posts" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "");
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

function toScheduledPost(row: RawRow): ScheduledPost {
  let assets: string[];
  try {
    const parsed = JSON.parse(row.assets);
    assets = Array.isArray(parsed) ? parsed.filter((a) => typeof a === "string") : [];
  } catch {
    assets = [];
  }
  let editHistory: unknown[];
  try {
    const parsed = JSON.parse(row.edit_history);
    editHistory = Array.isArray(parsed) ? parsed : [];
  } catch {
    editHistory = [];
  }
  return {
    id: row.id,
    planId: row.plan_id,
    appId: row.app_id,
    channel: row.channel,
    content: row.content,
    assets,
    scheduledAt: row.scheduled_at,
    status: assertStatus(row.status),
    publishedAt: row.published_at,
    publishedId: row.published_id,
    failureReason: row.failure_reason,
    editHistory,
    retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
    nextRetryAt: row.next_retry_at,
  };
}

function assertStatus(s: string): ScheduledPostStatus {
  switch (s) {
    case "awaiting-review":
    case "pending":
    case "published":
    case "failed":
    case "skipped":
    case "edited":
      return s;
    default:
      // Treat unknown values as pending to keep the row visible for
      // operator inspection rather than dropping it.
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Mutations: edit + skip
// ---------------------------------------------------------------------------

/**
 * One entry in `scheduled_posts.edit_history`. Captures the previous
 * content so the learning loop (§5) can study repeated edits.
 */
export interface EditHistoryEntry {
  /** ISO datetime of the edit. */
  at: string;
  /** Free-form actor tag, e.g. "cli", "slack:U-xyz". */
  actor: string;
  /** Content as it stood before this edit. */
  previousContent: string;
}

export interface EditScheduledPostInput {
  newContent: string;
  actor: string;
  /** Test seam — fixed clock for the history entry. */
  now?: Date;
}

export class ScheduledPostMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPostMutationError";
  }
}

/**
 * Replaces the row's content and appends a `pre-edit` snapshot to
 * `edit_history`. Refuses to edit rows that have already published —
 * post-publish edits go through the platform's edit API in a
 * separate flow (see §10 "Edit before publish"). Refuses empty
 * content too; an empty post means "skip" and should use that path.
 *
 * Side-effect: status flips to `edited` so the rolling diff in
 * `edit_history` is visible without joining tables. Pending rows
 * remain pending after edit (status: edited is treated as ready-to-
 * publish by the scheduler — same as pending — until we ship the
 * publishing tick).
 */
export function editScheduledPost(
  db: Database,
  id: string,
  input: EditScheduledPostInput,
): ScheduledPost {
  const current = findScheduledPost(db, id);
  if (!current) {
    throw new ScheduledPostMutationError(`scheduled post "${id}" not found`);
  }
  if (current.status === "published") {
    throw new ScheduledPostMutationError(
      `scheduled post "${id}" is already published; use the platform's post-publish edit API instead`,
    );
  }
  if (current.status === "skipped") {
    throw new ScheduledPostMutationError(
      `scheduled post "${id}" is skipped; unskip first if you want to edit and re-queue`,
    );
  }
  const trimmed = input.newContent.trim();
  if (trimmed.length === 0) {
    throw new ScheduledPostMutationError(
      "edit content is empty; use `posts skip` to drop a post instead",
    );
  }
  if (trimmed === current.content) {
    // Idempotent no-op — return the existing row untouched.
    return current;
  }

  const at = (input.now ?? new Date()).toISOString();
  const entry: EditHistoryEntry = {
    at,
    actor: input.actor,
    previousContent: current.content,
  };
  const nextHistory = [...current.editHistory, entry];

  db.prepare(
    `UPDATE scheduled_posts
        SET content = ?, status = 'edited', edit_history = ?
      WHERE id = ?`,
  ).run(trimmed, JSON.stringify(nextHistory), id);

  const updated = findScheduledPost(db, id);
  if (!updated) {
    // Shouldn't happen — the row existed a moment ago.
    throw new ScheduledPostMutationError(
      `internal: row "${id}" disappeared after update`,
    );
  }
  return updated;
}

export interface SkipScheduledPostInput {
  reason: string;
  actor: string;
}

export interface ApproveScheduledPostInput {
  actor: string;
}

/**
 * Flips an `awaiting-review` row to `pending` so the publisher tick
 * picks it up. Used for single-post plans where each post needs
 * per-post review before publishing (§10).
 *
 * Idempotent on already-pending rows. Refuses on rows that have
 * progressed past the review gate (published, failed, skipped):
 * publishing them would be a re-publish; the operator is asking for
 * the wrong tool.
 */
export function approveScheduledPost(
  db: Database,
  id: string,
  input: ApproveScheduledPostInput,
): ScheduledPost {
  const current = findScheduledPost(db, id);
  if (!current) {
    throw new ScheduledPostMutationError(`scheduled post "${id}" not found`);
  }
  if (current.status === "pending") {
    return current;
  }
  if (current.status !== "awaiting-review" && current.status !== "edited") {
    throw new ScheduledPostMutationError(
      `scheduled post "${id}" has status "${current.status}"; only awaiting-review or edited rows can be approved`,
    );
  }
  const trimmedActor = input.actor.trim();
  if (trimmedActor.length === 0) {
    throw new ScheduledPostMutationError("approval actor cannot be empty");
  }
  db.prepare(
    `UPDATE scheduled_posts
        SET status = 'pending',
            failure_reason = NULL
      WHERE id = ?`,
  ).run(id);
  const updated = findScheduledPost(db, id);
  if (!updated) {
    throw new ScheduledPostMutationError(
      `internal: row "${id}" disappeared after approve`,
    );
  }
  return updated;
}

/**
 * Marks the row as `skipped` so the scheduler tick won't publish it.
 * `failure_reason` carries the user's reason for audit. Idempotent on
 * already-skipped rows; refuses on already-published rows.
 */
export function skipScheduledPost(
  db: Database,
  id: string,
  input: SkipScheduledPostInput,
): ScheduledPost {
  const current = findScheduledPost(db, id);
  if (!current) {
    throw new ScheduledPostMutationError(`scheduled post "${id}" not found`);
  }
  if (current.status === "published") {
    throw new ScheduledPostMutationError(
      `scheduled post "${id}" is already published; cannot skip after publish`,
    );
  }
  if (current.status === "skipped") {
    return current;
  }
  const trimmedReason = input.reason.trim();
  if (trimmedReason.length === 0) {
    throw new ScheduledPostMutationError("skip reason cannot be empty");
  }
  db.prepare(
    `UPDATE scheduled_posts
        SET status = 'skipped', failure_reason = ?
      WHERE id = ?`,
  ).run(`skipped by ${input.actor}: ${trimmedReason}`, id);
  const updated = findScheduledPost(db, id);
  if (!updated) {
    throw new ScheduledPostMutationError(
      `internal: row "${id}" disappeared after skip`,
    );
  }
  return updated;
}
