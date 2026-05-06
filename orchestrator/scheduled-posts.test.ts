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
  approveScheduledPost,
  countScheduledPosts,
  editScheduledPost,
  findScheduledPost,
  insertScheduledPost,
  listScheduledPosts,
  ScheduledPostMutationError,
  skipScheduledPost,
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

  // -------------------------------------------------------------------------
  // editScheduledPost
  // -------------------------------------------------------------------------

  describe("editScheduledPost", () => {
    const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

    it("replaces content + appends an edit_history entry + flips status", () => {
      insertScheduledPost(db, row("e1", { content: "old" }));
      const updated = editScheduledPost(db, "e1", {
        newContent: "new",
        actor: "cli",
        now: FIXED_NOW,
      });
      expect(updated.content).toBe("new");
      expect(updated.status).toBe("edited");
      expect(updated.editHistory).toHaveLength(1);
      const entry = updated.editHistory[0] as Record<string, unknown>;
      expect(entry["previousContent"]).toBe("old");
      expect(entry["actor"]).toBe("cli");
      expect(entry["at"]).toBe(FIXED_NOW.toISOString());
    });

    it("appends across multiple edits", () => {
      insertScheduledPost(db, row("e2", { content: "v1" }));
      editScheduledPost(db, "e2", { newContent: "v2", actor: "cli" });
      const final = editScheduledPost(db, "e2", {
        newContent: "v3",
        actor: "slack:U-x",
      });
      expect(final.editHistory).toHaveLength(2);
      expect(final.content).toBe("v3");
    });

    it("is a no-op when content is unchanged", () => {
      insertScheduledPost(db, row("e3", { content: "same" }));
      const r = editScheduledPost(db, "e3", {
        newContent: "same",
        actor: "cli",
      });
      expect(r.editHistory).toHaveLength(0);
      expect(r.status).toBe("pending");
    });

    it("rejects edit on a published row", () => {
      insertScheduledPost(db, row("e4", { status: "published" }));
      expect(() =>
        editScheduledPost(db, "e4", { newContent: "x", actor: "cli" }),
      ).toThrow(ScheduledPostMutationError);
    });

    it("rejects edit on a skipped row", () => {
      insertScheduledPost(db, row("e5", { status: "skipped" }));
      expect(() =>
        editScheduledPost(db, "e5", { newContent: "x", actor: "cli" }),
      ).toThrow(/skipped/);
    });

    it("rejects empty content", () => {
      insertScheduledPost(db, row("e6"));
      expect(() =>
        editScheduledPost(db, "e6", { newContent: "   ", actor: "cli" }),
      ).toThrow(/empty/);
    });

    it("throws on unknown id", () => {
      expect(() =>
        editScheduledPost(db, "ghost", { newContent: "x", actor: "cli" }),
      ).toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // approveScheduledPost
  // -------------------------------------------------------------------------

  describe("approveScheduledPost", () => {
    it("flips awaiting-review → pending", () => {
      insertScheduledPost(db, row("a1", { status: "awaiting-review" }));
      const updated = approveScheduledPost(db, "a1", { actor: "cli" });
      expect(updated.status).toBe("pending");
    });

    it("flips edited → pending (post-edit re-review case)", () => {
      insertScheduledPost(db, row("a2", { status: "edited" }));
      const updated = approveScheduledPost(db, "a2", { actor: "cli" });
      expect(updated.status).toBe("pending");
    });

    it("clears any prior failure_reason on approve", () => {
      insertScheduledPost(db, row("a3", { status: "awaiting-review" }));
      db.prepare(
        "UPDATE scheduled_posts SET failure_reason = ? WHERE id = ?",
      ).run("stale note", "a3");
      const updated = approveScheduledPost(db, "a3", { actor: "cli" });
      expect(updated.failureReason).toBeNull();
    });

    it("is idempotent on already-pending rows", () => {
      insertScheduledPost(db, row("a4", { status: "pending" }));
      const updated = approveScheduledPost(db, "a4", { actor: "cli" });
      expect(updated.status).toBe("pending");
    });

    it("rejects approve on published rows", () => {
      insertScheduledPost(db, row("a5", { status: "published" }));
      expect(() =>
        approveScheduledPost(db, "a5", { actor: "cli" }),
      ).toThrow(/published/);
    });

    it("rejects approve on skipped rows", () => {
      insertScheduledPost(db, row("a6", { status: "skipped" }));
      expect(() =>
        approveScheduledPost(db, "a6", { actor: "cli" }),
      ).toThrow(ScheduledPostMutationError);
    });

    it("rejects approve on failed rows", () => {
      insertScheduledPost(db, row("a7", { status: "failed" }));
      expect(() =>
        approveScheduledPost(db, "a7", { actor: "cli" }),
      ).toThrow(/failed/);
    });

    it("rejects empty actor", () => {
      insertScheduledPost(db, row("a8", { status: "awaiting-review" }));
      expect(() =>
        approveScheduledPost(db, "a8", { actor: "  " }),
      ).toThrow(/actor/);
    });

    it("throws on unknown id", () => {
      expect(() =>
        approveScheduledPost(db, "ghost", { actor: "cli" }),
      ).toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // skipScheduledPost
  // -------------------------------------------------------------------------

  describe("skipScheduledPost", () => {
    it("flips status to skipped and records the reason", () => {
      insertScheduledPost(db, row("s1"));
      const updated = skipScheduledPost(db, "s1", {
        reason: "off-brand after second pass",
        actor: "cli",
      });
      expect(updated.status).toBe("skipped");
      expect(updated.failureReason).toContain("off-brand");
      expect(updated.failureReason).toContain("cli");
    });

    it("is idempotent on already-skipped rows", () => {
      insertScheduledPost(db, row("s2", { status: "skipped" }));
      const r = skipScheduledPost(db, "s2", { reason: "x", actor: "cli" });
      expect(r.status).toBe("skipped");
    });

    it("rejects skip on a published row", () => {
      insertScheduledPost(db, row("s3", { status: "published" }));
      expect(() =>
        skipScheduledPost(db, "s3", { reason: "x", actor: "cli" }),
      ).toThrow(/published/);
    });

    it("rejects empty reason", () => {
      insertScheduledPost(db, row("s4"));
      expect(() =>
        skipScheduledPost(db, "s4", { reason: "  ", actor: "cli" }),
      ).toThrow(/empty/);
    });

    it("throws on unknown id", () => {
      expect(() =>
        skipScheduledPost(db, "ghost", { reason: "x", actor: "cli" }),
      ).toThrow(/not found/);
    });
  });
});
