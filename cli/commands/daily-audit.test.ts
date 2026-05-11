import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runDailyAuditCommand } from "./daily-audit.ts";

const PLAN_RESPONSE = `<plan>
# Plan: Tighten Strategist scope rule
Type: improvement
Subtype: rework
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 75 — fixture

## Problem
Override rate climbing.

## Build plan
- Tighten the Strategist prompt.

## Testing strategy
Manual.

## Acceptance criteria
- ok

## Success metric
- Metric: improvement override rate
- Baseline: 50%
- Target: 30%
- Data source: yarn jarvis telemetry

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause if approval rate drops.
</plan>`;

function fakeClient(): AnthropicClient {
  return {
    async chat() {
      const r: ChatResponse = {
        text: PLAN_RESPONSE,
        blocks: [{ type: "text", text: PLAN_RESPONSE }],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
      return r;
    },
  };
}

const A_FRIDAY = new Date("2026-05-08T12:00:00.000Z");

function seedSignal(sandbox: InstallSandbox): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "plan-drafted",
      payload: { planId: "x1", type: "improvement" },
    });
    recordFeedback(db, {
      kind: "reject",
      actor: "user",
      targetType: "plan",
      targetId: "x1",
      note: "the scope is bad",
    });
  } finally {
    db.close();
  }
}

describe("runDailyAuditCommand", () => {
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

  it("prints a skip report when there's been no project throughput", async () => {
    const code = await runDailyAuditCommand([], {
      buildClient: fakeClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Daily audit skipped");
    expect(out).toContain("no-throughput");
  });

  it("--force --dry-run runs without drafting", async () => {
    seedSignal(sandbox);
    const code = await runDailyAuditCommand(["--force", "--dry-run"], {
      buildClient: fakeClient,
      now: A_FRIDAY,
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Daily audit ran");
    expect(out).toContain("(none — dry-run or no slots)");
  });

  it("--force drafts a plan when signal is present", async () => {
    seedSignal(sandbox);
    const code = await runDailyAuditCommand(["--force"], {
      buildClient: fakeClient,
      now: A_FRIDAY,
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Drafted 1 plan(s)");
  });

  it("--format json emits a parseable result", async () => {
    seedSignal(sandbox);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const code = await runDailyAuditCommand(
        ["--force", "--format", "json"],
        {
          buildClient: fakeClient,
          now: A_FRIDAY,
        },
      );
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed = JSON.parse(written.trim()) as {
        ran: boolean;
        drafted: unknown[];
      };
      expect(parsed.ran).toBe(true);
      expect(parsed.drafted).toHaveLength(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("rejects invalid --format", async () => {
    const code = await runDailyAuditCommand(["--format", "xml"], {
      buildClient: fakeClient,
      now: A_FRIDAY,
    });
    expect(code).toBe(1);
  });

  it("rejects unknown options", async () => {
    const code = await runDailyAuditCommand(["--bogus"], {
      buildClient: fakeClient,
      now: A_FRIDAY,
    });
    expect(code).toBe(1);
  });
});
