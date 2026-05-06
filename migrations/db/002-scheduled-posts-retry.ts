import type { Database } from "better-sqlite3";

/**
 * Adds retry-state columns to `scheduled_posts` so the publisher can
 * back off on transient failures (5xx / 429 / network) before marking
 * a row failed. Per §10: up to 3 retries with exponential backoff,
 * then escalate.
 *
 * Columns:
 *   - retry_count   : number of retries so far (0 = never retried)
 *   - next_retry_at : ISO datetime — earliest moment the publisher
 *                     should re-attempt. NULL when nothing pending.
 *
 * The publisher's "due" definition becomes:
 *   status='pending' AND scheduled_at <= now
 *     AND (next_retry_at IS NULL OR next_retry_at <= now)
 *
 * Existing rows backfill to retry_count=0, next_retry_at=NULL — same
 * effective behavior as today.
 */

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE scheduled_posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE scheduled_posts ADD COLUMN next_retry_at TEXT;
    CREATE INDEX idx_scheduled_posts_next_retry_at ON scheduled_posts (next_retry_at);
  `);
}

export function down(db: Database): void {
  // SQLite ALTER TABLE DROP COLUMN landed in 3.35; keeping the down()
  // simple in case we run on older binaries — recreate without the
  // columns. Index is dropped implicitly with the table.
  db.exec(`
    DROP INDEX IF EXISTS idx_scheduled_posts_next_retry_at;
    CREATE TABLE scheduled_posts__rollback (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      content TEXT NOT NULL,
      assets TEXT NOT NULL DEFAULT '[]',
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      published_at TEXT,
      published_id TEXT,
      failure_reason TEXT,
      edit_history TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO scheduled_posts__rollback
      (id, plan_id, app_id, channel, content, assets, scheduled_at,
       status, published_at, published_id, failure_reason, edit_history)
    SELECT id, plan_id, app_id, channel, content, assets, scheduled_at,
           status, published_at, published_id, failure_reason, edit_history
      FROM scheduled_posts;
    DROP TABLE scheduled_posts;
    ALTER TABLE scheduled_posts__rollback RENAME TO scheduled_posts;
    CREATE INDEX idx_scheduled_posts_status_scheduled_at ON scheduled_posts (status, scheduled_at);
    CREATE INDEX idx_scheduled_posts_app ON scheduled_posts (app_id);
  `);
}
