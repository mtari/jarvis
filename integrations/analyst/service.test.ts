import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import {
  dropPlan,
} from "../../cli/commands/_test-helpers.ts";
import { brainDir, brainFile, dbFile } from "../../cli/paths.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
} from "../../tools/scanners/types.ts";
import {
  createAnalystService,
  runAnalystTick,
} from "./service.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";

function fakeDaemonCtx(): DaemonContext {
  return {
    dataDir: "/tmp",
    pidFile: { pid: 1, startedAt: "" },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      flush: () => {},
      close: () => {},
    },
  };
}

function fakeCollector(
  kind: string,
  signals: Signal[] = [],
): SignalCollector & { calls: CollectorContext[] } {
  const calls: CollectorContext[] = [];
  return {
    kind,
    description: `fake ${kind}`,
    calls,
    async collect(ctx) {
      calls.push(ctx);
      return signals;
    },
  };
}

function seedBrainWithRepo(
  sandbox: InstallSandbox,
  vault: string,
  app: string,
  rootPath?: string,
  monorepoPath?: string,
): void {
  fs.mkdirSync(brainDir(sandbox.dataDir, vault, app), { recursive: true });
  saveBrain(brainFile(sandbox.dataDir, vault, app), {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    ...(rootPath !== undefined && {
      repo: {
        rootPath,
        ...(monorepoPath !== undefined && { monorepoPath }),
      },
    }),
  });
}

