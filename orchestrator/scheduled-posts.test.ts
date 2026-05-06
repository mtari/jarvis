import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbFile } from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  countScheduledPosts,
  findScheduledPost,
  insertScheduledPost,
  listScheduledPosts,
} from "./scheduled-posts.ts";

describe("scheduled-posts store", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function row(id: string, overrides: Partial<Parameters<typeof insertScheduledPost>[1]> = {}): Parameters<typeof insertScheduledPost>[1] {
    return {
      id,
      planId: "plan-1",
      appId: "demo",
      channel: "facebook",
      content: "hi",
      assets: [],
      scheduledAt: "2026-04-08T09:00:00.000Z",
      ...overrides,
    };
  }

  it("round-trips a row", () => {
    insertScheduledPost(db, row("p1"));
    const got = findScheduledPost(db, "p1");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("p1");
    expect(got?.status).toBe("pending");
    expect(got?.assets).toEqual([]);
    expect(got?.publishedAt).toBeNull();
    expect(got?.editHistory).toEqual([]);
  });

  it("preserves assets through JSON round-trip", () => {
    insertScheduledPost(db, row("p2", { assets: ["hero.jpg", "video.mp4"] }));
    expect(findScheduledPost(db, "p2")?.assets).toEqual(["hero.jpg", "video.mp4"]);
  });

  it("returns null for unknown id", () => {
    expect(findScheduledPost(db, "nope")).toBeNull();
  });

  it("filters by planId / appId / status", () => {
    insertScheduledPost(db, row("a1", { planId: "plan-1" }));
    insertScheduledPost(db, row("a2", { planId: "plan-2" }));
    insertScheduledPost(db, row("a3", { planId: "plan-1", status: "published" }));
    expect(listScheduledPosts(db, { planId: "plan-1" })).toHaveLength(2);
    expect(listScheduledPosts(db, { status: "published" })).toHaveLength(1);
    expect(
      listScheduledPosts(db, { planId: "plan-1", status: "pending" }),
    ).toHaveLength(1);
  });

  it("orders by scheduledAt ascending", () => {
    insertScheduledPost(db, row("c", { scheduledAt: "2026-05-01T09:00:00.000Z" }));
    insertScheduledPost(db, row("a", { scheduledAt: "2026-04-01T09:00:00.000Z" }));
    insertScheduledPost(db, row("b", { scheduledAt: "2026-04-15T09:00:00.000Z" }));
    expect(listScheduledPosts(db).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("dueBefore filter selects only past-due rows", () => {
    insertScheduledPost(db, row("past", { scheduledAt: "2026-01-01T09:00:00.000Z" }));
    insertScheduledPost(db, row("future", { scheduledAt: "2027-01-01T09:00:00.000Z" }));
    const due = listScheduledPosts(db, { dueBefore: "2026-06-01T00:00:00.000Z" });
    expect(due.map((r) => r.id)).toEqual(["past"]);
  });

  it("count helper returns matches", () => {
    expect(countScheduledPosts(db, { planId: "plan-1" })).toBe(0);
    insertScheduledPost(db, row("x", { planId: "plan-1" }));
    insertScheduledPost(db, row("y", { planId: "plan-1" }));
    expect(countScheduledPosts(db, { planId: "plan-1" })).toBe(2);
  });

  it("rejects duplicate ids (UNIQUE constraint surfaces)", () => {
    insertScheduledPost(db, row("dup"));
    expect(() => insertScheduledPost(db, row("dup"))).toThrow();
  });

  it("limit caps the result count", () => {
    for (let i = 0; i < 5; i += 1) {
      insertScheduledPost(db, row(`r${i}`, {
        scheduledAt: `2026-04-0${i + 1}T09:00:00.000Z`,
      }));
    }
    expect(listScheduledPosts(db, { limit: 2 })).toHaveLength(2);
  });

  it("treats malformed assets JSON as empty array (defensive)", () => {
    insertScheduledPost(db, row("bad"));
    db.prepare("UPDATE scheduled_posts SET assets = ? WHERE id = ?").run(
      "not-json",
      "bad",
    );
    expect(findScheduledPost(db, "bad")?.assets).toEqual([]);
  });
});
