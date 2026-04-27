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
    // 1M Sonnet input tokens = $3.00
    seedCall(dbFile(sandbox.dataDir), {
      agent: "strategist",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
    });
    expect(await runCost([])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("$3.00 / $50.00");
    expect(out).toContain("strategist");
  });

  it("warns when spend crosses the cap-warning threshold", async () => {
    // 1M Opus input tokens = $15.00; cap default $50; $15/$50 = 30% — under default 80%.
    // Use a low --cap to force the warning.
    seedCall(dbFile(sandbox.dataDir), {
      agent: "developer",
      model: "claude-opus-4-7",
      inputTokens: 1_000_000,
    });
    await runCost(["--cap", "10"]);
    const out = logs.join("\n");
    expect(out).toContain("⚠");
    expect(out).toContain("$15.00 / $10.00");
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
    expect(json["totalUsd"]).toBe(3);
    expect(json["totalCalls"]).toBe(1);
    expect(json["capUsd"]).toBe(50);
    expect(json["overWarnThreshold"]).toBe(false);
  });

  it("rejects invalid --cap and --format", async () => {
    expect(await runCost(["--cap", "-5"])).toBe(1);
    expect(await runCost(["--format", "yaml"])).toBe(1);
    expect(await runCost(["--warn-at", "1.5"])).toBe(1);
  });
});
