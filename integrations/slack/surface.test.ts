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
import { appendEvent } from "../../orchestrator/event-log.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import fs from "node:fs";
import path from "node:path";
import { triageDir } from "../../cli/paths.ts";
import { suppress } from "../../orchestrator/suppressions.ts";
import {
  findAmendmentSurfaceRecord,
  findPendingAmendment,
  findSurfaceRecord,
  findUnpostedAlertableSignals,
  findUnpostedTriageReports,
  runAlertTick,
  runSurfaceTick,
  runTriageDeliveryTick,
  surfaceAmendmentReview,
  surfacePlan,
  surfaceSignalAlert,
  surfaceTriageReport,
  updateSurfacedPlan,
  type AlertContext,
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

// ---------------------------------------------------------------------------
// Slice 1: amendment surface
// ---------------------------------------------------------------------------

describe("findPendingAmendment", () => {
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

  function recordAmendment(
    planId: string,
    payload: Record<string, unknown>,
    kind = "amendment-proposed",
  ): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind,
        payload: { planId, ...payload },
      });
    } finally {
      conn.close();
    }
  }

  it("returns null when no amendment-proposed event exists", () => {
    expect(findPendingAmendment(dbFile(sandbox.dataDir), "no-such")).toBeNull();
  });

  it("returns the latest amendment-proposed payload, with eventId", () => {
    recordAmendment("plan-x", {
      reason: "first",
      proposal: "first proposal",
      branch: "feat/old",
      sha: "abc",
      modifiedFileCount: 1,
    });
    recordAmendment("plan-x", {
      reason: "second",
      proposal: "second proposal",
      branch: "feat/new",
      sha: "def",
      modifiedFileCount: 4,
    });
    const result = findPendingAmendment(dbFile(sandbox.dataDir), "plan-x");
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("second");
    expect(result?.branch).toBe("feat/new");
    expect(result?.modifiedFileCount).toBe(4);
    expect(typeof result?.eventId).toBe("number");
  });

  it("returns null when proposed count <= applied count (loop closed)", () => {
    recordAmendment("plan-y", { reason: "r", proposal: "p" });
    recordAmendment("plan-y", { reason: "r2", proposal: "p2" });
    recordAmendment("plan-y", {}, "amendment-applied");
    recordAmendment("plan-y", {}, "amendment-applied");
    expect(findPendingAmendment(dbFile(sandbox.dataDir), "plan-y")).toBeNull();
  });

  it("returns the pending amendment when proposed > applied (re-amend mid-loop)", () => {
    recordAmendment("plan-z", { reason: "r1", proposal: "p1" });
    recordAmendment("plan-z", {}, "amendment-applied");
    recordAmendment("plan-z", { reason: "r2", proposal: "p2" });
    const result = findPendingAmendment(dbFile(sandbox.dataDir), "plan-z");
    expect(result?.reason).toBe("r2");
  });

  it("skips events with malformed payload (missing reason / proposal)", () => {
    recordAmendment("plan-q", { reason: "ok" }); // no proposal
    expect(findPendingAmendment(dbFile(sandbox.dataDir), "plan-q")).toBeNull();
  });
});

