import type { Database } from "better-sqlite3";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_events_app_id ON events (app_id);
    CREATE INDEX idx_events_kind ON events (kind);
    CREATE INDEX idx_events_created_at ON events (created_at);

    CREATE TABLE agent_state (
      agent TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      window_outcomes TEXT NOT NULL DEFAULT '[]',
      tripped_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent, scope)
    );

    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      note TEXT,
      context_snapshot TEXT,
      created_at TEXT NOT NULL,
      excluded_from_learning INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_feedback_target ON feedback (target_type, target_id);
    CREATE INDEX idx_feedback_kind ON feedback (kind);
    CREATE INDEX idx_feedback_created_at ON feedback (created_at);

    CREATE TABLE suppressions (
      pattern_id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      reason TEXT,
      suppressed_at TEXT NOT NULL,
      expires_at TEXT,
      cleared_at TEXT
    );

    CREATE TABLE scheduled_posts (
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
    CREATE INDEX idx_scheduled_posts_status_scheduled_at ON scheduled_posts (status, scheduled_at);
    CREATE INDEX idx_scheduled_posts_app ON scheduled_posts (app_id);

    CREATE TABLE vault_state (
      vault_id TEXT PRIMARY KEY,
      remote TEXT,
      last_pushed_at TEXT,
      last_pulled_at TEXT,
      ahead INTEGER NOT NULL DEFAULT 0,
      behind INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

export function down(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS vault_state;
    DROP TABLE IF EXISTS scheduled_posts;
    DROP TABLE IF EXISTS suppressions;
    DROP TABLE IF EXISTS feedback;
    DROP TABLE IF EXISTS agent_state;
    DROP TABLE IF EXISTS events;
  `);
}
