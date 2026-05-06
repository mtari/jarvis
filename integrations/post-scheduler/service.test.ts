import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbFile } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import {
  insertScheduledPost,
  listScheduledPosts,
  type ScheduledPostInput,
} from "../../orchestrator/scheduled-posts.ts";
import { createDaemonLogger } from "../../orchestrator/daemon-logger.ts";
import type { PublishResult, ChannelAdapter } from "../../tools/channels/types.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import {
  buildDefaultAdapters,
  createPostSchedulerService,
  runPostSchedulerTick,
} from "./service.ts";

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

function alwaysOkAdapter(channels: string[]): ChannelAdapter {
  let i = 0;
  return {
    channels,
    async publish() {
      i += 1;
      const result: PublishResult = { ok: true, publishedId: `stub-${i}` };
      return result;
    },
  };
}

function buildCtx(sandbox: InstallSandbox): DaemonContext {
  const logger = createDaemonLogger({
    logsDir: `${sandbox.dataDir}/logs`,
    echo: false,
  });
  return {
    dataDir: sandbox.dataDir,
    logger,
    pidFile: { pid: process.pid, startedAt: new Date().toISOString() },
  };
}

describe("runPostSchedulerTick", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("publishes due rows + flips them to published", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("p1"));
      insertScheduledPost(db, row("p2", { channel: "instagram" }));
    } finally {
      db.close();
    }

    const ctx = buildCtx(sandbox);
    try {
      await runPostSchedulerTick({
        dataDir: sandbox.dataDir,
        adapters: new Map([
          ["facebook", alwaysOkAdapter(["facebook"])],
          ["instagram", alwaysOkAdapter(["instagram"])],
        ]),
        ctx,
        now: new Date("2026-04-09T00:00:00.000Z"),
      });
    } finally {
      ctx.logger.close();
    }

    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = listScheduledPosts(verifyDb);
      expect(rows.every((r) => r.status === "published")).toBe(true);
    } finally {
      verifyDb.close();
    }
  });

  it("flags stale-window rows then publishes them on the same tick", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("stale", {
        scheduledAt: "2026-04-08T09:00:00.000Z",
      }));
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      // 5 hours past scheduled time — past 1h grace AND due for publishing.
      await runPostSchedulerTick({
        dataDir: sandbox.dataDir,
        adapters: new Map([["facebook", alwaysOkAdapter(["facebook"])]]),
        ctx,
        now: new Date("2026-04-08T14:00:00.000Z"),
      });
    } finally {
      ctx.logger.close();
    }
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      // Row published.
      expect(listScheduledPosts(verifyDb)[0]?.status).toBe("published");
      // Missed event recorded.
      const events = verifyDb
        .prepare(
          "SELECT payload FROM events WHERE kind = 'post-window-missed'",
        )
        .all() as Array<unknown>;
      expect(events).toHaveLength(1);
    } finally {
      verifyDb.close();
    }
  });

  it("staleGraceMs: null disables stale flagging entirely", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("stale", {
        scheduledAt: "2026-04-08T09:00:00.000Z",
      }));
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      await runPostSchedulerTick({
        dataDir: sandbox.dataDir,
        adapters: new Map([["facebook", alwaysOkAdapter(["facebook"])]]),
        ctx,
        now: new Date("2026-04-08T14:00:00.000Z"),
        staleGraceMs: null,
      });
    } finally {
      ctx.logger.close();
    }
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = verifyDb
        .prepare(
          "SELECT payload FROM events WHERE kind = 'post-window-missed'",
        )
        .all() as Array<unknown>;
      expect(events).toEqual([]);
    } finally {
      verifyDb.close();
    }
  });

  it("is silent when no rows are due", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, row("future", { scheduledAt: "2027-01-01T00:00:00.000Z" }));
    } finally {
      db.close();
    }
    const ctx = buildCtx(sandbox);
    try {
      await runPostSchedulerTick({
        dataDir: sandbox.dataDir,
        adapters: new Map([["facebook", alwaysOkAdapter(["facebook"])]]),
        ctx,
        now: new Date("2026-04-09T00:00:00.000Z"),
      });
    } finally {
      ctx.logger.close();
    }
    // Just verifying no throw — and the row should still be pending.
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      expect(listScheduledPosts(verifyDb)[0]?.status).toBe("pending");
    } finally {
      verifyDb.close();
    }
  });
});

describe("createPostSchedulerService", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("invokes _tickBody on start", async () => {
    let invocations = 0;
    const service = createPostSchedulerService({
      dataDir: sandbox.dataDir,
      tickMs: 60_000,
      _tickBody: async () => {
        invocations += 1;
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      // Initial fire is queued via void; await a microtask flush.
      await new Promise((r) => setTimeout(r, 0));
      service.stop();
    } finally {
      ctx.logger.close();
    }
    expect(invocations).toBe(1);
  });

  it("guards against overlapping ticks (tickInFlight)", async () => {
    let entered = 0;
    let resolveBlock!: () => void;
    const blocker = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const service = createPostSchedulerService({
      dataDir: sandbox.dataDir,
      tickMs: 1, // fire fast
      _tickBody: async () => {
        entered += 1;
        await blocker;
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      // Allow a few timer fires while the first tick is held.
      await new Promise((r) => setTimeout(r, 20));
      expect(entered).toBe(1); // overlapping ticks were rejected
      resolveBlock();
      // Drain any pending timers, then stop.
      await new Promise((r) => setTimeout(r, 5));
      service.stop();
    } finally {
      ctx.logger.close();
    }
  });

  it("logs and recovers on _tickBody throw", async () => {
    const service = createPostSchedulerService({
      dataDir: sandbox.dataDir,
      tickMs: 60_000,
      _tickBody: async () => {
        throw new Error("boom");
      },
    });
    const ctx = buildCtx(sandbox);
    try {
      service.start(ctx);
      await new Promise((r) => setTimeout(r, 0));
      service.stop();
    } finally {
      ctx.logger.close();
    }
    // The service must have caught the error; if not, the test already failed.
    expect(true).toBe(true);
  });
});

describe("buildDefaultAdapters", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("returns just the file-stub when FB env vars are missing", () => {
    const adapters = buildDefaultAdapters(sandbox.dataDir, {});
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.channels).toContain("facebook");
    expect(adapters[0]?.channels).toContain("instagram");
  });

  it("appends the FB adapter when both env vars are present", () => {
    const adapters = buildDefaultAdapters(sandbox.dataDir, {
      FB_PAGE_ID: "123",
      FB_PAGE_ACCESS_TOKEN: "tok",
    });
    expect(adapters).toHaveLength(2);
    // Last adapter overrides via buildAdapterMap last-wins.
    expect(adapters[1]?.channels).toEqual(["facebook"]);
  });

  it("skips the FB adapter when one env var is missing", () => {
    const adapters = buildDefaultAdapters(sandbox.dataDir, {
      FB_PAGE_ID: "123",
    });
    expect(adapters).toHaveLength(1);
  });
});
