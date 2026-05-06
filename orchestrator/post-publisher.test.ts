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
  buildAdapterRegistry,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type PublishResult,
} from "../tools/channels/types.ts";

function fallbackRegistry(
  adapters: ReadonlyArray<ChannelAdapter>,
): ChannelAdapterRegistry {
  return buildAdapterRegistry(
    adapters.map((adapter, i) => ({ adapter, name: `test-adapter-${i}` })),
  );
}
import {
  insertScheduledPost,
  listScheduledPosts,
  type ScheduledPostInput,
} from "./scheduled-posts.ts";
import {
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_STALE_GRACE_MS,
  flagStaleWindowPosts,
  publishDuePosts,
} from "./post-publisher.ts";

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
      adapters: fallbackRegistry([adapter]),
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
      adapters: fallbackRegistry([adapter]),
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
      adapters: fallbackRegistry([adapter]),
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
      adapters: fallbackRegistry([adapter]),
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

  it("marks rows failed when no adapter is registered for the channel", async () => {
    insertScheduledPost(db, row("p1", { channel: "tiktok" }));
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([]),
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
      adapters: fallbackRegistry([adapter]),
      now: new Date("2027-01-01T00:00:00.000Z"),
      maxPerTick: 3,
    });
    expect(result.examined).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("dispatches by (channel, appId) — per-app adapter wins over fallback", async () => {
    insertScheduledPost(db, row("erdei-post", { appId: "erdei" }));
    insertScheduledPost(db, row("kuna-post", { appId: "kuna" }));
    insertScheduledPost(db, row("other-post", { appId: "other" }));
    const erdeiAdapter = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "fb-erdei",
    });
    const kunaAdapter = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "fb-kuna",
    });
    const fallback = recordingAdapter(["facebook"], {
      ok: true,
      publishedId: "fb-fallback",
    });
    const registry = buildAdapterRegistry([
      { adapter: fallback.adapter, name: "fb-fallback" },
      { adapter: erdeiAdapter.adapter, appId: "erdei", name: "fb-erdei" },
      { adapter: kunaAdapter.adapter, appId: "kuna", name: "fb-kuna" },
    ]);
    await publishDuePosts({
      db,
      adapters: registry,
      now: new Date("2026-04-09T00:00:00.000Z"),
    });
    expect(erdeiAdapter.calls.map((c) => c.postId)).toEqual(["erdei-post"]);
    expect(kunaAdapter.calls.map((c) => c.postId)).toEqual(["kuna-post"]);
    expect(fallback.calls.map((c) => c.postId)).toEqual(["other-post"]);
  });

  it("dispatches by channel — instagram row goes to instagram adapter", async () => {
    insertScheduledPost(db, row("fb", { channel: "facebook" }));
    insertScheduledPost(db, row("ig", { channel: "instagram" }));
    const fb = recordingAdapter(["facebook"], { ok: true, publishedId: "fb-1" });
    const ig = recordingAdapter(["instagram"], { ok: true, publishedId: "ig-1" });
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([fb.adapter, ig.adapter]),
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
      adapters: fallbackRegistry([adapter]),
    });
    expect(result.examined).toBe(0);
    expect(result.published).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Retry / backoff on transient failures
  // -------------------------------------------------------------------------

  it("DEFAULT_RETRY_BACKOFF_MS is 1m / 5m / 15m", () => {
    expect(DEFAULT_RETRY_BACKOFF_MS).toEqual([
      60_000,
      5 * 60_000,
      15 * 60_000,
    ]);
  });

  it("transient failure schedules a retry — row stays pending with next_retry_at set", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter } = recordingAdapter(["facebook"], {
      ok: false,
      reason: "rate-limited",
      transient: true,
    });
    const now = new Date("2026-04-09T12:00:00.000Z");
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now,
      retryBackoffMs: [60_000],
    });
    expect(result.examined).toBe(1);
    expect(result.published).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.retrying).toHaveLength(1);
    expect(result.retrying[0]?.attempt).toBe(1);
    expect(result.retrying[0]?.nextRetryAt).toBe(
      "2026-04-09T12:01:00.000Z",
    );

    const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
    expect(updated?.status).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.nextRetryAt).toBe("2026-04-09T12:01:00.000Z");
    expect(updated?.failureReason).toBe("rate-limited");

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-publish-retry'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      postId: "p1",
      attempt: 1,
    });
  });

  it("publisher skips rows whose next_retry_at hasn't elapsed", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter, calls } = recordingAdapter(["facebook"], {
      ok: false,
      reason: "down",
      transient: true,
    });
    // First attempt — schedules retry with 60s backoff.
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:00.000Z"),
      retryBackoffMs: [60_000, 300_000],
    });
    // 30s later — backoff window not elapsed; row should be skipped.
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:30.000Z"),
      retryBackoffMs: [60_000, 300_000],
    });
    expect(result.examined).toBe(0);
    // Adapter only called once (the original attempt)
    expect(calls).toHaveLength(1);
  });

  it("publisher re-attempts after next_retry_at elapses — eventual success clears retry state", async () => {
    insertScheduledPost(db, row("p1"));
    let i = 0;
    const adapter = {
      channels: ["facebook"],
      async publish() {
        i += 1;
        if (i === 1) {
          return {
            ok: false,
            reason: "rate-limited",
            transient: true,
          } as const;
        }
        return { ok: true, publishedId: "fb-ok" } as const;
      },
    };
    // Attempt 1 fails transiently.
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:00.000Z"),
      retryBackoffMs: [60_000],
    });
    // Attempt 2, 90s later, succeeds.
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:01:30.000Z"),
      retryBackoffMs: [60_000],
    });
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.publishedId).toBe("fb-ok");

    const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
    expect(updated?.status).toBe("published");
    expect(updated?.nextRetryAt).toBeNull();

    const publishedEvent = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-published'")
      .get() as { payload: string };
    expect(JSON.parse(publishedEvent.payload)).toMatchObject({
      postId: "p1",
      retriesSpent: 1,
    });
  });

  it("transient → transient → ... → exhausts retries → marked failed with retry counter", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter } = recordingAdapter(["facebook"], {
      ok: false,
      reason: "still down",
      transient: true,
    });
    const backoff = [60_000, 120_000];
    // Attempt 1 → retry 1 scheduled
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:00.000Z"),
      retryBackoffMs: backoff,
    });
    // Attempt 2 (retry 1) → retry 2 scheduled
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:01:30.000Z"),
      retryBackoffMs: backoff,
    });
    // Attempt 3 (retry 2) → retries exhausted → failed
    const final = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:05:00.000Z"),
      retryBackoffMs: backoff,
    });
    expect(final.failed).toHaveLength(1);
    expect(final.failed[0]?.reason).toContain("after 2 retries");
    expect(final.retrying).toHaveLength(0);

    const updated = listScheduledPosts(db, { planId: "plan-1" })[0];
    expect(updated?.status).toBe("failed");
    expect(updated?.nextRetryAt).toBeNull();
    expect(updated?.retryCount).toBe(2);

    const failedEvent = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-publish-failed'")
      .get() as { payload: string };
    expect(JSON.parse(failedEvent.payload)).toMatchObject({
      postId: "p1",
      retriesSpent: 2,
    });
  });

  it("non-transient failure goes straight to failed (no retry)", async () => {
    insertScheduledPost(db, row("p1"));
    const { adapter } = recordingAdapter(["facebook"], {
      ok: false,
      reason: "bad token",
      // transient: undefined → treated as non-transient
    });
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:00.000Z"),
    });
    expect(result.failed).toHaveLength(1);
    expect(result.retrying).toEqual([]);
    expect(listScheduledPosts(db)[0]?.status).toBe("failed");
    expect(listScheduledPosts(db)[0]?.retryCount).toBe(0);
  });

  it("non-transient failure even after prior transient retries goes to failed (no further retry)", async () => {
    insertScheduledPost(db, row("p1"));
    let i = 0;
    const adapter = {
      channels: ["facebook"],
      async publish() {
        i += 1;
        if (i === 1) {
          return { ok: false, reason: "down", transient: true } as const;
        }
        // Second call comes back non-transient (e.g. token revoked)
        return { ok: false, reason: "bad token" } as const;
      },
    };
    await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:00:00.000Z"),
      retryBackoffMs: [60_000],
    });
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([adapter]),
      now: new Date("2026-04-09T12:02:00.000Z"),
      retryBackoffMs: [60_000],
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBe("bad token");
    expect(listScheduledPosts(db)[0]?.status).toBe("failed");
  });

  it("adapter throwing is treated as transient (defense in depth)", async () => {
    insertScheduledPost(db, row("p1"));
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([throwingAdapter(["facebook"], "boom")]),
      now: new Date("2026-04-09T12:00:00.000Z"),
      retryBackoffMs: [60_000],
    });
    expect(result.retrying).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(listScheduledPosts(db)[0]?.status).toBe("pending");
    expect(listScheduledPosts(db)[0]?.retryCount).toBe(1);
  });

  it("missing adapter is NOT retried — fails immediately", async () => {
    insertScheduledPost(db, row("p1", { channel: "tiktok" }));
    const result = await publishDuePosts({
      db,
      adapters: fallbackRegistry([]),
      now: new Date("2026-04-09T12:00:00.000Z"),
    });
    expect(result.failed).toHaveLength(1);
    expect(result.retrying).toEqual([]);
    expect(listScheduledPosts(db)[0]?.retryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flagStaleWindowPosts
// ---------------------------------------------------------------------------

describe("flagStaleWindowPosts", () => {
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

  it("DEFAULT_STALE_GRACE_MS is 1 hour", () => {
    expect(DEFAULT_STALE_GRACE_MS).toBe(60 * 60 * 1000);
  });

  it("flags rows past scheduled_at + grace + emits one event each", () => {
    insertScheduledPost(db, row("p1", {
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    insertScheduledPost(db, row("p2", {
      scheduledAt: "2026-04-08T10:00:00.000Z",
    }));
    // 5 hours later, both should be stale
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T14:00:00.000Z"),
    });
    expect(result.flagged).toHaveLength(2);
    expect(result.alreadyFlagged).toBe(0);
    expect(result.flagged[0]?.postId).toBe("p1");
    expect(result.flagged[0]?.hoursLate).toBeGreaterThan(4.9);

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-window-missed'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      postId: "p1",
      channel: "facebook",
    });
  });

  it("does not flag rows within the grace window", () => {
    insertScheduledPost(db, row("recent", {
      scheduledAt: "2026-04-08T09:30:00.000Z",
    }));
    // 30 minutes later — within the default 1h grace
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T10:00:00.000Z"),
    });
    expect(result.flagged).toEqual([]);
  });

  it("does not flag future rows", () => {
    insertScheduledPost(db, row("future", {
      scheduledAt: "2027-01-01T09:00:00.000Z",
    }));
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T09:00:00.000Z"),
    });
    expect(result.flagged).toEqual([]);
  });

  it("only flags pending rows — published / skipped / failed are ignored", () => {
    insertScheduledPost(db, row("done", {
      status: "published",
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    insertScheduledPost(db, row("nope", {
      status: "skipped",
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    insertScheduledPost(db, row("err", {
      status: "failed",
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T14:00:00.000Z"),
    });
    expect(result.flagged).toEqual([]);
  });

  it("is idempotent — re-running on already-flagged rows is a no-op", () => {
    insertScheduledPost(db, row("p1", {
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    const first = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T14:00:00.000Z"),
    });
    expect(first.flagged).toHaveLength(1);

    const second = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T15:00:00.000Z"),
    });
    expect(second.flagged).toEqual([]);
    expect(second.alreadyFlagged).toBe(1);

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'post-window-missed'")
      .all() as Array<unknown>;
    expect(events).toHaveLength(1);
  });

  it("respects a custom graceMs", () => {
    insertScheduledPost(db, row("recent", {
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    // 5 minutes later — within default 1h, but past 1-minute grace
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T09:05:00.000Z"),
      graceMs: 60 * 1000,
    });
    expect(result.flagged).toHaveLength(1);
  });

  it("respects maxPerCall", () => {
    for (let i = 0; i < 5; i += 1) {
      insertScheduledPost(db, row(`p${i}`, {
        scheduledAt: `2026-04-0${i + 1}T09:00:00.000Z`,
      }));
    }
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2027-01-01T00:00:00.000Z"),
      maxPerCall: 2,
    });
    expect(result.flagged).toHaveLength(2);
  });

  it("hoursLate is well-formed", () => {
    insertScheduledPost(db, row("p1", {
      scheduledAt: "2026-04-08T09:00:00.000Z",
    }));
    const result = flagStaleWindowPosts({
      db,
      now: new Date("2026-04-08T13:00:00.000Z"),
    });
    expect(result.flagged[0]?.hoursLate).toBeCloseTo(4, 1);
  });
});
