import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainDir, brainFile, dbFile } from "../paths.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { suppress } from "../../orchestrator/suppressions.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import {
  buildTriageReport,
  formatMarkdown,
  type TriageReport,
} from "./triage.ts";

describe("buildTriageReport", () => {
  const FIXED_NOW = new Date("2026-05-01T00:00:00.000Z");
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    // Install seeds a jarvis brain in the personal vault — wipe it so
    // every test starts with no apps and adds what it needs.
    fs.rmSync(brainDir(sandbox.dataDir, "personal", "jarvis"), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function db(): string {
    return dbFile(sandbox.dataDir);
  }

  function seedApp(
    vault: string,
    app: string,
    opts: { repo?: boolean } = {},
  ): void {
    fs.mkdirSync(brainDir(sandbox.dataDir, vault, app), { recursive: true });
    saveBrain(brainFile(sandbox.dataDir, vault, app), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
      ...(opts.repo === true && {
        repo: { rootPath: "/tmp/x" },
      }),
    });
  }

  function seedSignal(input: {
    app: string;
    vault?: string;
    severity: "low" | "medium" | "high" | "critical";
    summary?: string;
    kind?: string;
    dedupKey?: string;
    createdAt?: string;
  }): void {
    const conn = new Database(db());
    try {
      appendEvent(conn, {
        appId: input.app,
        vaultId: input.vault ?? "personal",
        kind: "signal",
        payload: {
          kind: input.kind ?? "yarn-audit",
          severity: input.severity,
          summary: input.summary ?? "test signal",
          ...(input.dedupKey !== undefined && { dedupKey: input.dedupKey }),
        },
        ...(input.createdAt !== undefined && { createdAt: input.createdAt }),
      });
    } finally {
      conn.close();
    }
  }

  function seedAutoDrafted(dedupKey: string, app: string): void {
    const conn = new Database(db());
    try {
      appendEvent(conn, {
        appId: app,
        vaultId: "personal",
        kind: "auto-drafted",
        payload: { signalDedupKey: dedupKey, planId: "plan-x" },
      });
    } finally {
      conn.close();
    }
  }

  function build(opts: { windowDays?: number } = {}): TriageReport {
    return buildTriageReport({
      dataDir: sandbox.dataDir,
      now: FIXED_NOW,
      windowDays: opts.windowDays ?? 7,
    });
  }

  // -------------------------------------------------------------------------
  // Critical signals section
  // -------------------------------------------------------------------------

  it("flags high/critical signals from the window", () => {
    seedSignal({
      app: "demo",
      severity: "critical",
      summary: "RCE in lodash",
      dedupKey: "yarn-audit:CVE-X",
      createdAt: "2026-04-30T00:00:00Z",
    });
    seedSignal({
      app: "demo",
      severity: "low",
      summary: "noisy",
      createdAt: "2026-04-30T00:00:00Z",
    });
    const report = build();
    expect(report.criticalSignals).toHaveLength(1);
    expect(report.criticalSignals[0]?.summary).toBe("RCE in lodash");
  });

  it("excludes signals older than the window", () => {
    seedSignal({
      app: "demo",
      severity: "high",
      summary: "ancient",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const report = build();
    expect(report.criticalSignals).toHaveLength(0);
  });

  it("excludes already auto-drafted signals", () => {
    seedSignal({
      app: "demo",
      severity: "high",
      summary: "drafted already",
      dedupKey: "yarn-audit:CVE-Y",
      createdAt: "2026-04-29T00:00:00Z",
    });
    seedAutoDrafted("yarn-audit:CVE-Y", "demo");
    const report = build();
    expect(report.criticalSignals).toHaveLength(0);
  });

  it("excludes suppressed signals", () => {
    seedSignal({
      app: "demo",
      severity: "high",
      summary: "muted",
      dedupKey: "yarn-audit:CVE-Z",
      createdAt: "2026-04-29T00:00:00Z",
    });
    suppress(db(), {
      patternId: "yarn-audit:CVE-Z",
      pattern: "muted under review",
    });
    const report = build();
    expect(report.criticalSignals).toHaveLength(0);
  });

  it("counts every-severity signals in the window", () => {
    seedSignal({
      app: "demo",
      severity: "low",
      createdAt: "2026-04-30T00:00:00Z",
    });
    seedSignal({
      app: "demo",
      severity: "medium",
      createdAt: "2026-04-30T00:00:00Z",
    });
    seedSignal({
      app: "demo",
      severity: "high",
      createdAt: "2026-04-30T00:00:00Z",
    });
    seedSignal({
      app: "demo",
      severity: "critical",
      createdAt: "2026-04-30T00:00:00Z",
    });
    const report = build();
    expect(report.counts.signalsBySeverity).toEqual({
      low: 1,
      medium: 1,
      high: 1,
      critical: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Plans sections
  // -------------------------------------------------------------------------

  it("lists plans awaiting review and counts by status", () => {
    seedApp("personal", "demo");
    dropPlan(sandbox, "20260501T0900-foo", {
      app: "demo",
      status: "awaiting-review",
      priority: "high",
      title: "Plan A",
    });
    dropPlan(sandbox, "20260501T0901-bar", {
      app: "demo",
      status: "approved",
      title: "Plan B",
    });
    const report = build();
    expect(report.pendingReviews).toHaveLength(1);
    expect(report.pendingReviews[0]?.title).toBe("Plan A");
    expect(report.counts.plansByStatus["awaiting-review"]).toBe(1);
    expect(report.counts.plansByStatus["approved"]).toBe(1);
  });

  it("sorts pending reviews by priority (blocking > high > normal > low)", () => {
    seedApp("personal", "demo");
    dropPlan(sandbox, "p-low", {
      app: "demo",
      status: "awaiting-review",
      priority: "low",
      title: "Low",
    });
    dropPlan(sandbox, "p-blocking", {
      app: "demo",
      status: "awaiting-review",
      priority: "blocking",
      title: "Blocking",
    });
    dropPlan(sandbox, "p-normal", {
      app: "demo",
      status: "awaiting-review",
      priority: "normal",
      title: "Normal",
    });
    const report = build();
    expect(report.pendingReviews.map((p) => p.priority)).toEqual([
      "blocking",
      "normal",
      "low",
    ]);
  });

  it("flags stuck plans: awaiting-review > 7d, executing > 1d", () => {
    seedApp("personal", "demo");
    const reviewPath = dropPlan(sandbox, "stuck-review", {
      app: "demo",
      status: "awaiting-review",
      title: "Stuck review",
    });
    const execPath = dropPlan(sandbox, "stuck-exec", {
      app: "demo",
      status: "executing",
      title: "Stuck exec",
    });
    // Backdate via fs.utimesSync — mtime is what planAgeDays reads
    const tenDaysAgo = new Date(FIXED_NOW.getTime() - 10 * 86_400_000);
    const twoDaysAgo = new Date(FIXED_NOW.getTime() - 2 * 86_400_000);
    fs.utimesSync(reviewPath, tenDaysAgo, tenDaysAgo);
    fs.utimesSync(execPath, twoDaysAgo, twoDaysAgo);

    const report = build();
    const titles = report.stuckPlans.map((p) => p.title).sort();
    expect(titles).toEqual(["Stuck exec", "Stuck review"]);
  });

  // -------------------------------------------------------------------------
  // Quiet apps section
  // -------------------------------------------------------------------------

  it("flags onboarded apps with no events ever", () => {
    seedApp("personal", "ghost");
    const report = build();
    expect(report.quietApps).toHaveLength(1);
    expect(report.quietApps[0]).toMatchObject({
      vault: "personal",
      app: "ghost",
      lastEventAt: null,
      daysSinceLastEvent: null,
    });
  });

  it("flags apps whose last event was >14d ago, ignores recently active ones", () => {
    seedApp("personal", "stale");
    seedApp("personal", "fresh");
    seedSignal({
      app: "stale",
      severity: "low",
      createdAt: "2026-03-01T00:00:00Z",
    });
    seedSignal({
      app: "fresh",
      severity: "low",
      createdAt: "2026-04-30T00:00:00Z",
    });
    const report = build();
    const apps = report.quietApps.map((a) => a.app).sort();
    expect(apps).toEqual(["stale"]);
  });

  // -------------------------------------------------------------------------
  // Expiring suppressions section
  // -------------------------------------------------------------------------

  it("surfaces suppressions expiring within 7 days", () => {
    suppress(
      db(),
      {
        patternId: "soon",
        pattern: "x",
        expiresAt: "2026-05-05T00:00:00Z",
      },
      FIXED_NOW,
    );
    suppress(
      db(),
      {
        patternId: "later",
        pattern: "y",
        expiresAt: "2026-08-01T00:00:00Z",
      },
      FIXED_NOW,
    );
    suppress(db(), { patternId: "no-expiry", pattern: "z" }, FIXED_NOW);
    const report = build();
    expect(report.expiringSuppressions.map((s) => s.patternId)).toEqual([
      "soon",
    ]);
    expect(report.counts.activeSuppressions).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown — output format
// ---------------------------------------------------------------------------

describe("formatMarkdown", () => {
  it("includes every section heading even when empty", () => {
    const empty: TriageReport = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      windowDays: 7,
      criticalSignals: [],
      pendingReviews: [],
      stuckPlans: [],
      quietApps: [],
      expiringSuppressions: [],
      counts: {
        signalsBySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        plansByStatus: {},
        activeSuppressions: 0,
      },
    };
    const md = formatMarkdown(empty);
    expect(md).toContain("# Triage — 2026-05-01");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Critical signals not yet drafted (0)");
    expect(md).toContain("## Plans awaiting review (0)");
    expect(md).toContain("## Stuck plans (0)");
    expect(md).toContain("## Quiet apps (0)");
    expect(md).toContain("## Suppressions expiring");
    expect(md).toContain("_Inbox is empty._");
  });

  it("renders critical signals + plans when present", () => {
    const report: TriageReport = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      windowDays: 7,
      criticalSignals: [
        {
          id: 1,
          createdAt: "2026-04-30T00:00:00Z",
          vault: "personal",
          app: "demo",
          kind: "yarn-audit",
          severity: "critical",
          summary: "RCE",
          dedupKey: "yarn-audit:CVE-X",
        },
      ],
      pendingReviews: [
        {
          id: "plan-a",
          vault: "personal",
          app: "demo",
          title: "Fix auth",
          status: "awaiting-review",
          priority: "high",
          ageDays: 2,
        },
      ],
      stuckPlans: [],
      quietApps: [],
      expiringSuppressions: [],
      counts: {
        signalsBySeverity: { low: 0, medium: 0, high: 0, critical: 1 },
        plansByStatus: { "awaiting-review": 1 },
        activeSuppressions: 0,
      },
    };
    const md = formatMarkdown(report);
    expect(md).toContain("**[CRITICAL]** demo/yarn-audit — RCE");
    expect(md).toContain("`plan-a` demo [high] — Fix auth (2d old)");
    expect(md).toContain("critical=1");
    expect(md).toContain("awaiting-review=1");
  });
});
