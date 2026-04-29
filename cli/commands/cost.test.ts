import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runCost } from "./cost.ts";

interface AgentCallSeed {
  agent: string;
  model: string;
  planId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  appId?: string;
  createdAt?: string;
}

function seedCall(dbPath: string, opts: AgentCallSeed): void {
  const db = new Database(dbPath);
  try {
    appendEvent(db, {
      appId: opts.appId ?? "jarvis",
      vaultId: "personal",
      kind: "agent-call",
      payload: {
        agent: opts.agent,
        model: opts.model,
        ...(opts.planId !== undefined && { planId: opts.planId }),
        inputTokens: opts.inputTokens ?? 1_000_000,
        outputTokens: opts.outputTokens ?? 0,
        cachedInputTokens: opts.cachedInputTokens ?? 0,
        cacheCreationTokens: opts.cacheCreationTokens ?? 0,
      },
      ...(opts.createdAt !== undefined && { createdAt: opts.createdAt }),
    });
  } finally {
    db.close();
  }
}

describe("runCost", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logs: string[];

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logs = [];
    console.log = (msg?: unknown): void => {
      logs.push(typeof msg === "string" ? msg : String(msg));
    };
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("reports an empty month when no agent-call events exist", async () => {
    expect(await runCost([])).toBe(0);
    expect(logs.join("\n")).toContain("No agent calls recorded this month yet");
  });

  it("aggregates spend from agent-call events", async () => {
    // One Sonnet call: 1 of 150 calls, $3.00 informational
    seedCall(dbFile(sandbox.dataDir), {
      agent: "strategist",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
    });
    expect(await runCost([])).toBe(0);
    const out = logs.join("\n");
    // Today line: 1 / 150 calls
    expect(out).toMatch(/Today: 1 \/ 150 calls/);
    expect(out).toContain("strategist");
    // Informational USD still shown
    expect(out).toContain("$3.00");
  });

  it("warns when call count crosses the cap-warning threshold", async () => {
    // Cap to 1 call and warn-at default 0.8 → one call already >= cap.
    seedCall(dbFile(sandbox.dataDir), {
      agent: "developer",
      model: "claude-opus-4-7",
      inputTokens: 1_000_000,
    });
    await runCost(["--cap", "1"]);
    const out = logs.join("\n");
    expect(out).toContain("⚠");
    expect(out).toMatch(/Today: 1 \/ 1 calls/);
  });

  it("breaks down by agent / plan / model", async () => {
    seedCall(dbFile(sandbox.dataDir), {
      agent: "strategist",
      model: "claude-sonnet-4-6",
      inputTokens: 500_000,
      planId: "plan-A",
    });
    seedCall(dbFile(sandbox.dataDir), {
      agent: "developer",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      planId: "plan-A",
    });
    seedCall(dbFile(sandbox.dataDir), {
      agent: "developer",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 500_000,
      planId: "plan-B",
    });
    await runCost([]);
    const out = logs.join("\n");
    expect(out).toContain("By agent:");
    expect(out).toContain("strategist");
    expect(out).toContain("developer");
    expect(out).toContain("By plan");
    expect(out).toContain("plan-A");
    expect(out).toContain("plan-B");
    expect(out).toContain("By model:");
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).toContain("claude-haiku-4-5-20251001");
  });

  it("flags unknown models as falling back to default pricing", async () => {
    seedCall(dbFile(sandbox.dataDir), {
      agent: "strategist",
      model: "future-model-2030",
      inputTokens: 1_000_000,
    });
    await runCost([]);
    expect(logs.join("\n")).toContain("Pricing fell back to default");
  });

  it("emits structured JSON with --format json", async () => {
    seedCall(dbFile(sandbox.dataDir), {
      agent: "strategist",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
    });
    await runCost(["--format", "json"]);
    const json = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(json["callsToday"]).toBe(1);
    expect(json["callsMonth"]).toBe(1);
    expect(json["capCallsPerDay"]).toBe(150);
    expect(json["totalUsdInformational"]).toBe(3);
    expect(json["overWarnThreshold"]).toBe(false);
  });

  it("rejects invalid --cap and --format", async () => {
    expect(await runCost(["--cap", "-5"])).toBe(1);
    expect(await runCost(["--format", "yaml"])).toBe(1);
    expect(await runCost(["--warn-at", "1.5"])).toBe(1);
  });

  describe("--by-day", () => {
    it("shows a By day section with a single call on one day", async () => {
      seedCall(dbFile(sandbox.dataDir), {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-10T08:00:00.000Z",
      });
      expect(await runCost(["--by-day"])).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("By day:");
      expect(out).toContain("2026-04-10");
      expect(out).toContain("$3.00");
    });

    it("aggregates two calls on the same day into one row", async () => {
      const db = dbFile(sandbox.dataDir);
      // Two Sonnet calls on the same day — $3.00 + $3.00 = $6.00
      seedCall(db, {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-15T09:00:00.000Z",
      });
      seedCall(db, {
        agent: "developer",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-15T14:00:00.000Z",
      });
      expect(await runCost(["--by-day"])).toBe(0);
      const out = logs.join("\n");
      // Only one row for 2026-04-15
      const dayLines = out.split("\n").filter((l) => l.includes("2026-04-15"));
      expect(dayLines).toHaveLength(1);
      expect(dayLines[0]).toContain("$6.00");
    });

    it("splits calls across two days into separate rows sorted ascending", async () => {
      const db = dbFile(sandbox.dataDir);
      // Day 2 first in insertion order to verify sort
      seedCall(db, {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-20T10:00:00.000Z",
      });
      seedCall(db, {
        agent: "developer",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-19T10:00:00.000Z",
      });
      seedCall(db, {
        agent: "analyst",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-20T18:00:00.000Z",
      });
      expect(await runCost(["--by-day"])).toBe(0);
      const out = logs.join("\n");
      const daySection = out.split("By day:")[1] ?? "";
      const pos19 = daySection.indexOf("2026-04-19");
      const pos20 = daySection.indexOf("2026-04-20");
      expect(pos19).toBeGreaterThanOrEqual(0);
      expect(pos20).toBeGreaterThanOrEqual(0);
      // 2026-04-19 must appear before 2026-04-20
      expect(pos19).toBeLessThan(pos20);
      // 2026-04-19: 1 call = $3.00; 2026-04-20: 2 calls = $6.00
      const lines = daySection.split("\n").filter((l) => l.trim().length > 0);
      const line19 = lines.find((l) => l.includes("2026-04-19"));
      const line20 = lines.find((l) => l.includes("2026-04-20"));
      expect(line19).toContain("$3.00");
      expect(line20).toContain("$6.00");
    });

    it("total line matches aggregate spend regardless of --by-day", async () => {
      const db = dbFile(sandbox.dataDir);
      seedCall(db, {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-01T00:00:00.000Z",
      });
      seedCall(db, {
        agent: "developer",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-02T00:00:00.000Z",
      });

      // Capture total from plain run
      await runCost([]);
      const plainOut = logs.join("\n");
      logs.length = 0;

      // Capture total from --by-day run
      await runCost(["--by-day"]);
      const byDayOut = logs.join("\n");

      // Both should show $6.00 total (2 × $3.00)
      expect(plainOut).toContain("$6.00");
      expect(byDayOut).toContain("$6.00");

      // Extract the total lines specifically (line starting with ✓ or ⚠)
      const plainTotal = plainOut.split("\n").find((l) => /[✓⚠]/.test(l));
      const byDayTotal = byDayOut.split("\n").find((l) => /[✓⚠]/.test(l));
      expect(plainTotal).toBeDefined();
      expect(byDayTotal).toBeDefined();
      expect(plainTotal).toBe(byDayTotal);
    });

    it("does not show By day section when --by-day is not set", async () => {
      seedCall(dbFile(sandbox.dataDir), {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-10T08:00:00.000Z",
      });
      await runCost([]);
      expect(logs.join("\n")).not.toContain("By day:");
    });

    it("emits byDay array in JSON output when --by-day is set", async () => {
      const db = dbFile(sandbox.dataDir);
      seedCall(db, {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-01T12:00:00.000Z",
      });
      seedCall(db, {
        agent: "developer",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-02T12:00:00.000Z",
      });
      await runCost(["--format", "json", "--by-day"]);
      const json = JSON.parse(logs.join("\n")) as Record<string, unknown>;
      expect(Array.isArray(json["byDay"])).toBe(true);
      const byDay = json["byDay"] as Array<{ date: string; calls: number; totalUsd: number }>;
      expect(byDay).toHaveLength(2);
      expect(byDay[0]!.date).toBe("2026-04-01");
      expect(byDay[0]!.calls).toBe(1);
      expect(byDay[0]!.totalUsd).toBe(3);
      expect(byDay[1]!.date).toBe("2026-04-02");
      expect(byDay[1]!.totalUsd).toBe(3);
    });

    it("does not include byDay key in JSON output without --by-day", async () => {
      seedCall(dbFile(sandbox.dataDir), {
        agent: "strategist",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        createdAt: "2026-04-01T12:00:00.000Z",
      });
      await runCost(["--format", "json"]);
      const json = JSON.parse(logs.join("\n")) as Record<string, unknown>;
      expect(json["byDay"]).toBeUndefined();
    });

    it("empty month: --by-day still returns the empty-month message", async () => {
      expect(await runCost(["--by-day"])).toBe(0);
      expect(logs.join("\n")).toContain("No agent calls recorded this month yet");
    });
  });
});
