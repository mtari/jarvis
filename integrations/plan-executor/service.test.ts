import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
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
  assertCleanMain,
  createPlanExecutorService,
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

interface ScriptedTransport {
  transport: RunAgentTransport;
  calls: RunAgentResolvedOptions[];
}

function fixedRunResult(
  text: string,
  overrides: Partial<RunAgentResult> = {},
): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 5,
    durationMs: 1234,
    totalCostUsd: 0,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
    ...overrides,
  };
}

function scriptedTransport(responses: string[]): ScriptedTransport {
  const calls: RunAgentResolvedOptions[] = [];
  let i = 0;
  const transport: RunAgentTransport = async (resolved) => {
    calls.push(resolved);
    if (i >= responses.length) {
      throw new Error("scripted transport out of responses");
    }
    return fixedRunResult(responses[i++]!);
  };
  return { calls, transport };
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

// ---------------------------------------------------------------------------
// Helpers for a minimal git fixture repo used in assertCleanMain / queue tests
// ---------------------------------------------------------------------------

interface GitFixture {
  dir: string;
  cleanup: () => void;
}

function makeCleanMainRepo(): GitFixture {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-git-fixture-"));
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// assertCleanMain unit tests
// ---------------------------------------------------------------------------

describe("assertCleanMain", () => {
  it("passes on a clean main branch", () => {
    const repo = makeCleanMainRepo();
    try {
      expect(() => assertCleanMain(repo.dir)).not.toThrow();
    } finally {
      repo.cleanup();
    }
  });

  it("throws when HEAD is not on main", () => {
    const repo = makeCleanMainRepo();
    try {
      execSync("git checkout -b feat/other", { cwd: repo.dir, stdio: "pipe" });
      expect(() => assertCleanMain(repo.dir)).toThrow(/HEAD is on branch "feat\/other"/);
    } finally {
      repo.cleanup();
    }
  });

  it("throws when working tree is dirty", () => {
    const repo = makeCleanMainRepo();
    try {
      writeFileSync(join(repo.dir, "dirty.txt"), "untracked\n");
      expect(() => assertCleanMain(repo.dir)).toThrow(/working tree is dirty/);
    } finally {
      repo.cleanup();
    }
  });

  it("throws when there are staged changes", () => {
    const repo = makeCleanMainRepo();
    try {
      writeFileSync(join(repo.dir, "staged.txt"), "staged\n");
      execSync("git add staged.txt", { cwd: repo.dir, stdio: "pipe" });
      expect(() => assertCleanMain(repo.dir)).toThrow(/working tree is dirty/);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// runPlanExecutorTick — existing behaviour
// ---------------------------------------------------------------------------

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
    const { transport } = scriptedTransport([VALID_IMPL_PLAN_BLOCK(parentId)]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
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
    const { transport, calls } = scriptedTransport([
      VALID_IMPL_PLAN_BLOCK(parentId),
    ]);

    const first = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(first.fired).toHaveLength(1);
    const callsAfterFirst = calls.length;

    const second = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
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
    const { transport, calls } = scriptedTransport([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
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
    const { transport } = scriptedTransport([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
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
    const { transport } = scriptedTransport(["not a plan"]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      enabledApps: ["jarvis"],
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.reason).toMatch(/error/);
    // And it's recorded so we don't auto-retry
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("2026-04-28-fail")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Queue serialisation and assertCleanMain gate
// ---------------------------------------------------------------------------

describe("plan-executor execute-queue", () => {
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

  it("execute-mode fire is BLOCKED when repoRoot is dirty", async () => {
    const repo = makeCleanMainRepo();
    try {
      // Dirty the tree
      writeFileSync(join(repo.dir, "dirty.txt"), "untracked\n");

      // Use an improvement plan with ImplementationReview: skip → mode = execute
      dropPlan(sandbox, "2026-04-28-exec-dirty", {
        status: "approved",
        implementationReview: "skip",
      });

      const { transport } = scriptedTransport([]);
      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        enabledApps: ["jarvis"],
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);
      expect(result.fired[0]?.reason).toMatch(/BLOCKED.*dirty/i);
    } finally {
      repo.cleanup();
    }
  });

  it("execute-mode fire is BLOCKED when repoRoot HEAD is not main", async () => {
    const repo = makeCleanMainRepo();
    try {
      execSync("git checkout -b feat/other", { cwd: repo.dir, stdio: "pipe" });

      dropPlan(sandbox, "2026-04-28-exec-branch", {
        status: "approved",
        implementationReview: "skip",
      });

      const { transport } = scriptedTransport([]);
      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        enabledApps: ["jarvis"],
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);
      expect(result.fired[0]?.reason).toMatch(/BLOCKED.*feat\/other/i);
    } finally {
      repo.cleanup();
    }
  });

  it("draft-impl fires bypass the execute queue and are not affected by repoRoot state", async () => {
    const repo = makeCleanMainRepo();
    try {
      // Dirty the tree — draft-impl should still proceed
      writeFileSync(join(repo.dir, "dirty.txt"), "untracked\n");

      const parentId = "2026-04-28-impl-bypass";
      dropPlan(sandbox, parentId, {
        status: "approved",
        implementationReview: "required",
      });

      const { transport } = scriptedTransport([VALID_IMPL_PLAN_BLOCK(parentId)]);
      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        enabledApps: ["jarvis"],
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);
      expect(result.fired[0]?.mode).toBe("draft-impl");
      // No BLOCKED reason
      expect(result.fired[0]?.reason).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });

  it("two execute fires in one tick run sequentially — no concurrent overlap", async () => {
    const repo = makeCleanMainRepo();
    try {
      // Two execute-mode plans (both will be BLOCKED by dirty tree, but the
      // point is they must be attempted sequentially: queue ensures the first
      // completes before the second starts)
      writeFileSync(join(repo.dir, "dirty.txt"), "untracked\n");

      dropPlan(sandbox, "2026-04-28-seq-a", {
        status: "approved",
        implementationReview: "skip",
      });
      dropPlan(sandbox, "2026-04-28-seq-b", {
        status: "approved",
        implementationReview: "skip",
      });

      const { transport } = scriptedTransport([]);
      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        enabledApps: ["jarvis"],
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      // Both plans should have been attempted (and BLOCKED)
      expect(result.fired).toHaveLength(2);
      for (const f of result.fired) {
        expect(f.reason).toMatch(/BLOCKED/);
      }
      // No duplicates
      const ids = result.fired.map((f) => f.planId);
      expect(new Set(ids).size).toBe(2);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// tickInFlight guard — createPlanExecutorService must not invoke the tick
// body concurrently when a previous invocation is still running.
//
// Strategy: inject a `_tickBody` stub via the test-only option so we can
// precisely control timing without spying on module internals.
// ---------------------------------------------------------------------------

describe("createPlanExecutorService tickInFlight guard", () => {
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

  it("does not invoke the tick body concurrently: 3 interval fires with a slow tick → body called exactly once", async () => {
    // We start the service with a slow _tickBody that holds until we release
    // it. While tick #1 is suspended we stop the service (stopping clears the
    // interval), then release tick #1. The call count must be exactly 1
    // because all subsequent interval firings during the hold period were
    // dropped by the tickInFlight guard.
    const tickMs = 20;

    let tickCallCount = 0;
    let resolveSlowTick!: () => void;
    const slowTickDone = new Promise<void>((resolve) => {
      resolveSlowTick = resolve;
    });

    const service = createPlanExecutorService({
      dataDir: sandbox.dataDir,
      tickMs,
      enabledApps: ["jarvis"],
      _tickBody: async () => {
        tickCallCount++;
        // First invocation: block until we explicitly release.
        if (tickCallCount === 1) {
          await slowTickDone;
        }
      },
    });

    service.start(fakeDaemonCtx());

    // Give the initial void tickFn() a microtask turn to set tickInFlight=true
    // and reach the await inside _tickBody.
    await Promise.resolve();

    // Now wait 3× tickMs so the interval fires at least 3 times while tick #1
    // is still awaiting slowTickDone. All of those must be dropped.
    await new Promise<void>((r) => setTimeout(r, tickMs * 3 + 10));

    // Stop the service — clears the interval so no new firings can occur.
    service.stop();

    // Assert while tick #1 is still in flight: count must still be 1.
    expect(tickCallCount).toBe(1);

    // Release tick #1 (just to avoid hanging promises / unhandled rejections).
    resolveSlowTick();

    // Drain the promise chain.
    await Promise.resolve();
  }, 3000);

  it("tickInFlight resets to false after the tick body throws, allowing subsequent ticks to run", async () => {
    // tick #1 throws; after the finally block resets tickInFlight, tick #2
    // (fired on the next interval) must be allowed through.
    const tickMs = 20;
    let tickCallCount = 0;

    const service = createPlanExecutorService({
      dataDir: sandbox.dataDir,
      tickMs,
      enabledApps: ["jarvis"],
      _tickBody: async () => {
        tickCallCount++;
        if (tickCallCount === 1) {
          throw new Error("simulated tick failure");
        }
      },
    });

    service.start(fakeDaemonCtx());

    // Wait for tick #1 (throws immediately) to complete its finally block,
    // then one full interval for tick #2 to fire and finish.
    await new Promise<void>((r) => setTimeout(r, tickMs * 3));

    service.stop();

    // tickInFlight must have been reset by finally; tick #2 was allowed in.
    expect(tickCallCount).toBeGreaterThanOrEqual(2);
  }, 3000);
});