describe("surfaceAmendmentReview", () => {
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

  it("posts an amendment-review message and records a slack-amendment-surfaced event", async () => {
    dropPlan(sandbox, "2026-04-28-amend", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-amend")!;
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };

    const result = await surfaceAmendmentReview(ctx, record, {
      eventId: 99,
      reason: "scope expanded",
      proposal: "do X instead of Y",
      branch: "feat/x",
      sha: "abcdef12",
      modifiedFileCount: 3,
    });

    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1);
    const summary = (posts[0]!.blocks as Array<{ type: string }>).find(
      (b) => b.type === "section",
    );
    expect(summary).toBeDefined();
    expect(posts[0]!.text).toContain("Amendment to review");

    const stored = findAmendmentSurfaceRecord(dbFile(sandbox.dataDir), 99);
    expect(stored?.channel).toBe("C-INBOX");
  });

  it("is idempotent on amendment eventId — second call reuses the record", async () => {
    dropPlan(sandbox, "2026-04-28-idem-a", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-idem-a")!;
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const amendment = {
      eventId: 1,
      reason: "r",
      proposal: "p",
    };
    const first = await surfaceAmendmentReview(ctx, record, amendment);
    const second = await surfaceAmendmentReview(ctx, record, amendment);
    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it("does post a fresh message for a NEW amendment eventId (re-amend)", async () => {
    dropPlan(sandbox, "2026-04-28-reamend", { status: "awaiting-review" });
    const record = findPlan(sandbox.dataDir, "2026-04-28-reamend")!;
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    await surfaceAmendmentReview(ctx, record, {
      eventId: 1,
      reason: "first",
      proposal: "p1",
    });
    await surfaceAmendmentReview(ctx, record, {
      eventId: 2,
      reason: "second",
      proposal: "p2",
    });
    expect(posts).toHaveLength(2);
  });
});

describe("runSurfaceTick — amendment routing", () => {
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

  function recordAmendmentProposed(
    planId: string,
    reason = "r",
    proposal = "p",
  ): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "amendment-proposed",
        payload: { planId, reason, proposal },
      });
    } finally {
      conn.close();
    }
  }

  it("routes a plan with a pending amendment to the amendment surface, not plan-review", async () => {
    dropPlan(sandbox, "p-amend", {
      status: "awaiting-review",
      title: "AMENDED PLAN",
    });
    dropPlan(sandbox, "p-fresh", {
      status: "awaiting-review",
      title: "FRESH PLAN",
    });
    recordAmendmentProposed("p-amend", "scope expanded", "do X instead");

    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const result = await runSurfaceTick(ctx);
    expect(result.surfaced.sort()).toEqual(["p-amend@amendment", "p-fresh"]);

    // Amendment post has the "Amendment to review" fallback text;
    // plan-review post has "Plan to review".
    const amendmentPost = posts.find((p) =>
      p.text?.startsWith("Amendment to review"),
    );
    const planPost = posts.find((p) =>
      p.text?.startsWith("Plan to review"),
    );
    expect(amendmentPost).toBeDefined();
    expect(planPost).toBeDefined();
    expect(amendmentPost?.text).toContain("AMENDED PLAN");
    expect(planPost?.text).toContain("FRESH PLAN");
  });

  it("does not double-post the amendment on a second tick (idempotent on amendment eventId)", async () => {
    dropPlan(sandbox, "p-once", { status: "awaiting-review" });
    recordAmendmentProposed("p-once");

    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    await runSurfaceTick(ctx);
    await runSurfaceTick(ctx);
    expect(posts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: signal alerts to #jarvis-alerts
// ---------------------------------------------------------------------------

describe("findUnpostedAlertableSignals", () => {
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

  function recordSignal(opts: {
    severity: "low" | "medium" | "high" | "critical";
    summary?: string;
    kind?: string;
    dedupKey?: string;
    app?: string;
  }): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: opts.app ?? "demo",
        vaultId: "personal",
        kind: "signal",
        payload: {
          kind: opts.kind ?? "yarn-audit",
          severity: opts.severity,
          summary: opts.summary ?? "test signal",
          ...(opts.dedupKey !== undefined && { dedupKey: opts.dedupKey }),
        },
      });
    } finally {
      conn.close();
    }
  }

  function recordSurfaced(signalEventId: number): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "demo",
        vaultId: "personal",
        kind: "slack-signal-surfaced",
        payload: { signalEventId },
      });
    } finally {
      conn.close();
    }
  }

  it("returns nothing when no signals exist", () => {
    expect(
      findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
        threshold: "high",
      }),
    ).toEqual([]);
  });

  it("filters out signals below the threshold", () => {
    recordSignal({ severity: "low", summary: "shh" });
    recordSignal({ severity: "medium", summary: "shh" });
    recordSignal({ severity: "high", summary: "alert me" });
    recordSignal({ severity: "critical", summary: "alert me too" });
    const found = findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
      threshold: "high",
    });
    expect(found.map((s) => s.severity).sort()).toEqual(["critical", "high"]);
  });

  it("filters out signals already surfaced (slack-signal-surfaced event)", () => {
    recordSignal({ severity: "high", summary: "first" });
    recordSignal({ severity: "high", summary: "second" });
    // Look up the first signal's auto-increment id so we don't depend
    // on whether the install sandbox seeded any events ahead of it.
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    let firstId: number;
    try {
      const row = conn
        .prepare(
          "SELECT id FROM events WHERE kind = 'signal' ORDER BY id ASC LIMIT 1",
        )
        .get() as { id: number };
      firstId = row.id;
    } finally {
      conn.close();
    }
    recordSurfaced(firstId);
    const found = findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
      threshold: "high",
    });
    expect(found.map((s) => s.summary)).toEqual(["second"]);
  });

  it("returns most-recent-first up to limit", () => {
    for (let i = 0; i < 6; i += 1) {
      recordSignal({ severity: "high", summary: `s${i}` });
    }
    const found = findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
      threshold: "high",
      limit: 3,
    });
    expect(found).toHaveLength(3);
    expect(found.map((s) => s.summary)).toEqual(["s5", "s4", "s3"]);
  });

  it("threshold=critical only returns critical signals", () => {
    recordSignal({ severity: "high", summary: "high one" });
    recordSignal({ severity: "critical", summary: "critical one" });
    const found = findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
      threshold: "critical",
    });
    expect(found.map((s) => s.summary)).toEqual(["critical one"]);
  });

  it("includes app, vault, kind, dedupKey, signalEventId, createdAt", () => {
    recordSignal({
      severity: "critical",
      summary: "x",
      kind: "broken-links",
      dedupKey: "broken-links:https://x.example",
      app: "alpha",
    });
    const [s] = findUnpostedAlertableSignals(dbFile(sandbox.dataDir), {
      threshold: "high",
    });
    expect(s).toMatchObject({
      app: "alpha",
      vault: "personal",
      kind: "broken-links",
      severity: "critical",
      dedupKey: "broken-links:https://x.example",
    });
    expect(typeof s?.signalEventId).toBe("number");
    expect(typeof s?.createdAt).toBe("string");
  });
});

