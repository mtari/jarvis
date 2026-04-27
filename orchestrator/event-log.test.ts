import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.ts";
import { appendEvent, listEvents } from "./event-log.ts";

describe("event log", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    await runMigrations(db, path.join(import.meta.dirname, "..", "migrations", "db"));
  });

  afterEach(() => {
    db.close();
  });

  it("appends and returns the new row", () => {
    const row = appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "plan-transition",
      payload: { planId: "p1", from: "draft", to: "awaiting-review" },
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.app_id).toBe("jarvis");
    expect(JSON.parse(row.payload)).toEqual({
      planId: "p1",
      from: "draft",
      to: "awaiting-review",
    });
  });

  it("lists events newest-first with filters", () => {
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "plan-transition",
      payload: { id: 1 },
    });
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "metric-observation",
      payload: { value: 42 },
    });
    appendEvent(db, {
      appId: "other-app",
      vaultId: "personal",
      kind: "plan-transition",
      payload: { id: 3 },
    });

    const transitions = listEvents(db, { kind: "plan-transition" });
    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.id).toBeGreaterThan(transitions[1]!.id);

    const jarvisOnly = listEvents(db, { appId: "jarvis" });
    expect(jarvisOnly.every((e) => e.app_id === "jarvis")).toBe(true);

    const limited = listEvents(db, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
