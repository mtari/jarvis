import type { Database } from "better-sqlite3";

export interface AppendEventInput {
  appId: string;
  vaultId: string;
  kind: string;
  payload: unknown;
  createdAt?: string;
}

export interface EventRow {
  id: number;
  app_id: string;
  vault_id: string;
  kind: string;
  payload: string;
  created_at: string;
}

export function appendEvent(db: Database, input: AppendEventInput): EventRow {
  const stmt = db.prepare(
    "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
  );
  return stmt.get(
    input.appId,
    input.vaultId,
    input.kind,
    JSON.stringify(input.payload),
    input.createdAt ?? new Date().toISOString(),
  ) as EventRow;
}

export function listEvents(
  db: Database,
  filters: { appId?: string; kind?: string; limit?: number } = {},
): EventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.appId) {
    where.push("app_id = ?");
    params.push(filters.appId);
  }
  if (filters.kind) {
    where.push("kind = ?");
    params.push(filters.kind);
  }
  const sql =
    "SELECT * FROM events" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY id DESC" +
    (filters.limit ? " LIMIT ?" : "");
  if (filters.limit) params.push(filters.limit);
  return db.prepare(sql).all(...params) as EventRow[];
}