describe("surfaceSignalAlert", () => {
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

  it("posts to the alerts channel and records a slack-signal-surfaced event", async () => {
    const { client, posts } = fakeWebClient();
    const ctx: AlertContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
      alertsChannelId: "C-ALERTS",
    };
    const result = await surfaceSignalAlert(ctx, {
      signalEventId: 7,
      app: "demo",
      vault: "personal",
      kind: "yarn-audit",
      severity: "critical",
      summary: "RCE",
      dedupKey: "yarn-audit:CVE-X",
      createdAt: "2026-05-05T11:00:00Z",
    });
    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C-ALERTS");
    expect(posts[0]?.text).toContain("CRITICAL signal");

    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'slack-signal-surfaced'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        signalEventId: 7,
        channel: "C-ALERTS",
        severity: "critical",
        dedupKey: "yarn-audit:CVE-X",
      });
    } finally {
      conn.close();
    }
  });
});

describe("runAlertTick", () => {
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

  function recordSignal(opts: {
    severity: "low" | "medium" | "high" | "critical";
    dedupKey?: string;
    summary?: string;
  }): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "demo",
        vaultId: "personal",
        kind: "signal",
        payload: {
          kind: "yarn-audit",
          severity: opts.severity,
          summary: opts.summary ?? "x",
          ...(opts.dedupKey !== undefined && { dedupKey: opts.dedupKey }),
        },
      });
    } finally {
      conn.close();
    }
  }

  it("posts each unposted high/critical signal exactly once across two ticks", async () => {
    recordSignal({ severity: "critical", summary: "first" });
    recordSignal({ severity: "high", summary: "second" });
    recordSignal({ severity: "low", summary: "should be skipped" });

    const { client, posts } = fakeWebClient();
    const ctx: AlertContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
      alertsChannelId: "C-ALERTS",
    };
    const t1 = await runAlertTick(ctx, { threshold: "high" });
    expect(t1.alerted).toHaveLength(2);
    expect(t1.errors).toEqual([]);
    expect(posts).toHaveLength(2);

    const t2 = await runAlertTick(ctx, { threshold: "high" });
    expect(t2.alerted).toEqual([]);
    expect(posts).toHaveLength(2); // no new posts
  });

  it("skips signals whose dedupKey is suppressed and records a suppressed-surfaced event", async () => {
    recordSignal({
      severity: "critical",
      dedupKey: "yarn-audit:CVE-MUTED",
      summary: "muted",
    });
    suppress(dbFile(sandbox.dataDir), {
      patternId: "yarn-audit:CVE-MUTED",
      pattern: "muted under review",
    });

    const { client, posts } = fakeWebClient();
    const ctx: AlertContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
      alertsChannelId: "C-ALERTS",
    };
    const result = await runAlertTick(ctx, { threshold: "high" });
    expect(result.alerted).toEqual([]);
    expect(result.suppressedSkipped).toHaveLength(1);
    expect(posts).toHaveLength(0);

    // Subsequent tick should not re-evaluate — the suppressed signal
    // got a synthetic surfaced event so it's filtered out next time.
    const t2 = await runAlertTick(ctx, { threshold: "high" });
    expect(t2.suppressedSkipped).toEqual([]);
    expect(t2.alerted).toEqual([]);
  });

  it("isolates per-signal errors and continues with the rest", async () => {
    recordSignal({ severity: "critical", summary: "ok" });
    recordSignal({ severity: "critical", summary: "boom" });

    const calls: Array<{ text?: string }> = [];
    let i = 0;
    const client = {
      chat: {
        async postMessage(p: { text?: string; blocks: unknown[] }) {
          calls.push(p);
          i += 1;
          if (p.text?.includes("boom")) {
            return { ok: false, error: "channel_not_found" };
          }
          return { ok: true, ts: `1.${i}` };
        },
      },
    } as never;
    const ctx: AlertContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
      alertsChannelId: "C-ALERTS",
    };
    const result = await runAlertTick(ctx, { threshold: "high" });
    expect(result.alerted).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it("threshold=critical drops high-severity signals", async () => {
    recordSignal({ severity: "high", summary: "high one" });
    recordSignal({ severity: "critical", summary: "crit one" });

    const { client, posts } = fakeWebClient();
    const ctx: AlertContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
      alertsChannelId: "C-ALERTS",
    };
    const result = await runAlertTick(ctx, { threshold: "critical" });
    expect(result.alerted).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("crit one");
  });
});

