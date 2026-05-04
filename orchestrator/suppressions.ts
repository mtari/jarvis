import Database from "better-sqlite3";

/**
 * Suppressions are "stop bothering me about this" markers Analyst checks
 * before auto-drafting plans from signals. A suppression matches a signal
 * when its `pattern_id` equals the signal's `dedupKey`. Active means: no
 * `cleared_at` and `expires_at` is either null or in the future.
 *
 * The schema lives under `migrations/db/001-initial-schema.ts`. Columns:
 *   - pattern_id     PRIMARY KEY  — match key (typically the signal dedupKey)
 *   - pattern        TEXT NOT NULL — human-readable description
 *   - reason         TEXT          — why we're muting (optional)
 *   - suppressed_at  TEXT NOT NULL — ISO datetime
 *   - expires_at     TEXT          — when the mute auto-lifts (optional)
 *   - cleared_at     TEXT          — set by `unsuppress` to soft-delete
 *
 * `pattern_id` is PRIMARY KEY so calling `suppress(...)` twice on the
 * same id refreshes the row (UPSERT).
 */

export interface Suppression {
  patternId: string;
  pattern: string;
  reason: string | null;
  suppressedAt: string;
  expiresAt: string | null;
  clearedAt: string | null;
}

export interface SuppressInput {
  patternId: string;
  /** Human description shown by `yarn jarvis suppressions`. */
  pattern: string;
  reason?: string;
  /** ISO datetime when the mute auto-lifts. Omit for indefinite. */
  expiresAt?: string;
}

/**
 * Returns true when an active suppression matches `patternId`. Active =
 * `cleared_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now`).
 * Used by `autoDraftFromSignals` to short-circuit suppressed signals
 * before calling Strategist.
 */
export function isSuppressed(
  dbFilePath: string,
  patternId: string,
  now: Date = new Date(),
): boolean {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT expires_at, cleared_at FROM suppressions WHERE pattern_id = ?",
      )
      .get(patternId) as
      | { expires_at: string | null; cleared_at: string | null }
      | undefined;
    if (!row) return false;
    if (row.cleared_at !== null) return false;
    if (row.expires_at !== null && row.expires_at <= now.toISOString()) {
      return false;
    }
    return true;
  } finally {
    db.close();
  }
}

/**
 * Records or refreshes a suppression. Existing rows with the same
 * `patternId` are overwritten (cleared_at reset to null) — this is the
 * "re-mute after un-mute" path.
 */
export function suppress(
  dbFilePath: string,
  input: SuppressInput,
  now: Date = new Date(),
): void {
  const db = new Database(dbFilePath);
  try {
    db.prepare(
      `INSERT INTO suppressions (pattern_id, pattern, reason, suppressed_at, expires_at, cleared_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(pattern_id) DO UPDATE SET
         pattern = excluded.pattern,
         reason = excluded.reason,
         suppressed_at = excluded.suppressed_at,
         expires_at = excluded.expires_at,
         cleared_at = NULL`,
    ).run(
      input.patternId,
      input.pattern,
      input.reason ?? null,
      now.toISOString(),
      input.expiresAt ?? null,
    );
  } finally {
    db.close();
  }
}

/**
 * Soft-deletes a suppression by setting `cleared_at` to now. The row stays
 * in the table for audit. A subsequent `suppress(...)` call resets
 * `cleared_at` to null. Returns true when a matching row was cleared.
 */
export function unsuppress(
  dbFilePath: string,
  patternId: string,
  now: Date = new Date(),
): boolean {
  const db = new Database(dbFilePath);
  try {
    const result = db
      .prepare(
        "UPDATE suppressions SET cleared_at = ? WHERE pattern_id = ? AND cleared_at IS NULL",
      )
      .run(now.toISOString(), patternId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

/**
 * Lists every suppression. By default only returns active ones; pass
 * `{includeCleared: true}` to also see soft-deleted history.
 */
export function listSuppressions(
  dbFilePath: string,
  opts: { includeCleared?: boolean } = {},
  now: Date = new Date(),
): Suppression[] {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT pattern_id, pattern, reason, suppressed_at, expires_at, cleared_at FROM suppressions ORDER BY suppressed_at DESC",
      )
      .all() as Array<{
      pattern_id: string;
      pattern: string;
      reason: string | null;
      suppressed_at: string;
      expires_at: string | null;
      cleared_at: string | null;
    }>;
    const out: Suppression[] = [];
    const nowIso = now.toISOString();
    for (const r of rows) {
      const active =
        r.cleared_at === null &&
        (r.expires_at === null || r.expires_at > nowIso);
      if (!active && !opts.includeCleared) continue;
      out.push({
        patternId: r.pattern_id,
        pattern: r.pattern,
        reason: r.reason,
        suppressedAt: r.suppressed_at,
        expiresAt: r.expires_at,
        clearedAt: r.cleared_at,
      });
    }
    return out;
  } finally {
    db.close();
  }
}
