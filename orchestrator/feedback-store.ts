import type { Database } from "better-sqlite3";

export type FeedbackKind =
  | "approve"
  | "revise"
  | "reject"
  | "modification"
  | "clarification-answer"
  | "reprioritize"
  | "unblock"
  | "unpause"
  | "rollback"
  | "edit-before-publish"
  | "comment";

export interface RecordFeedbackInput {
  kind: FeedbackKind;
  actor: string;
  targetType: "plan" | "agent" | "signal";
  targetId: string;
  note?: string;
  contextSnapshot?: unknown;
  createdAt?: string;
}

export interface FeedbackRow {
  id: number;
  kind: string;
  actor: string;
  target_type: string;
  target_id: string;
  note: string | null;
  context_snapshot: string | null;
  created_at: string;
  excluded_from_learning: number;
}

export function recordFeedback(
  db: Database,
  input: RecordFeedbackInput,
): FeedbackRow {
  const stmt = db.prepare(`
    INSERT INTO feedback (
      kind, actor, target_type, target_id, note, context_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(
    input.kind,
    input.actor,
    input.targetType,
    input.targetId,
    input.note ?? null,
    input.contextSnapshot != null
      ? JSON.stringify(input.contextSnapshot)
      : null,
    input.createdAt ?? new Date().toISOString(),
  ) as FeedbackRow;
}

export function listFeedback(
  db: Database,
  filters: {
    kind?: FeedbackKind;
    targetType?: string;
    targetId?: string;
    limit?: number;
  } = {},
): FeedbackRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.kind) {
    where.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.targetType) {
    where.push("target_type = ?");
    params.push(filters.targetType);
  }
  if (filters.targetId) {
    where.push("target_id = ?");
    params.push(filters.targetId);
  }
  const sql =
    "SELECT * FROM feedback" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY id DESC" +
    (filters.limit ? " LIMIT ?" : "");
  if (filters.limit) params.push(filters.limit);
  return db.prepare(sql).all(...params) as FeedbackRow[];
}
