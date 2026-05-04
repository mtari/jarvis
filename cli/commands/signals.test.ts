import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runSignals } from "./signals.ts";

interface SeedSignal {
  app?: string;
  vault?: string;
  kind?: string;
  severity?: "low" | "medium" | "high" | "critical";
  summary?: string;
  dedupKey?: string;
  createdAt?: string;
}

function seedSignal(dbPath: string, s: SeedSignal = {}): void {
  const db = new Database(dbPath);
  try {
    appendEvent(db, {
      appId: s.app ?? "demo",
      vaultId: s.vault ?? "personal",
      kind: "signal",
      payload: {
        kind: s.kind ?? "yarn-audit",
        severity: s.severity ?? "low",
        summary: s.summary ?? "test signal",
        ...(s.dedupKey !== undefined && { dedupKey: s.dedupKey }),
      },
      ...(s.createdAt !== undefined && { createdAt: s.createdAt }),
    });
  } finally {
    db.close();
  }
}

describe("runSignals", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  function db(): string {
    return dbFile(sandbox.dataDir);
  }

  function lastLog(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  it("prints 'no signals' when the events table has none", async () => {
    const code = await runSignals([], { dbFilePath: db() });
    expect(code).toBe(0);
    expect(lastLog()).toContain("No signals");
  });

  it("prints a table for recorded signals", async () => {
    seedSignal(db(), {
      app: "demo",
      kind: "yarn-audit",
      severity: "high",
      summary: "lodash CVE-2026-1234",
    });
    const code = await runSignals([], { dbFilePath: db() });
    expect(code).toBe(0);
    const out = lastLog();
    expect(out).toContain("APP");
    expect(out).toContain("KIND");
    expect(out).toContain("SEVERITY");
    expect(out).toContain("demo");
    expect(out).toContain("yarn-audit");
    expect(out).toContain("HIGH");
    expect(out).toContain("lodash CVE-2026-1234");
  });

  it("filters by --app", async () => {
    seedSignal(db(), { app: "alpha", summary: "α-summary" });
    seedSignal(db(), { app: "beta", summary: "β-summary" });
    await runSignals(["--app", "alpha"], { dbFilePath: db() });
    const out = lastLog();
    expect(out).toContain("α-summary");
    expect(out).not.toContain("β-summary");
  });

  it("filters by --kind (collector kind, inside payload)", async () => {
    seedSignal(db(), { kind: "yarn-audit", summary: "audit-thing" });
    seedSignal(db(), { kind: "broken-links", summary: "links-thing" });
    await runSignals(["--kind", "yarn-audit"], { dbFilePath: db() });
    const out = lastLog();
    expect(out).toContain("audit-thing");
    expect(out).not.toContain("links-thing");
  });

  it("filters by --severity", async () => {
    seedSignal(db(), { severity: "low", summary: "low-thing" });
    seedSignal(db(), { severity: "critical", summary: "crit-thing" });
    await runSignals(["--severity", "critical"], { dbFilePath: db() });
    const out = lastLog();
    expect(out).toContain("crit-thing");
    expect(out).not.toContain("low-thing");
  });

  it("filters by --since (excludes earlier events)", async () => {
    seedSignal(db(), {
      summary: "old-thing",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    seedSignal(db(), {
      summary: "new-thing",
      createdAt: "2026-04-15T00:00:00.000Z",
    });
    await runSignals(["--since", "2026-04-01T00:00:00Z"], {
      dbFilePath: db(),
    });
    const out = lastLog();
    expect(out).toContain("new-thing");
    expect(out).not.toContain("old-thing");
  });

  it("respects --limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedSignal(db(), { summary: `signal-${i}` });
    }
    await runSignals(["--limit", "2"], { dbFilePath: db() });
    const out = lastLog();
    // 2 header lines + 2 data rows = 4 lines total
    expect(out.split("\n")).toHaveLength(4);
  });

  it("--format json emits a JSON array", async () => {
    seedSignal(db(), {
      app: "demo",
      kind: "broken-links",
      severity: "medium",
      summary: "404: https://x.example",
      dedupKey: "broken-links:https://x.example",
    });
    await runSignals(["--format", "json"], { dbFilePath: db() });
    const parsed = JSON.parse(lastLog());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      app: "demo",
      kind: "broken-links",
      severity: "medium",
      summary: "404: https://x.example",
      dedupKey: "broken-links:https://x.example",
    });
  });

  it("rejects invalid --severity", async () => {
    const code = await runSignals(["--severity", "boom"], { dbFilePath: db() });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(
      "invalid --severity",
    );
  });

  it("rejects invalid --since", async () => {
    const code = await runSignals(["--since", "not-a-date"], {
      dbFilePath: db(),
    });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(
      "invalid --since",
    );
  });

  it("rejects invalid --limit", async () => {
    const code = await runSignals(["--limit", "0"], { dbFilePath: db() });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(
      "invalid --limit",
    );
  });

  it("rejects invalid --format", async () => {
    const code = await runSignals(["--format", "xml"], { dbFilePath: db() });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(
      "invalid --format",
    );
  });
});
