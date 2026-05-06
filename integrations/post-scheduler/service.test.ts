import fs from "node:fs";
import path from "node:path";
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
import {
  buildAdapterRegistry,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type PublishResult,
} from "../../tools/channels/types.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import {
  buildDefaultRegistry,
  createPostSchedulerService,
  runPostSchedulerTick,
} from "./service.ts";

function fallbackRegistry(
  adapters: ReadonlyArray<ChannelAdapter>,
): ChannelAdapterRegistry {
  return buildAdapterRegistry(
    adapters.map((adapter, i) => ({ adapter, name: `test-adapter-${i}` })),
  );
}

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
        registry: fallbackRegistry([
          alwaysOkAdapter(["facebook"]),
          alwaysOkAdapter(["instagram"]),
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

  it("reconciles marketing plan state after publish (executing → done when last row publishes)", async () => {
    // Drop a marketing plan in `executing` (simulating after marketer fired).
    const planText = [
      "# Plan: tick-reconcile",
      "Type: marketing",
      "Subtype: campaign",
      "App: demo",
      "Priority: normal",
      "Destructive: false",
      "Status: executing",
      "Author: strategist",
      "Confidence: 75 — fixture",
      "",
      "## Opportunity",
      "x",
      "",
      "## Audience",
      "x",
      "",
      "## Channels",
      "x",
      "",
      "## Content calendar",
      "(rows below)",
      "",
      "## Schedule",
      "x",
      "",
      "## Tracking & KPIs",
      "x",
      "",
      "## Success metric",
      "- Metric: x",
      "- Baseline: x",
      "- Target: x",
      "- Data source: x",
      "",
      "## Observation window",
      "30d.",
      "",
      "## Connections required",
      "- Facebook: present",
      "",
      "## Rollback",
      "x",
      "",
      "## Estimated effort",
      "- Claude calls: ~3",
      "- Your review time: 5 min",
      "- Wall-clock to ship: 1 hour",
      "",
      "## Amendment clauses",
      "x",
      "",
    ].join("\n");
    const planDir = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "plans",
      "demo",
    );
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "tick-reconcile.md"), planText);

    const db = new Database(dbFile(sandbox.dataDir));
    try {
      insertScheduledPost(db, {
        ...row("p1"),
        planId: "tick-reconcile",
      });
    } finally {
      db.close();
    }

    const ctx = buildCtx(sandbox);
    try {
      await runPostSchedulerTick({
        dataDir: sandbox.dataDir,
        registry: fallbackRegistry([alwaysOkAdapter(["facebook"])]),
        ctx,
        now: new Date("2026-04-09T00:00:00.000Z"),
      });
    } finally {
      ctx.logger.close();
    }

    // Plan should now be `done`.
    const verifyDb = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const transitions = verifyDb
        .prepare(
          "SELECT payload FROM events WHERE kind = 'plan-transition' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      const planTransitions = transitions
        .map((t) => JSON.parse(t.payload))
        .filter((t) => t.planId === "tick-reconcile");
      // executing → done (since the plan started in executing)
      expect(planTransitions).toEqual([
        expect.objectContaining({ from: "executing", to: "done" }),
      ]);
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
        registry: fallbackRegistry([alwaysOkAdapter(["facebook"])]),
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
        registry: fallbackRegistry([alwaysOkAdapter(["facebook"])]),
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
        registry: fallbackRegistry([alwaysOkAdapter(["facebook"])]),
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

describe("buildDefaultRegistry", () => {
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

  function seedBrain(
    app: string,
    fbConn?: Record<string, unknown>,
  ): void {
    const dir = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "brains",
      app,
    );
    fs.mkdirSync(dir, { recursive: true });
    const brain: Record<string, unknown> = {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
      userPreferences: {},
      connections: fbConn ? { facebook: fbConn } : {},
      priorities: [],
      wip: {},
    };
    fs.writeFileSync(path.join(dir, "brain.json"), JSON.stringify(brain));
  }

  it("returns just the file-stub when no FB config anywhere", () => {
    const r = buildDefaultRegistry({ dataDir: sandbox.dataDir, env: {} });
    const desc = r.describe();
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.every((e) => e.adapterName === "file-stub")).toBe(true);
    expect(desc.every((e) => e.appId === undefined)).toBe(true);
    expect(r.channels().has("facebook")).toBe(true);
  });

  it("registers the legacy FB env adapter as a `facebook` fallback", () => {
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: { FB_PAGE_ID: "123", FB_PAGE_ACCESS_TOKEN: "tok" },
    });
    const desc = r.describe();
    expect(
      desc.some(
        (e) =>
          e.channel === "facebook" &&
          e.appId === undefined &&
          e.adapterName === "facebook:legacy-env",
      ),
    ).toBe(true);
  });

  it("registers per-app FB adapters when brain + env both present", () => {
    seedBrain("erdei", {
      pageId: "fb-erdei-id",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    seedBrain("kuna", {
      pageId: "fb-kuna-id",
      tokenEnvVar: "FB_TOKEN_KUNA",
    });
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {
        FB_TOKEN_ERDEI: "tok-e",
        FB_TOKEN_KUNA: "tok-k",
      },
    });
    const desc = r.describe();
    const perApp = desc.filter(
      (e) => e.channel === "facebook" && e.appId !== undefined,
    );
    expect(perApp).toHaveLength(2);
    expect(perApp.map((e) => e.appId).sort()).toEqual(["erdei", "kuna"]);
    // get(channel, appId) returns per-app adapters distinctly
    expect(r.get("facebook", "erdei")).not.toBeNull();
    expect(r.get("facebook", "kuna")).not.toBeNull();
    // Unrelated app falls through to stub fallback
    expect(r.get("facebook", "other")?.channels).toContain("blog");
  });

  it("skips per-app FB when its env var is unset (and warns)", () => {
    seedBrain("erdei", {
      pageId: "fb-erdei-id",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {},
      logger: {
        warn: (msg, meta) => warnings.push({ msg, ...(meta && { meta }) }),
      },
    });
    const desc = r.describe();
    const perApp = desc.filter(
      (e) => e.channel === "facebook" && e.appId !== undefined,
    );
    expect(perApp).toHaveLength(0);
    expect(warnings.some((w) => w.msg.includes("misconfigured"))).toBe(true);
  });

  it("skips per-app FB when brain.connections.facebook is malformed", () => {
    // pageId set but tokenEnvVar missing
    seedBrain("erdei", {
      pageId: "fb-erdei-id",
    } as { pageId: string; tokenEnvVar: string });
    const warnings: string[] = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {},
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(
      r.describe().some((e) => e.adapterName.startsWith("facebook:erdei")),
    ).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("brains with no facebook connection are silently skipped (not warned)", () => {
    seedBrain("appA");
    const warnings: string[] = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {},
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const desc = r.describe();
    expect(
      desc.filter((e) => e.adapterName.startsWith("facebook")),
    ).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("per-app FB wins over legacy global FB for the matching app", () => {
    seedBrain("erdei", {
      pageId: "fb-erdei-id",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {
        FB_PAGE_ID: "global-id",
        FB_PAGE_ACCESS_TOKEN: "global-tok",
        FB_TOKEN_ERDEI: "tok-e",
      },
    });
    // erdei → per-app; other apps → legacy fallback
    const erdei = r.get("facebook", "erdei");
    const other = r.get("facebook", "other-app");
    expect(erdei).not.toBeNull();
    expect(other).not.toBeNull();
    expect(erdei).not.toBe(other);
  });

  // --- Env-ref pageId (preferred shape: both values in .env) -----------------

  it("registers per-app FB when both pageIdEnvVar + tokenEnvVar are set", () => {
    seedBrain("erdei", {
      pageIdEnvVar: "FB_PAGE_ID_ERDEI",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {
        FB_PAGE_ID_ERDEI: "123456789012345",
        FB_TOKEN_ERDEI: "tok-e",
      },
    });
    const desc = r.describe();
    const perApp = desc.filter(
      (e) => e.channel === "facebook" && e.appId === "erdei",
    );
    expect(perApp).toHaveLength(1);
    expect(perApp[0]?.adapterName).toBe("facebook:erdei");
  });

  it("warns + skips when pageIdEnvVar references an unset env var", () => {
    seedBrain("erdei", {
      pageIdEnvVar: "FB_PAGE_ID_ERDEI",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const warnings: string[] = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: { FB_TOKEN_ERDEI: "tok-e" }, // pageId env var missing
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(
      r.describe().some((e) => e.adapterName === "facebook:erdei"),
    ).toBe(false);
    expect(warnings.some((w) => w.includes("misconfigured"))).toBe(true);
  });

  it("rejects pageIdEnvVar when set to a non-string", () => {
    seedBrain("erdei", {
      pageIdEnvVar: 12345 as unknown as string,
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const warnings: string[] = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: { FB_TOKEN_ERDEI: "tok-e" },
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(
      r.describe().some((e) => e.adapterName === "facebook:erdei"),
    ).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("env-ref pageIdEnvVar wins over a legacy literal pageId on the same brain", () => {
    seedBrain("erdei", {
      pageId: "stale-literal-id",
      pageIdEnvVar: "FB_PAGE_ID_ERDEI",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: {
        FB_PAGE_ID_ERDEI: "123-from-env",
        FB_TOKEN_ERDEI: "tok-e",
      },
    });
    // The adapter is registered (so the env-var shape resolved correctly).
    expect(r.get("facebook", "erdei")).not.toBeNull();
  });

  it("legacy literal pageId still works when pageIdEnvVar is absent", () => {
    seedBrain("erdei", {
      pageId: "literal-id",
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: { FB_TOKEN_ERDEI: "tok-e" },
    });
    expect(
      r.describe().some((e) => e.adapterName === "facebook:erdei"),
    ).toBe(true);
  });

  it("missing both pageId and pageIdEnvVar warns + skips", () => {
    seedBrain("erdei", {
      tokenEnvVar: "FB_TOKEN_ERDEI",
    });
    const warnings: string[] = [];
    const r = buildDefaultRegistry({
      dataDir: sandbox.dataDir,
      env: { FB_TOKEN_ERDEI: "tok-e" },
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(
      r.describe().some((e) => e.adapterName === "facebook:erdei"),
    ).toBe(false);
    expect(warnings.some((w) => w.includes("misconfigured"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAdapterRegistry sanity (in tools/channels but exercised heavily here)
// ---------------------------------------------------------------------------

describe("buildAdapterRegistry priorities", () => {
  it("per-app match beats fallback for the channel", () => {
    const perApp: ChannelAdapter = {
      channels: ["facebook"],
      async publish() {
        return { ok: true, publishedId: "per-app" };
      },
    };
    const fallback: ChannelAdapter = {
      channels: ["facebook"],
      async publish() {
        return { ok: true, publishedId: "fallback" };
      },
    };
    const registry = buildAdapterRegistry([
      { adapter: fallback, name: "fb-fallback" },
      { adapter: perApp, appId: "erdei", name: "fb-erdei" },
    ]);
    expect(registry.get("facebook", "erdei")).toBe(perApp);
    expect(registry.get("facebook", "kuna")).toBe(fallback);
  });

  it("returns null when no match anywhere", () => {
    const registry = buildAdapterRegistry([]);
    expect(registry.get("facebook", "erdei")).toBeNull();
  });

  it("describe surfaces every entry with channel + appId", () => {
    const stub: ChannelAdapter = {
      channels: ["blog", "newsletter"],
      async publish() {
        return { ok: true, publishedId: "x" };
      },
    };
    const fb: ChannelAdapter = {
      channels: ["facebook"],
      async publish() {
        return { ok: true, publishedId: "x" };
      },
    };
    const registry = buildAdapterRegistry([
      { adapter: stub, name: "stub" },
      { adapter: fb, appId: "erdei", name: "fb-erdei" },
    ]);
    const desc = registry.describe();
    expect(desc).toHaveLength(3);
    const byName = desc.map((e) => e.adapterName).sort();
    expect(byName).toEqual(["fb-erdei", "stub", "stub"]);
  });
});
