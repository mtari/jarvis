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
  buildAdapterMap,
  type ChannelAdapter,
  type PublishResult,
} from "../tools/channels/types.ts";
import {
  insertScheduledPost,
  listScheduledPosts,
  type ScheduledPostInput,
} from "./scheduled-posts.ts";
import { publishDuePosts } from "./post-publisher.ts";

function row(
  id: string,
  overrides: Partial<ScheduledPostInput> = {},
): ScheduledPostInput {
  return {
    id,
    planId: "plan-1",
    appId: "demo",
    channel: "facebook",
    content: "hello",
    assets: [],
    scheduledAt: "2026-04-08T09:00:00.000Z",
    ...overrides,
  };
}

function recordingAdapter(
  channels: string[],
  result: PublishResult,
): { adapter: ChannelAdapter; calls: Array<{ postId: string }> } {
  const calls: Array<{ postId: string }> = [];
  return {
    calls,
    adapter: {
      channels,
      async publish(input) {
        calls.push({ postId: input.postId });
        return result;
      },
    },
  };
}

function throwingAdapter(channels: string[], message: string): ChannelAdapter {
  return {
    channels,
    async publish() {
      throw new Error(message);
    },
  };
}

describe("publishDuePosts", () => {
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

  it("publishes due pending rows + flips status + records event", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter, calls } = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "fb-123",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.examined).toBe(1);
    expect(result.published).toEqual([
      { postId: "p1", channel: "facebook", publishedId: "fb-123" },
    ]);
    expect(calls).toHaveLength(1);

    const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
    expect(updated?.status).toBe("published");
    expect(updated?.publishedId).toBe("fb-123");
    expect(updated?.publishedAt).toBe("2026-04-09T00:00:00.000Z");

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-published'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      postId: "p1",
      publishedId: "fb-123",
    });
  });

  it("skips rows scheduled in the future", async () => {
    insertScheduledPost(db, row("future", {
      scheduledAt: "2027-01-01T00:00:00.000Z",
    }));
    const { adapter, calls } = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "x",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.examined).toBe(0);
    expect(calls).toHaveLength(0);
    expect(listScheduledPosts(db)[0]?.status).toBe("pending");
  });

  it("skips rows that are not pending", async () => {
    insertScheduledPost(db, row("done", { status: "published" }));
    insertScheduledPost(db, row("skipped", { status: "skipped" }));
    insertScheduledPost(db, row("failed-prev", { status: "failed" }));
    const { adapter, calls } = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "x",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.examined).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("marks rows failed on adapter ok:false", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter } = recordingAdapter(["facebook"], {
      ok: false,
      reason: "rate-limited",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.failed).toEqual([
      { postId: "p1", channel: "facebook", reason: "rate-limited" },
    ]);
    const updated = listScheduledPosts(db)[0];
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("rate-limited");

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-publish-failed'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
  });

  it("marks rows failed when adapter throws", async () => {
    insertScheduledPost(db, row("p1"));
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([throwingAdapter(["facebook"], "boom")]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.failed[0]?.reason).toContain("boom");
    expect(listScheduledPosts(db)[0]?.status).toBe("failed");
  });

  it("marks rows failed when no adapter is registered for the channel", async () => {
    insertScheduledPost(db, row("p1", { channel: "tiktok" }));
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(result.failed[0]?.reason).toContain("no adapter");
    expect(listScheduledPosts(db)[0]?.status).toBe("failed");
  });

  it("respects maxPerTick", async () => {
    for (let i = 0; i < 10; i += 1) {
      insertScheduledPost(db, row(`p${i}`, {
        scheduledAt: `2026-04-0${(i % 9) + 1}T09:00:00.000Z`,
      }));
    }
    const { adapter, calls } = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "x",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
      now: new Date("2027-01-01T00:00:00.000Z"),
      maxPerTick: 3,
    });
    expect(result.examined).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("dispatches by channel — instagram row goes to instagram adapter", async () => {
    insertScheduledPost(db, row("fb", { channel: "facebook" }));
    insertScheduledPost(db, row("ig", { channel: "instagram" }));
    const fb = recordingAdapter(["facebook"], { ok: true, publishedId: "fb-1" });
    const ig = recordingAdapter(["instagram"], { ok: true, publishedId: "ig-1" });
    await publishDuePosts({
      db,
      adapters: buildAdapterMap([fb.adapter, ig.adapter]),
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(fb.calls.map((c) => c.postId)).toEqual(["fb"]);
    expect(ig.calls.map((c) => c.postId)).toEqual(["ig"]);
  });

  it("returns empty result when no candidates", async () => {
    const { adapter } = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "x",
    });
    const result = await publishDuePosts({
      db,
      adapters: buildAdapterMap([adapter]),
    });
    expect(result.examined).toBe(0);
    expect(result.published).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
