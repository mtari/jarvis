import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../../orchestrator/anthropic-client.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import {
  readFiredPlanIds,
  runPlanExecutorTick,
} from "./service.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";

const VALID_IMPL_PLAN_BLOCK = (parentId: string): string =>
  `<plan>
# Plan: Add status command — implementation
Type: implementation
ParentPlan: ${parentId}
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: developer
Confidence: 75 — small CLI extension

## Approach
Wire a new "status" case into the existing dispatcher.

## File changes
- cli/index.ts: add a status command branch.

## Schema changes
N/A

## New dependencies
N/A

## API surface
N/A

## Testing strategy
Unit tests for the formatter; manual smoke run.

## Risk & rollback
Low risk. Revert the PR.

## Open questions
None.

## Success metric
N/A

## Observation window
N/A

## Connections required
- None: present

## Rollback
See parent.

## Estimated effort
- Claude calls: ~3
- Your review time: 5 min
- Wall-clock to ship: 1 hour

## Amendment clauses
None.
</plan>`;

interface ScriptedClient {
  client: AnthropicClient;
  calls: ChatRequest[];
}

function fixedTextResponse(text: string): ChatResponse {
  return {
    text,
    blocks: [
      { type: "text", text, citations: null } as Anthropic.TextBlock,
    ],
    stopReason: "end_turn",
    model: "claude-sonnet-4-6",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    redactions: [],
  };
}

function scriptedClient(responses: string[]): ScriptedClient {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        if (i >= responses.length) {
          throw new Error("scripted client out of responses");
        }
        return fixedTextResponse(responses[i++]!);
      },
    },
  };
}

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

describe("plan-executor", () => {
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

  it("fires Developer Mode A on an approved improvement plan with ImplementationReview required", async () => {
    const parentId = "2026-04-28-auto";
    dropPlan(sandbox, parentId, {
      status: "approved",
      implementationReview: "required",
    });
    const { client } = scriptedClient([VALID_IMPL_PLAN_BLOCK(parentId)]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.mode).toBe("draft-impl");
    // Impl plan was actually written to disk
    const impl = findPlan(sandbox.dataDir, `${parentId}-impl`);
    expect(impl).toBeTruthy();
  });

  it("does not fire twice — second tick sees the plan-executor-fired event and skips", async () => {
    const parentId = "2026-04-28-once";
    dropPlan(sandbox, parentId, {
      status: "approved",
      implementationReview: "required",
    });
    const { client, calls } = scriptedClient([
      VALID_IMPL_PLAN_BLOCK(parentId),
    ]);

    const first = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(first.fired).toHaveLength(1);
    const callsAfterFirst = calls.length;

    const second = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(second.fired).toHaveLength(0);
    expect(calls.length).toBe(callsAfterFirst); // no new API call
  });

  it("skips plans whose app isn't in enabledApps", async () => {
    dropPlan(sandbox, "2026-04-28-other", {
      status: "approved",
      app: "erdei-fahazak",
    });
    const { client, calls } = scriptedClient([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("only enabled for jarvis");
    expect(calls.length).toBe(0);

    // Recorded as fired (skipped) so it doesn't re-trigger next tick
    const fired = readFiredPlanIds(dbFile(sandbox.dataDir));
    expect(fired.has("2026-04-28-other")).toBe(true);
  });

  it("skips plans not in approved state", async () => {
    dropPlan(sandbox, "2026-04-28-draft", { status: "draft" });
    dropPlan(sandbox, "2026-04-28-pending", { status: "awaiting-review" });
    const { client } = scriptedClient([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("records plan-executor-fired with the failure when Developer throws", async () => {
    dropPlan(sandbox, "2026-04-28-fail", {
      status: "approved",
      implementationReview: "required",
    });
    // Mock returns a non-plan response → draftImpl throws
    const { client } = scriptedClient(["not a plan"]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      client,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.reason).toMatch(/error/);
    // And it's recorded so we don't auto-retry
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("2026-04-28-fail")).toBe(true);
  });
});
