import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { brainDir, brainFile, dbFile } from "../cli/paths.ts";
import { saveBrain } from "../orchestrator/brain.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { listPlans } from "../orchestrator/plan-store.ts";
import {
  autoDraftFromSignals,
  observeImpact,
  readAutoDraftedDedupKeys,
  runAnalystScan,
} from "./analyst.ts";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import type {
  Signal,
  SignalCollector,
  CollectorContext,
} from "../tools/scanners/types.ts";

function fakeCollector(
  kind: string,
  signals: Signal[] = [],
  opts: { duration?: number; throws?: Error } = {},
): SignalCollector & { calls: CollectorContext[] } {
  const calls: CollectorContext[] = [];
  const collector: SignalCollector & { calls: CollectorContext[] } = {
    kind,
    description: `fake ${kind}`,
    calls,
    async collect(ctx: CollectorContext): Promise<Signal[]> {
      calls.push(ctx);
      if (opts.throws) throw opts.throws;
      if (opts.duration) {
        await new Promise((r) => setTimeout(r, opts.duration));
      }
      return signals;
    },
  };
  return collector;
}

describe("runAnalystScan", () => {
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

  it("runs every collector against the given context", async () => {
    const c1 = fakeCollector("a");
    const c2 = fakeCollector("b");
    await runAnalystScan({
      dataDir: sandbox.dataDir,
      app: "demo",
      vault: "personal",
      ctx: { cwd: "/repo", app: "demo" },
      collectors: [c1, c2],
    });
    expect(c1.calls).toHaveLength(1);
    expect(c1.calls[0]).toEqual({ cwd: "/repo", app: "demo" });
    expect(c2.calls).toHaveLength(1);
  });

  it("records each signal as a `signal` event in the DB", async () => {
    const c = fakeCollector("yarn-audit", [
      {
        kind: "yarn-audit",
        severity: "high",
        summary: "lodash advisory",
        dedupKey: "yarn-audit:CVE-X",
        details: { module: "lodash" },
      },
      {
        kind: "yarn-audit",
        severity: "medium",
        summary: "axios advisory",
        dedupKey: "yarn-audit:CVE-Y",
      },
    ]);
    await runAnalystScan({
      dataDir: sandbox.dataDir,
      app: "demo",
      vault: "personal",
      ctx: { cwd: "/repo", app: "demo" },
      collectors: [c],
    });

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT app_id, vault_id, payload FROM events WHERE kind = 'signal' ORDER BY id",
        )
        .all() as Array<{ app_id: string; vault_id: string; payload: string }>;
      expect(rows).toHaveLength(2);
      const first = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
      expect(first).toMatchObject({
        kind: "yarn-audit",
        severity: "high",
        summary: "lodash advisory",
        dedupKey: "yarn-audit:CVE-X",
      });
      expect(rows[0]!.app_id).toBe("demo");
      expect(rows[0]!.vault_id).toBe("personal");
    } finally {
      db.close();
    }
  });

  it("does not write events when no collectors emit signals", async () => {
    const c = fakeCollector("noop", []);
    const result = await runAnalystScan({
      dataDir: sandbox.dataDir,
      app: "demo",
      vault: "personal",
      ctx: { cwd: "/repo", app: "demo" },
      collectors: [c],
    });
    expect(result.signals).toHaveLength(0);
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const count = (
        db
          .prepare("SELECT COUNT(*) as c FROM events WHERE kind = 'signal'")
          .get() as { c: number }
      ).c;
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("returns per-collector summary with kind, signal count, and duration", async () => {
    const c1 = fakeCollector("fast", [
      { kind: "fast", severity: "low", summary: "x" },
    ]);
    const c2 = fakeCollector(
      "slow",
      [
        { kind: "slow", severity: "low", summary: "y" },
        { kind: "slow", severity: "low", summary: "z" },
      ],
      { duration: 5 },
    );
    const result = await runAnalystScan({
      dataDir: sandbox.dataDir,
      app: "demo",
      vault: "personal",
      ctx: { cwd: "/repo", app: "demo" },
      collectors: [c1, c2],
    });
    expect(result.byCollector).toHaveLength(2);
    expect(result.byCollector[0]).toMatchObject({
      kind: "fast",
      signalCount: 1,
    });
    expect(result.byCollector[1]).toMatchObject({
      kind: "slow",
      signalCount: 2,
    });
    expect(result.byCollector[1]?.durationMs).toBeGreaterThanOrEqual(5);
  });

  it("records the error and continues when a collector throws", async () => {
    const broken = fakeCollector("broken", [], {
      throws: new Error("boom"),
    });
    const ok = fakeCollector("ok", [
      { kind: "ok", severity: "low", summary: "fine" },
    ]);
    const result = await runAnalystScan({
      dataDir: sandbox.dataDir,
      app: "demo",
      vault: "personal",
      ctx: { cwd: "/repo", app: "demo" },
      collectors: [broken, ok],
    });
    expect(result.byCollector[0]?.error).toBe("boom");
    expect(result.byCollector[0]?.signalCount).toBe(0);
    // The healthy collector still ran and recorded its signal
    expect(result.byCollector[1]?.signalCount).toBe(1);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// autoDraftFromSignals — Strategist hand-off
// ---------------------------------------------------------------------------

const VALID_PLAN_DRAFT = `<plan>
# Plan: Address auto-detected finding
Type: improvement
Subtype: bugfix
ImplementationReview: skip
App: demo
Priority: high
Destructive: false
Status: draft
Author: strategist
Confidence: 80 — auto-detected by Analyst, narrow surface

## Problem

A signal from the analyst pipeline reported an issue that needs addressing.

## Build plan

- Identify the affected code or dependency.
- Apply a targeted fix.
- Verify with the existing test suite.

## Testing strategy

Unit tests for the affected component. Manual verification on the staging deploy.

## Acceptance criteria

- The signal no longer fires on the next analyst sweep.
- No regression in existing tests.
</plan>`;

interface FakeStrategistCall {
  brief: string;
}

function fakeStrategistClient(
  responseTexts: string[] = [VALID_PLAN_DRAFT],
): { client: AnthropicClient; calls: FakeStrategistCall[] } {
  const calls: FakeStrategistCall[] = [];
  let i = 0;
  const client: AnthropicClient = {
    async chat(req) {
      const initialUser = req.messages.find((m) => m.role === "user");
      const brief =
        typeof initialUser?.content === "string" ? initialUser.content : "";
      calls.push({ brief });
      const text =
        i < responseTexts.length
          ? responseTexts[i++]!
          : responseTexts[responseTexts.length - 1]!;
      return {
        text,
        blocks: [{ type: "text", text }],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
    },
  };
  return { client, calls };
}

describe("autoDraftFromSignals", () => {
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

  function severityCriticalSignal(): Signal {
    return {
      kind: "yarn-audit",
      severity: "critical",
      summary: "critical advisory in lodash",
      dedupKey: "yarn-audit:CVE-2026-X",
      details: { module: "lodash" },
    };
  }

  it("drafts a plan and records an auto-drafted event for a fresh critical signal", async () => {
    const { client, calls } = fakeStrategistClient([VALID_PLAN_DRAFT]);
    const result = await autoDraftFromSignals({
      signals: [severityCriticalSignal()],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    expect(result.draftedCount).toBe(1);
    expect(result.entries[0]?.planId).toBeDefined();
    expect(calls).toHaveLength(1);
    // The brief mentions the collector + signal context
    expect(calls[0]?.brief).toContain("yarn-audit collector");
    expect(calls[0]?.brief).toContain("critical advisory in lodash");

    // The plan markdown is written to disk and an `auto-drafted` event was recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'auto-drafted'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        signalKind: "yarn-audit",
        signalDedupKey: "yarn-audit:CVE-2026-X",
        actor: "analyst",
      });
    } finally {
      db.close();
    }
  });

  it("does NOT redraft on a second call with the same dedupKey", async () => {
    const signal = severityCriticalSignal();
    const { client: c1 } = fakeStrategistClient();
    await autoDraftFromSignals({
      signals: [signal],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client: c1,
    });
    // Second call: brand-new client so we can assert no chat() was made
    const { client: c2, calls: secondCalls } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [signal],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client: c2,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.alreadyDraftedCount).toBe(1);
    expect(secondCalls).toHaveLength(0);
    expect(result.entries[0]?.skippedReason).toContain("already auto-drafted");
  });

  it("does NOT redraft within the same call when two signals share a dedupKey", async () => {
    const a = severityCriticalSignal();
    const b: Signal = { ...a, summary: "duplicate" };
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [a, b],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    expect(result.draftedCount).toBe(1);
    expect(result.alreadyDraftedCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("skips signals below the severity threshold (default critical)", async () => {
    const lowSignal: Signal = {
      kind: "yarn-audit",
      severity: "low",
      summary: "low advisory",
      dedupKey: "yarn-audit:CVE-LOW",
    };
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [lowSignal],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.belowThresholdCount).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("severityThreshold can be lowered to also draft on high signals", async () => {
    const highSignal: Signal = {
      kind: "yarn-audit",
      severity: "high",
      summary: "high advisory",
      dedupKey: "yarn-audit:CVE-HIGH",
    };
    const { client } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [highSignal],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
      severityThreshold: "high",
    });
    expect(result.draftedCount).toBe(1);
  });

  it("refuses to auto-draft a signal with no dedupKey", async () => {
    const signal: Signal = {
      kind: "yarn-audit",
      severity: "critical",
      summary: "critical without dedup",
      // no dedupKey
    };
    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [signal],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    expect(result.draftedCount).toBe(0);
    expect(result.noDedupKeyCount).toBe(1);
    expect(result.entries[0]?.skippedReason).toContain("no dedupKey");
    expect(calls).toHaveLength(0);
  });

  it("records the strategist error per-entry and continues with the next signal", async () => {
    const signalA = severityCriticalSignal();
    const signalB: Signal = {
      ...signalA,
      dedupKey: "yarn-audit:CVE-OTHER",
      summary: "different critical",
    };
    // First Strategist response is malformed (no <plan>); second is valid.
    const { client } = fakeStrategistClient([
      "no plan tag here",
      VALID_PLAN_DRAFT,
    ]);
    const result = await autoDraftFromSignals({
      signals: [signalA, signalB],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    expect(result.errorCount).toBe(1);
    expect(result.draftedCount).toBe(1);
    expect(result.entries[0]?.skippedReason).toContain("strategist error");
    expect(result.entries[1]?.planId).toBeDefined();
  });

  it("readAutoDraftedDedupKeys returns the set of known dedup keys", async () => {
    const { client } = fakeStrategistClient();
    await autoDraftFromSignals({
      signals: [severityCriticalSignal()],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });
    const keys = readAutoDraftedDedupKeys(dbFile(sandbox.dataDir));
    expect(keys.has("yarn-audit:CVE-2026-X")).toBe(true);
    expect(keys.size).toBe(1);
  });

  it("skips signals whose dedupKey is suppressed", async () => {
    // Suppress the dedup key first
    const { suppress } = await import("../orchestrator/suppressions.ts");
    suppress(dbFile(sandbox.dataDir), {
      patternId: "yarn-audit:CVE-2026-X",
      pattern: "lodash advisory — accepted risk",
    });

    const { client, calls } = fakeStrategistClient();
    const result = await autoDraftFromSignals({
      signals: [severityCriticalSignal()],
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      client,
    });

    expect(result.draftedCount).toBe(0);
    expect(result.suppressedCount).toBe(1);
    expect(result.entries[0]?.skippedReason).toContain("suppressed");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// observeImpact — post-merge observation
// ---------------------------------------------------------------------------

describe("observeImpact", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

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

  function seedAppWithRepo(app: string, rootPath = "/tmp/jarvis-test-repo"): void {
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", app), {
      recursive: true,
    });
    saveBrain(brainFile(sandbox.dataDir, "personal", app), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
      repo: { rootPath },
    });
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

  function readImpactEvents(): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT payload FROM events WHERE kind = 'impact-observed'")
        .all() as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      conn.close();
    }
  }

  it("verdict=success when the source dedupKey is no longer produced", async () => {
    seedAppWithRepo("demo");
    dropPlan(sandbox, "plan-fixed", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    seedAutoDrafted("plan-fixed", "yarn-audit:CVE-X", "demo");

    // Collector returns NO signals — the fix held.
    const noSignals = fakeCollector("yarn-audit", []);
    const result = await observeImpact({
      dataDir: sandbox.dataDir,
      planId: "plan-fixed",
      collectors: [noSignals],
    });

    expect(result.verdict).toBe("success");
    expect(result.dedupKeyStillPresent).toBe(false);
    expect(result.newStatus).toBe("success");
    expect(result.signalDedupKey).toBe("yarn-audit:CVE-X");

    // Plan transitioned on disk
    const planRecord = listPlans(sandbox.dataDir).find(
      (p) => p.id === "plan-fixed",
    );
    expect(planRecord?.plan.metadata.status).toBe("success");

    // impact-observed event recorded
    const events = readImpactEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      planId: "plan-fixed",
      sourceDedupKey: "yarn-audit:CVE-X",
      verdict: "success",
    });
  });

  it("verdict=null-result when the source dedupKey is still produced", async () => {
    seedAppWithRepo("demo");
    dropPlan(sandbox, "plan-stuck", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    seedAutoDrafted("plan-stuck", "yarn-audit:CVE-Y", "demo");

    // Collector still emits the same dedupKey — the fix did not hold.
    const stillBroken = fakeCollector("yarn-audit", [
      {
        kind: "yarn-audit",
        severity: "critical",
        summary: "still broken",
        dedupKey: "yarn-audit:CVE-Y",
      },
    ]);
    const result = await observeImpact({
      dataDir: sandbox.dataDir,
      planId: "plan-stuck",
      collectors: [stillBroken],
    });

    expect(result.verdict).toBe("null-result");
    expect(result.dedupKeyStillPresent).toBe(true);
    expect(result.newStatus).toBe("null-result");

    const planRecord = listPlans(sandbox.dataDir).find(
      (p) => p.id === "plan-stuck",
    );
    expect(planRecord?.plan.metadata.status).toBe("null-result");

    const events = readImpactEvents();
    expect(events[0]).toMatchObject({ verdict: "null-result" });
  });

  it("returns wrong-status without acting when the plan isn't in shipped-pending-impact", async () => {
    seedAppWithRepo("demo");
    dropPlan(sandbox, "plan-draft", {
      app: "demo",
      status: "awaiting-review",
    });
    seedAutoDrafted("plan-draft", "yarn-audit:CVE-Z", "demo");

    const collector = fakeCollector("yarn-audit", []);
    const result = await observeImpact({
      dataDir: sandbox.dataDir,
      planId: "plan-draft",
      collectors: [collector],
    });

    expect(result.verdict).toBe("wrong-status");
    expect(result.message).toContain("awaiting-review");

    // Plan unchanged
    const planRecord = listPlans(sandbox.dataDir).find(
      (p) => p.id === "plan-draft",
    );
    expect(planRecord?.plan.metadata.status).toBe("awaiting-review");

    // Collector NOT invoked
    expect(collector.calls).toHaveLength(0);
    // No event recorded
    expect(readImpactEvents()).toHaveLength(0);
  });

  it("returns no-baseline when there's no auto-drafted event for this plan", async () => {
    seedAppWithRepo("demo");
    dropPlan(sandbox, "plan-orphan", {
      app: "demo",
      status: "shipped-pending-impact",
    });
    // No seedAutoDrafted call — there's no baseline.

    const collector = fakeCollector("yarn-audit", []);
    const result = await observeImpact({
      dataDir: sandbox.dataDir,
      planId: "plan-orphan",
      collectors: [collector],
    });

    expect(result.verdict).toBe("no-baseline");
    expect(result.message).toContain("no auto-drafted event");
    expect(collector.calls).toHaveLength(0);
    expect(readImpactEvents()).toHaveLength(0);

    // Plan unchanged
    const planRecord = listPlans(sandbox.dataDir).find(
      (p) => p.id === "plan-orphan",
    );
    expect(planRecord?.plan.metadata.status).toBe("shipped-pending-impact");
  });

  it("throws when the plan id doesn't exist", async () => {
    await expect(
      observeImpact({
        dataDir: sandbox.dataDir,
        planId: "no-such-plan",
        collectors: [fakeCollector("x", [])],
      }),
    ).rejects.toThrow(/plan not found/);
  });

  it("throws when the plan's app has no brain.repo configured", async () => {
    // Seed brain WITHOUT a repo
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", "no-repo"), {
      recursive: true,
    });
    saveBrain(brainFile(sandbox.dataDir, "personal", "no-repo"), {
      schemaVersion: 1,
      projectName: "no-repo",
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
    });
    dropPlan(sandbox, "plan-no-repo", {
      app: "no-repo",
      status: "shipped-pending-impact",
    });
    seedAutoDrafted("plan-no-repo", "yarn-audit:CVE-W", "no-repo");

    await expect(
      observeImpact({
        dataDir: sandbox.dataDir,
        planId: "plan-no-repo",
        collectors: [fakeCollector("yarn-audit", [])],
      }),
    ).rejects.toThrow(/no brain\.repo configured/);
  });
});
