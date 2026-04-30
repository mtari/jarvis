import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { dbFile } from "../cli/paths.ts";
import { runAnalystScan } from "./analyst.ts";
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
