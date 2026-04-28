import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFile } from "../../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import {
  findSurfaceRecord,
  runSurfaceTick,
  surfacePlan,
  updateSurfacedPlan,
  type SurfaceContext,
} from "./surface.ts";

interface PostMessageCall {
  channel: string;
  blocks: unknown[];
  text?: string;
}

interface UpdateCall {
  channel: string;
  ts: string;
  blocks: unknown[];
  text?: string;
}

function fakeWebClient(): {
  client: SurfaceContext["client"];
  posts: PostMessageCall[];
  updates: UpdateCall[];
} {
  const posts: PostMessageCall[] = [];
  const updates: UpdateCall[] = [];
  let counter = 1;
  const client = {
    chat: {
      async postMessage(opts: {
        channel: string;
        blocks: unknown[];
        text?: string;
      }) {
        posts.push({ ...opts });
        return { ok: true, ts: `1700000000.00${counter++}` };
      },
      async update(opts: {
        channel: string;
        ts: string;
        blocks: unknown[];
        text?: string;
      }) {
        updates.push({ ...opts });
        return { ok: true };
      },
    },
  };
  return { client: client as never, posts, updates };
}

describe("surfacePlan", () => {
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

  it("posts a message and records a slack-surfaced event", async () => {
    dropPlan(sandbox, "2026-04-28-test", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-test")!;
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const result = await surfacePlan(ctx, record);
    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C-INBOX");

    const stored = findSurfaceRecord(dbFile(sandbox.dataDir), "2026-04-28-test");
    expect(stored?.channel).toBe("C-INBOX");
  });

  it("is idempotent — second call reuses the existing surface record without re-posting", async () => {
    dropPlan(sandbox, "2026-04-28-idem", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-idem")!;
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const first = await surfacePlan(ctx, record);
    const second = await surfacePlan(ctx, record);
    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect(posts).toHaveLength(1);
  });
});

describe("runSurfaceTick", () => {
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

  it("surfaces all awaiting-review plans, skipping previously-surfaced", async () => {
    dropPlan(sandbox, "2026-04-28-a", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-28-b", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-28-c", { status: "draft" });
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const first = await runSurfaceTick(ctx);
    expect(first.surfaced).toEqual(
      expect.arrayContaining(["2026-04-28-a", "2026-04-28-b"]),
    );
    expect(posts).toHaveLength(2);
    expect(posts.some((p) => (p as PostMessageCall).text?.includes("c"))).toBe(
      false,
    );

    const second = await runSurfaceTick(ctx);
    expect(second.surfaced).toEqual([]);
    expect(posts).toHaveLength(2); // no new posts
  });
});

describe("updateSurfacedPlan", () => {
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

  it("updates the previously-surfaced message in place and strips the actions block", async () => {
    dropPlan(sandbox, "2026-04-28-u", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-u")!;
    const { client, updates } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    await surfacePlan(ctx, record);
    await updateSurfacedPlan(ctx, record, "✓ Approved by <@U1>");
    expect(updates).toHaveLength(1);
    const blocks = updates[0]!.blocks as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
  });

  it("does nothing when the plan was never surfaced", async () => {
    dropPlan(sandbox, "2026-04-28-no", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-no")!;
    const { client, updates } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    await updateSurfacedPlan(ctx, record, "noop");
    expect(updates).toHaveLength(0);
  });
});
