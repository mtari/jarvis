import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.ts";
import { listFeedback, recordFeedback } from "./feedback-store.ts";

describe("feedback store", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    await runMigrations(db, path.join(import.meta.dirname, "..", "migrations", "db"));
  });

  afterEach(() => {
    db.close();
  });

  it("records and reads back feedback rows", () => {
    const row = recordFeedback(db, {
      kind: "approve",
      actor: "user",
      targetType: "plan",
      targetId: "2026-04-27-test",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.note).toBeNull();
    expect(row.excluded_from_learning).toBe(0);
  });

  it("stores notes and JSON-serialized context snapshots", () => {
    const row = recordFeedback(db, {
      kind: "revise",
      actor: "user",
      targetType: "plan",
      targetId: "2026-04-27-test",
      note: "scope is wrong",
      contextSnapshot: { revision: 2 },
    });
    expect(row.note).toBe("scope is wrong");
    expect(JSON.parse(row.context_snapshot!)).toEqual({ revision: 2 });
  });

  it("lists with filters newest-first", () => {
    recordFeedback(db, {
      kind: "approve",
      actor: "user",
      targetType: "plan",
      targetId: "p1",
    });
    recordFeedback(db, {
      kind: "reject",
      actor: "user",
      targetType: "plan",
      targetId: "p2",
    });

    const approves = listFeedback(db, { kind: "approve" });
    expect(approves).toHaveLength(1);
    expect(approves[0]?.target_id).toBe("p1");

    const forP2 = listFeedback(db, { targetId: "p2" });
    expect(forP2).toHaveLength(1);
  });
});
