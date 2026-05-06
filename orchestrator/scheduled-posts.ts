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
  };
}

function assertStatus(s: string): ScheduledPostStatus {
  switch (s) {
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