describe("runAnalystTick", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    // makeInstallSandbox seeds a `jarvis` brain. Wipe it so each test
    // controls exactly which apps the sweep finds.
    fs.rmSync(brainDir(sandbox.dataDir, "personal", "jarvis"), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("scans every onboarded app with brain.repo configured", async () => {
    seedBrainWithRepo(sandbox, "personal", "alpha", "/repo/alpha");
    seedBrainWithRepo(sandbox, "personal", "beta", "/repo/beta");
    const c = fakeCollector("noop");
    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [c],
      ctx: fakeDaemonCtx(),
    });
    expect(result.scannedApps).toBe(2);
    expect(c.calls).toHaveLength(2);
    expect(c.calls.map((c) => c.cwd).sort()).toEqual(
      ["/repo/alpha", "/repo/beta"].sort(),
    );
  });

  it("joins monorepoPath into the cwd when set", async () => {
    seedBrainWithRepo(
      sandbox,
      "personal",
      "monorepo-app",
      "/Users/me/projects/applications",
      "apps/web",
    );
    const c = fakeCollector("noop");
    await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [c],
      ctx: fakeDaemonCtx(),
    });
    expect(c.calls[0]?.cwd).toBe(
      "/Users/me/projects/applications/apps/web",
    );
  });

  it("skips apps without brain.repo and records them in perApp", async () => {
    seedBrainWithRepo(sandbox, "personal", "with-repo", "/repo/x");
    seedBrainWithRepo(sandbox, "personal", "no-repo");
    const c = fakeCollector("noop");
    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [c],
      ctx: fakeDaemonCtx(),
    });
    expect(result.scannedApps).toBe(1);
    expect(result.skippedApps).toBe(1);
    const skipped = result.perApp.find((p) => p.app === "no-repo");
    expect(skipped?.error).toContain("no brain.repo configured");
  });

  it("records signals across multiple apps in the event log", async () => {
    seedBrainWithRepo(sandbox, "personal", "alpha", "/repo/alpha");
    seedBrainWithRepo(sandbox, "personal", "beta", "/repo/beta");
    const c = fakeCollector("yarn-audit", [
      {
        kind: "yarn-audit",
        severity: "high",
        summary: "advisory",
      },
    ]);
    await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [c],
      ctx: fakeDaemonCtx(),
    });

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT app_id, payload FROM events WHERE kind = 'signal' ORDER BY id",
        )
        .all() as Array<{ app_id: string; payload: string }>;
      expect(rows).toHaveLength(2);
      const apps = rows.map((r) => r.app_id).sort();
      expect(apps).toEqual(["alpha", "beta"]);
    } finally {
      db.close();
    }
  });

  it("logs a sweep-complete summary at info level", async () => {
    seedBrainWithRepo(sandbox, "personal", "alpha", "/repo/alpha");
    let logCalled = false;
    let logMeta: Record<string, unknown> | undefined;
    const ctx = fakeDaemonCtx();
    ctx.logger.info = (msg, meta) => {
      if (msg.includes("sweep complete")) {
        logCalled = true;
        logMeta = meta as Record<string, unknown> | undefined;
      }
    };
    await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("noop")],
      ctx,
    });
    expect(logCalled).toBe(true);
    expect(logMeta?.["scannedApps"]).toBe(1);
  });

  it("returns zero counts and emits no log when no apps exist", async () => {
    let logCalled = false;
    const ctx = fakeDaemonCtx();
    ctx.logger.info = () => {
      logCalled = true;
    };
    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("noop")],
      ctx,
    });
    expect(result.scannedApps).toBe(0);
    expect(result.skippedApps).toBe(0);
    expect(logCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAnalystService — interval + tickInFlight guard
// ---------------------------------------------------------------------------

describe("createAnalystService tickInFlight guard", () => {
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

  it("does not invoke the tick body concurrently", async () => {
    const tickMs = 20;
    let tickCallCount = 0;
    let resolveSlowTick!: () => void;
    const slowTickDone = new Promise<void>((resolve) => {
      resolveSlowTick = resolve;
    });

    const service = createAnalystService({
      dataDir: sandbox.dataDir,
      tickMs,
      _tickBody: async () => {
        tickCallCount++;
        if (tickCallCount === 1) {
          await slowTickDone;
        }
      },
    });

    const ctx = fakeDaemonCtx();
    service.start(ctx);
    // Let several interval fires happen while the first tick is held.
    await new Promise((r) => setTimeout(r, 100));
    expect(tickCallCount).toBe(1);
    service.stop();
    resolveSlowTick(); // unblock for cleanup
  });

  it("resets tickInFlight even when the tick body throws", async () => {
    let tickCallCount = 0;
    const service = createAnalystService({
      dataDir: sandbox.dataDir,
      tickMs: 10,
      _tickBody: async () => {
        tickCallCount++;
        throw new Error("boom");
      },
    });
    service.start(fakeDaemonCtx());
    await new Promise((r) => setTimeout(r, 60));
    service.stop();
    // Each interval fire ran (the prior tick threw + finally reset the
    // guard) — count > 1 confirms recovery.
    expect(tickCallCount).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// runAnalystTick — observeImpact auto-fire
// ---------------------------------------------------------------------------

describe("runAnalystTick observeImpact integration", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  const NOW = new Date("2026-05-04T12:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    fs.rmSync(brainDir(sandbox.dataDir, "personal", "jarvis"), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function backdate(planPath: string, hoursAgo: number): void {
    const t = new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000);
    fs.utimesSync(planPath, t, t);
  }

  function seedAutoDrafted(planId: string, dedupKey: string, app: string): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: app,
        vaultId: "personal",
        kind: "auto-drafted",
        payload: {
          signalKind: "yarn-audit",
          signalDedupKey: dedupKey,
          signalSeverity: "critical",
          planId,
          actor: "analyst",
        },
      });
    } finally {
      conn.close();
    }
  }

  it("does NOT fire observation when input.observeImpact is omitted", async () => {
    seedBrainWithRepo(sandbox, "personal", "demo", "/repo/demo");
    const planPath = dropPlan(sandbox, "plan-x", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    backdate(planPath, 48);
    seedAutoDrafted("plan-x", "yarn-audit:CVE-X", "demo");

    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("noop", [])],
      ctx: fakeDaemonCtx(),
      // no observeImpact key
    });
    expect(result.impactObservationsRun).toBe(0);
    expect(result.impactVerdicts).toBeUndefined();
  });

  it("fires observations on eligible plans and counts the verdicts", async () => {
    seedBrainWithRepo(sandbox, "personal", "demo", "/repo/demo");

    const fixedPlan = dropPlan(sandbox, "plan-fixed", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    backdate(fixedPlan, 48);
    seedAutoDrafted("plan-fixed", "yarn-audit:CVE-FIXED", "demo");

    const stuckPlan = dropPlan(sandbox, "plan-stuck", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    backdate(stuckPlan, 48);
    seedAutoDrafted("plan-stuck", "yarn-audit:CVE-STUCK", "demo");

    // Collector emits CVE-STUCK only (CVE-FIXED is gone).
    const collector = fakeCollector("yarn-audit", [
      {
        kind: "yarn-audit",
        severity: "critical",
        summary: "still broken",
        dedupKey: "yarn-audit:CVE-STUCK",
      },
    ]);

    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [collector],
      ctx: fakeDaemonCtx(),
      observeImpact: { delayHours: 24, now: NOW },
    });

    expect(result.impactObservationsRun).toBe(2);
    expect(result.impactVerdicts).toEqual({
      success: 1,
      "null-result": 1,
      "wrong-status": 0,
      "no-baseline": 0,
    });
  });

  it("skips plans whose mtime is younger than delayHours", async () => {
    seedBrainWithRepo(sandbox, "personal", "demo", "/repo/demo");
    const fresh = dropPlan(sandbox, "plan-fresh", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    backdate(fresh, 2); // only 2h old
    seedAutoDrafted("plan-fresh", "yarn-audit:CVE-X", "demo");

    const result = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("noop", [])],
      ctx: fakeDaemonCtx(),
      observeImpact: { delayHours: 24, now: NOW },
    });
    expect(result.impactObservationsRun).toBe(0);
  });

  it("skips a plan whose impact has already been observed (idempotent)", async () => {
    seedBrainWithRepo(sandbox, "personal", "demo", "/repo/demo");
    const planPath = dropPlan(sandbox, "plan-done", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    backdate(planPath, 48);
    seedAutoDrafted("plan-done", "yarn-audit:CVE-DONE", "demo");

    // First tick fires the observation
    const r1 = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("yarn-audit", [])],
      ctx: fakeDaemonCtx(),
      observeImpact: { delayHours: 24, now: NOW },
    });
    expect(r1.impactObservationsRun).toBe(1);

    // Second tick — no re-fire even though plan still on disk + impact-observed event present
    const r2 = await runAnalystTick({
      dataDir: sandbox.dataDir,
      collectors: [fakeCollector("yarn-audit", [])],
      ctx: fakeDaemonCtx(),
      observeImpact: { delayHours: 24, now: NOW },
    });
    expect(r2.impactObservationsRun).toBe(0);
  });
});