// ---------------------------------------------------------------------------
// Slice 3: triage delivery to #jarvis-inbox
// ---------------------------------------------------------------------------

describe("findUnpostedTriageReports", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  // Pinned to UTC midnight so the 7-day window math is integer days.
  const FIXED_NOW = new Date("2026-05-04T00:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function writeTriageFile(date: string, body = "# Triage\nbody"): string {
    const dir = triageDir(sandbox.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${date}.md`);
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  function recordSurfaced(date: string): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "slack-triage-surfaced",
        payload: { date },
      });
    } finally {
      conn.close();
    }
  }

  it("returns empty when the triage dir doesn't exist", () => {
    expect(
      findUnpostedTriageReports(sandbox.dataDir, dbFile(sandbox.dataDir), {
        now: FIXED_NOW,
      }),
    ).toEqual([]);
  });

  it("returns triage files within the age window, most-recent-first", () => {
    writeTriageFile("2026-05-04");
    writeTriageFile("2026-04-27"); // 7 days old — exactly at boundary
    writeTriageFile("2026-04-20"); // 14 days old — outside default 7-day window
    const found = findUnpostedTriageReports(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      { now: FIXED_NOW },
    );
    expect(found.map((f) => f.date)).toEqual(["2026-05-04", "2026-04-27"]);
  });

  it("filters out posted dates via slack-triage-surfaced events", () => {
    writeTriageFile("2026-05-04");
    writeTriageFile("2026-05-03");
    recordSurfaced("2026-05-03");
    const found = findUnpostedTriageReports(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      { now: FIXED_NOW },
    );
    expect(found.map((f) => f.date)).toEqual(["2026-05-04"]);
  });

  it("ignores files that don't match the YYYY-MM-DD.md pattern", () => {
    writeTriageFile("2026-05-04");
    fs.writeFileSync(
      path.join(triageDir(sandbox.dataDir), "scratch.md"),
      "x",
    );
    fs.writeFileSync(
      path.join(triageDir(sandbox.dataDir), "draft.txt"),
      "x",
    );
    const found = findUnpostedTriageReports(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      { now: FIXED_NOW },
    );
    expect(found.map((f) => f.date)).toEqual(["2026-05-04"]);
  });

  it("respects a custom maxAgeDays", () => {
    writeTriageFile("2026-04-20"); // 14 days old
    const found = findUnpostedTriageReports(
      sandbox.dataDir,
      dbFile(sandbox.dataDir),
      { now: FIXED_NOW, maxAgeDays: 30 },
    );
    expect(found.map((f) => f.date)).toEqual(["2026-04-20"]);
  });
});

describe("surfaceTriageReport", () => {
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

  it("posts the triage to the inbox channel and records a slack-triage-surfaced event", async () => {
    const dir = triageDir(sandbox.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "2026-05-04.md");
    fs.writeFileSync(
      filePath,
      "# Triage — 2026-05-04\n\n## Critical\n- **[HIGH]** test signal",
    );

    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const result = await surfaceTriageReport(ctx, {
      filePath,
      date: "2026-05-04",
    });
    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C-INBOX");
    expect(posts[0]?.text).toContain("2026-05-04");

    // Bold conversion happened (`**[HIGH]**` → `*[HIGH]*`)
    const section = (posts[0]?.blocks as Array<{ type: string }>).find(
      (b) => b.type === "section",
    );
    expect(section).toBeDefined();

    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'slack-triage-surfaced'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload);
      expect(payload.date).toBe("2026-05-04");
      expect(payload.channel).toBe("C-INBOX");
      expect(payload.filePath).toBe(filePath);
    } finally {
      conn.close();
    }
  });

  it("throws a clear error when the triage file is missing", async () => {
    const { client } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    await expect(
      surfaceTriageReport(ctx, {
        filePath: "/no/such/file.md",
        date: "2026-05-04",
      }),
    ).rejects.toThrow(/triage file unreadable/);
  });
});

describe("runTriageDeliveryTick", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  const FIXED_NOW = new Date("2026-05-04T00:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function writeTriageFile(date: string, body = "# Triage\nbody"): void {
    const dir = triageDir(sandbox.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.md`), body);
  }

  it("posts each unposted triage exactly once across two ticks", async () => {
    writeTriageFile("2026-05-04");
    writeTriageFile("2026-04-30");
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const t1 = await runTriageDeliveryTick(ctx, { now: FIXED_NOW });
    expect(t1.posted.sort()).toEqual(["2026-04-30", "2026-05-04"]);
    expect(posts).toHaveLength(2);

    const t2 = await runTriageDeliveryTick(ctx, { now: FIXED_NOW });
    expect(t2.posted).toEqual([]);
    expect(posts).toHaveLength(2);
  });

  it("doesn't replay reports older than maxAgeDays", async () => {
    writeTriageFile("2026-04-20"); // 14 days old → outside default 7d
    writeTriageFile("2026-05-04");
    const { client, posts } = fakeWebClient();
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const result = await runTriageDeliveryTick(ctx, { now: FIXED_NOW });
    expect(result.posted).toEqual(["2026-05-04"]);
    expect(posts).toHaveLength(1);
  });

  it("isolates per-file errors and continues with the rest", async () => {
    writeTriageFile("2026-05-04");
    writeTriageFile("2026-04-30");

    let i = 0;
    const client = {
      chat: {
        async postMessage(p: { text?: string; blocks: unknown[] }) {
          i += 1;
          if (p.text?.includes("2026-05-04")) {
            return { ok: false, error: "channel_not_found" };
          }
          return { ok: true, ts: `1.${i}` };
        },
      },
    } as never;
    const ctx: SurfaceContext = {
      dataDir: sandbox.dataDir,
      client,
      inboxChannelId: "C-INBOX",
    };
    const result = await runTriageDeliveryTick(ctx, { now: FIXED_NOW });
    expect(result.posted).toEqual(["2026-04-30"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.date).toBe("2026-05-04");
  });
});
