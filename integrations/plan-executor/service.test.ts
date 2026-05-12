import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { brainDir, brainFile, dbFile } from "../../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import {
  assertCleanMain,
  countRecoveriesSinceLastAgentCall,
  createPlanExecutorService,
  findOrphanedClaims,
  findStaleExecuting,
  readFiredPlanIds,
  recoverOrphanedClaims,
  recoverStaleExecuting,
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

function seedBrain(
  sandbox: InstallSandbox,
  app: string,
  overrides: { repo?: { rootPath: string; monorepoPath?: string } } = {},
): void {
  mkdirSync(brainDir(sandbox.dataDir, "personal", app), { recursive: true });
  saveBrain(brainFile(sandbox.dataDir, "personal", app), {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    ...(overrides.repo !== undefined && { repo: overrides.repo }),
  });
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
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(first.fired).toHaveLength(1);
    const callsAfterFirst = calls.length;

    const second = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(second.fired).toHaveLength(0);
    expect(calls.length).toBe(callsAfterFirst); // no new API call
  });

  it("skips plans whose app has no brain.repo configured", async () => {
    dropPlan(sandbox, "2026-04-28-other", {
      status: "approved",
      app: "erdei-fahazak",
    });
    // Note: no brain for erdei-fahazak in this sandbox → resolveAppCwd
    // returns null → plan is skipped with the "no brain.repo" reason.
    const { transport, calls } = scriptedTransport([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("no brain.repo configured");
    expect(result.skipped[0]?.reason).toContain("erdei-fahazak");
    expect(calls.length).toBe(0);

    // The skip is recorded as a `plan-executor-fired` event but
    // `readFiredPlanIds` excludes refusal-style skips (per the
    // refusal-aware filter) so the plan re-evaluates next tick once the
    // user adds brain.repo via re-onboarding.
    const fired = readFiredPlanIds(dbFile(sandbox.dataDir));
    expect(fired.has("2026-04-28-other")).toBe(false);
  });

  it("skips plans not in approved state", async () => {
    dropPlan(sandbox, "2026-04-28-draft", { status: "draft" });
    dropPlan(sandbox, "2026-04-28-pending", { status: "awaiting-review" });
    const { transport } = scriptedTransport([]);
    const result = await runPlanExecutorTick({
      dataDir: sandbox.dataDir,
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
      transport,
      ctx: fakeDaemonCtx(),
    });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.reason).toMatch(/error/);
    // And it's recorded so we don't auto-retry
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("2026-04-28-fail")).toBe(true);
  });

  it("threads each app's brain.repo cwd into the Developer fire (multi-repo)", async () => {
    // Two apps, each with its own brain.repo.rootPath. The transport
    // captures the resolved options so we can assert cwd was threaded.
    const repoA = mkdtempSync(join(tmpdir(), "jarvis-repo-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "jarvis-repo-b-"));
    try {
      // Seed a brain for each app pointing at its own fake repo
      seedBrain(sandbox, "appa", { repo: { rootPath: repoA } });
      seedBrain(sandbox, "appb", {
        repo: { rootPath: repoB, monorepoPath: "packages/web" },
      });
      dropPlan(sandbox, "2026-04-30-a", {
        status: "approved",
        app: "appa",
        implementationReview: "required",
      });
      dropPlan(sandbox, "2026-04-30-b", {
        status: "approved",
        app: "appb",
        implementationReview: "required",
      });

      const { transport, calls } = scriptedTransport([
        VALID_IMPL_PLAN_BLOCK("2026-04-30-a"),
        VALID_IMPL_PLAN_BLOCK("2026-04-30-b"),
      ]);
      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        transport,
        ctx: fakeDaemonCtx(),
      });
      expect(result.fired).toHaveLength(2);
      // Each fire's resolved options carry the cwd derived from that app's brain
      expect(calls.map((c) => c.cwd).sort()).toEqual(
        [repoA, join(repoB, "packages/web")].sort(),
      );
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readFiredPlanIds — refusal vs. terminal outcome semantics
//
// Today's bug: an obsolete `mode: "skipped"` row from a prior version's
// enabledApps filter shadowed an erdei-fahazak plan permanently. The fix
// only locks plans whose latest fired event is a TERMINAL outcome (success,
// errored fire, in-flight claim, not-runnable). Refusals — including
// arbitrary skip reasons and recoverable BLOCKED/RATE_LIMITED gates — let
// the plan re-evaluate on the next tick.
// ---------------------------------------------------------------------------

describe("readFiredPlanIds — refusal-aware filter", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function writeFired(payload: Record<string, unknown>): void {
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      payload["app"] ?? "jarvis",
      "personal",
      "plan-executor-fired",
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  }

  it("locks plans with a successful draft-impl fire", () => {
    writeFired({
      planId: "p-success",
      app: "jarvis",
      mode: "draft-impl",
      durationMs: 1000,
      result: { numTurns: 5 },
    });
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-success")).toBe(true);
  });

  it("locks plans with a successful execute fire", () => {
    writeFired({
      planId: "p-exec",
      app: "jarvis",
      mode: "execute",
      durationMs: 2000,
      result: { done: true, branch: "feat/x", prUrl: "https://x" },
    });
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-exec")).toBe(true);
  });

  it("locks plans with the in-flight 'claimed; result pending' marker", () => {
    writeFired({
      planId: "p-claimed",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-claimed")).toBe(true);
  });

  it("locks plans flagged not-runnable", () => {
    writeFired({
      planId: "p-not-runnable",
      app: "jarvis",
      mode: "not-runnable",
      reason: "type=business, status=approved",
    });
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-not-runnable"),
    ).toBe(true);
  });

  it("does NOT lock plans skipped with an obsolete refusal reason", () => {
    // This is the actual bug from 2026-04-30: the daemon wrote
    // "auto-fire only enabled for jarvis" 2 days ago, then multi-repo
    // landed, but the plan stayed shadowed.
    writeFired({
      planId: "p-stale-refusal",
      app: "erdei-fahazak",
      mode: "skipped",
      reason: "auto-fire only enabled for jarvis",
    });
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-stale-refusal"),
    ).toBe(false);
  });

  it("does NOT lock plans skipped with 'no brain.repo configured'", () => {
    writeFired({
      planId: "p-no-repo",
      app: "newapp",
      mode: "skipped",
      reason: "no brain.repo configured for app \"newapp\"",
    });
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-no-repo"),
    ).toBe(false);
  });

  it("does NOT lock plans whose execute fire returned a BLOCKED:assertCleanMain reason", () => {
    writeFired({
      planId: "p-blocked",
      app: "jarvis",
      mode: "execute",
      reason: "BLOCKED: assertCleanMain: working tree is dirty",
    });
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-blocked"),
    ).toBe(false);
  });

  it("does NOT lock plans whose fire returned a RATE_LIMITED reason", () => {
    writeFired({
      planId: "p-ratelimited",
      app: "jarvis",
      mode: "execute",
      reason: "RATE_LIMITED: five_hour resets at 2026-04-30T12:00:00Z",
    });
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-ratelimited"),
    ).toBe(false);
  });

  it("locks plans whose fire returned a non-recoverable error", () => {
    writeFired({
      planId: "p-errored",
      app: "jarvis",
      mode: "execute",
      reason: "error: Developer execute failed: error_max_turns",
    });
    // Non-BLOCKED, non-RATE_LIMITED errors lock — needs human inspection
    expect(
      readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-errored"),
    ).toBe(true);
  });

  it("locks the plan if ANY of its fired events is terminal", () => {
    // First an obsolete refusal (doesn't lock on its own), then a
    // successful fire (does lock). Set semantics: locked.
    writeFired({
      planId: "p-mixed",
      app: "jarvis",
      mode: "skipped",
      reason: "auto-fire only enabled for jarvis",
    });
    writeFired({
      planId: "p-mixed",
      app: "jarvis",
      mode: "draft-impl",
      durationMs: 500,
      result: { numTurns: 3 },
    });
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-mixed")).toBe(true);
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

  it("amendment-resume fire skips assertCleanMain (dirty tree on a feature branch is expected)", async () => {
    const repo = makeCleanMainRepo();
    try {
      // Set up the repo as it would look during an amendment resume:
      // checked out on a feature branch with uncommitted changes.
      execSync("git checkout -b feat/2026-04-28-resume-test", {
        cwd: repo.dir,
        stdio: "pipe",
      });
      writeFileSync(join(repo.dir, "in-progress.txt"), "wip\n");

      const planId = "2026-04-28-resume-test";
      dropPlan(sandbox, planId, {
        status: "approved",
        implementationReview: "skip",
      });

      // Seed an amendment-proposed event + a checkpoint so isAmendmentResume() returns true.
      const conn = new Database(dbFile(sandbox.dataDir));
      try {
        conn
          .prepare(
            "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "jarvis",
            "personal",
            "amendment-proposed",
            JSON.stringify({ planId }),
            new Date().toISOString(),
          );
      } finally {
        conn.close();
      }
      const checkpointDirPath = join(sandbox.dataDir, "logs", "checkpoints");
      mkdirSync(checkpointDirPath, { recursive: true });
      const checkpointPath = join(checkpointDirPath, `${planId}.json`);
      writeFileSync(
        checkpointPath,
        JSON.stringify({
          planId,
          branch: "feat/2026-04-28-resume-test",
          sha: "abc",
          modifiedFiles: [{ status: "M", path: "x.ts" }],
          amendmentReason: "r",
          amendmentProposal: "p",
          timestamp: new Date().toISOString(),
        }),
      );

      const { transport } = scriptedTransport([
        [
          "DONE",
          "Branch: feat/2026-04-28-resume-test",
          "PR URL: https://github.com/mtari/jarvis/pull/123",
          "Tests: pass",
          "Notes: resumed and finished.",
        ].join("\n"),
      ]);

      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);
      // Did NOT BLOCK on assertCleanMain — actually fired and got DONE
      expect(result.fired[0]?.reason).toBeUndefined();
      const r = result.fired[0]?.result as Record<string, unknown> | undefined;
      expect(r?.["done"]).toBe(true);
      expect(r?.["resume"]).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// findOrphanedClaims + recoverOrphanedClaims + startup sweep integration
// ---------------------------------------------------------------------------

describe("plan-executor orphaned-claim recovery", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function writeFired(payload: Record<string, unknown>): void {
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      payload["app"] ?? "jarvis",
      "personal",
      "plan-executor-fired",
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  }

  it("findOrphanedClaims: claim followed by a result row → 0 orphans", () => {
    writeFired({
      planId: "p-followed",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });
    writeFired({
      planId: "p-followed",
      app: "jarvis",
      mode: "execute",
      durationMs: 1000,
      result: { done: true },
    });
    expect(findOrphanedClaims(dbFile(sandbox.dataDir))).toHaveLength(0);
  });

  it("findOrphanedClaims: claim with no follow-up → 1 orphan", () => {
    writeFired({
      planId: "p-orphan",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });
    const orphans = findOrphanedClaims(dbFile(sandbox.dataDir));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.planId).toBe("p-orphan");
    expect(orphans[0]?.app).toBe("jarvis");
  });

  it("findOrphanedClaims: mixed plans — one followed, one orphaned → 1 orphan", () => {
    // Plan A: claim + result (not orphaned)
    writeFired({
      planId: "p-a",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });
    writeFired({
      planId: "p-a",
      app: "jarvis",
      mode: "draft-impl",
      durationMs: 500,
      result: { numTurns: 3 },
    });
    // Plan B: claim only (orphaned)
    writeFired({
      planId: "p-b",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });
    const orphans = findOrphanedClaims(dbFile(sandbox.dataDir));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.planId).toBe("p-b");
  });

  it("recoverOrphanedClaims: writes claim-recovered event; planId absent from readFiredPlanIds", () => {
    writeFired({
      planId: "p-stuck",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });

    // Before recovery the plan is locked
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-stuck")).toBe(true);

    const logged: string[] = [];
    const logger = {
      ...fakeDaemonCtx().logger,
      info: (msg: string) => { logged.push(msg); },
    };
    recoverOrphanedClaims(dbFile(sandbox.dataDir), logger);

    // Recovery event was appended → plan is no longer locked
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-stuck")).toBe(false);
    // Logger fired once for the recovered orphan
    expect(logged.filter((m) => m.includes("recovered orphaned claim"))).toHaveLength(1);
  });

  it("createPlanExecutorService.start() recovers orphaned claim making planId eligible for re-fire", async () => {
    writeFired({
      planId: "p-refire",
      app: "jarvis",
      mode: "skipped",
      reason: "claimed; result pending",
    });

    // Confirm stuck before start()
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-refire")).toBe(true);

    const service = createPlanExecutorService({
      dataDir: sandbox.dataDir,
      tickMs: 60_000,
      _tickBody: async () => {},
    });

    service.start(fakeDaemonCtx());
    service.stop();

    // After start() the recovery event has been appended synchronously
    expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has("p-refire")).toBe(false);
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

// ---------------------------------------------------------------------------
// done:false handling
// ---------------------------------------------------------------------------

describe("done:false handling", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  it("done=false first time → plan back to approved, event has BLOCKED prefix, plan not locked", async () => {
    const planId = "2026-05-12-done-false-1";
    const repo = makeCleanMainRepo();
    try {
      dropPlan(sandbox, planId, { status: "approved", implementationReview: "skip" });
      const { transport } = scriptedTransport(["Nothing here, no done or blocked."]);

      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);
      expect(result.fired[0]?.mode).toBe("execute");
      expect(result.fired[0]?.reason).toMatch(/^BLOCKED: done=false attempt 1/);

      const plan = findPlan(sandbox.dataDir, planId);
      expect(plan?.plan.metadata.status).toBe("approved");

      // No plan-transition to blocked was written
      const blockedRows = db
        .prepare(
          "SELECT 1 FROM events WHERE kind = 'plan-transition' AND json_extract(payload, '$.to') = 'blocked' AND json_extract(payload, '$.planId') = ?",
        )
        .all(planId) as unknown[];
      expect(blockedRows).toHaveLength(0);

      // Plan NOT in readFiredPlanIds — claim-recovered was written to unlock it
      expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has(planId)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it("done=false three times → blocked after count ≥ 2", async () => {
    const planId = "2026-05-12-done-false-max";
    const repo = makeCleanMainRepo();
    try {
      dropPlan(sandbox, planId, { status: "approved", implementationReview: "skip" });

      // Seed 2 prior BLOCKED:done=false attempts so countDoneFalseAttempts returns 2
      for (let i = 1; i <= 2; i++) {
        db.prepare(
          "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?,?,?,?,?)",
        ).run(
          "jarvis",
          "personal",
          "plan-executor-fired",
          JSON.stringify({
            planId,
            app: "jarvis",
            mode: "execute",
            reason: `BLOCKED: done=false attempt ${i} — queued for resume`,
          }),
          new Date().toISOString(),
        );
      }

      const { transport } = scriptedTransport(["Nothing here, no done or blocked."]);

      const result = await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        transport,
        ctx: fakeDaemonCtx(),
        repoRoot: repo.dir,
      });

      expect(result.fired).toHaveLength(1);

      // Plan is now permanently blocked
      const plan = findPlan(sandbox.dataDir, planId);
      expect(plan?.plan.metadata.status).toBe("blocked");

      // plan-transition to blocked exists
      const blockedRows = db
        .prepare(
          "SELECT 1 FROM events WHERE kind = 'plan-transition' AND json_extract(payload, '$.to') = 'blocked' AND json_extract(payload, '$.planId') = ?",
        )
        .all(planId) as unknown[];
      expect(blockedRows.length).toBeGreaterThan(0);

      // Plan IS in readFiredPlanIds — terminal event without BLOCKED prefix was written
      expect(readFiredPlanIds(dbFile(sandbox.dataDir)).has(planId)).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// findOrphanedClaims regression — BLOCKED event after claim
// ---------------------------------------------------------------------------

describe("findOrphanedClaims regression — BLOCKED event after claim", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function writeFired(payload: Record<string, unknown>): void {
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      payload["app"] ?? "jarvis",
      "personal",
      "plan-executor-fired",
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  }

  it("claim followed by non-final BLOCKED execute → findOrphanedClaims returns the planId (954→955 regression)", () => {
    // Before the fix, the BLOCKED execute event (non-final) matched the NOT
    // EXISTS sub-query and masked the orphan — findOrphanedClaims returned
    // length 0. After the fix the inline final-event predicate excludes BLOCKED
    // rows, so the claim is correctly identified as orphaned.
    const planId = "p-954-955-regression";
    writeFired({ planId, app: "jarvis", mode: "skipped", reason: "claimed; result pending" });
    writeFired({ planId, app: "jarvis", mode: "execute", reason: "BLOCKED: assertCleanMain: working tree is dirty" });

    const orphans = findOrphanedClaims(dbFile(sandbox.dataDir));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.planId).toBe(planId);
  });
});

// ---------------------------------------------------------------------------
// findStaleExecuting boundary
// ---------------------------------------------------------------------------

describe("findStaleExecuting boundary", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function seedTransition(planId: string, to: string, createdAt: string): void {
    appendEvent(db, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "plan-transition",
      payload: { planId, from: "approved", to, actor: "plan-executor" },
      createdAt,
    });
  }

  it("last event 31 min ago → returned as stale", () => {
    const nowMs = Date.now();
    seedTransition("p-stale-31", "executing", new Date(nowMs - 31 * 60_000).toISOString());
    const stale = findStaleExecuting(dbFile(sandbox.dataDir), nowMs);
    expect(stale.map((s) => s.planId)).toContain("p-stale-31");
  });

  it("last event 29 min ago → not returned (below threshold)", () => {
    const nowMs = Date.now();
    seedTransition("p-fresh-29", "executing", new Date(nowMs - 29 * 60_000).toISOString());
    const stale = findStaleExecuting(dbFile(sandbox.dataDir), nowMs);
    expect(stale.map((s) => s.planId)).not.toContain("p-fresh-29");
  });

  it("exactly 30 min ago → not returned (exclusive boundary: lastEventAt < cutoff, not ≤)", () => {
    const nowMs = Date.now();
    seedTransition("p-exact-30", "executing", new Date(nowMs - 30 * 60_000).toISOString());
    const stale = findStaleExecuting(dbFile(sandbox.dataDir), nowMs);
    expect(stale.map((s) => s.planId)).not.toContain("p-exact-30");
  });

  it("later plan-transition away from executing → not returned", () => {
    const nowMs = Date.now();
    seedTransition("p-completed", "executing", new Date(nowMs - 60 * 60_000).toISOString());
    seedTransition("p-completed", "done", new Date(nowMs - 10 * 60_000).toISOString());
    const stale = findStaleExecuting(dbFile(sandbox.dataDir), nowMs);
    expect(stale.map((s) => s.planId)).not.toContain("p-completed");
  });
});

// ---------------------------------------------------------------------------
// recoverStaleExecuting — recovery cap
// ---------------------------------------------------------------------------

describe("recoverStaleExecuting — recovery cap", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  function seedStaleExecutingPlan(planId: string, app = "jarvis"): void {
    dropPlan(sandbox, planId, { status: "executing", app });
    appendEvent(db, {
      appId: app,
      vaultId: "personal",
      kind: "plan-transition",
      payload: { planId, from: "approved", to: "executing", actor: "test" },
      createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    });
  }

  function writeFiredRow(payload: Record<string, unknown>, createdAt?: string): void {
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      payload["app"] ?? "jarvis",
      "personal",
      "plan-executor-fired",
      JSON.stringify(payload),
      createdAt ?? new Date().toISOString(),
    );
  }

  it("under threshold: 2 claim-recovered events, no agent-call → emits claim-recovered, plan stays approved", () => {
    const planId = "2026-05-12-cap-under-2";
    seedStaleExecutingPlan(planId);
    for (let i = 0; i < 2; i++) {
      writeFiredRow({ planId, app: "jarvis", mode: "claim-recovered", reason: `prior recovery ${i + 1}` });
    }

    recoverStaleExecuting(dbFile(sandbox.dataDir), fakeDaemonCtx().logger);

    const claimed = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'claim-recovered' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(claimed.cnt).toBe(3);

    expect(findPlan(sandbox.dataDir, planId)?.plan.metadata.status).toBe("approved");

    const exhausted = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'recovery-exhausted' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(exhausted.cnt).toBe(0);
  });

  it("at threshold: 3 claim-recovered in 24h, no agent-call → plan blocked, recovery-exhausted emitted, zero further claim-recovered", () => {
    const planId = "2026-05-12-cap-at-3";
    seedStaleExecutingPlan(planId);
    for (let i = 0; i < 3; i++) {
      writeFiredRow({ planId, app: "jarvis", mode: "claim-recovered", reason: `prior recovery ${i + 1}` });
    }

    recoverStaleExecuting(dbFile(sandbox.dataDir), fakeDaemonCtx().logger);

    expect(findPlan(sandbox.dataDir, planId)?.plan.metadata.status).toBe("blocked");

    const exhausted = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'recovery-exhausted' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(exhausted.cnt).toBe(1);

    const claimed = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'claim-recovered' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(claimed.cnt).toBe(3);
  });

  it("intervening agent-call resets counter: 3 + agent-call + 2 more recoveries → count is 2, still recoverable", () => {
    const planId = "2026-05-12-cap-agent-call-reset";
    seedStaleExecutingPlan(planId);

    const nowMs = Date.now();
    const windowCutoffIso = new Date(nowMs - 24 * 3600_000).toISOString();
    const beforeAgentCallTs = new Date(nowMs - 2 * 3600_000).toISOString();
    const agentCallTs = new Date(nowMs - 1 * 3600_000).toISOString();

    // 3 recoveries before the agent-call
    for (let i = 0; i < 3; i++) {
      writeFiredRow({ planId, app: "jarvis", mode: "claim-recovered", reason: `old ${i + 1}` }, beforeAgentCallTs);
    }
    // agent-call resets the counter
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("jarvis", "personal", "agent-call", JSON.stringify({ planId, mode: "execute" }), agentCallTs);
    // 2 new recoveries after the agent-call
    for (let i = 0; i < 2; i++) {
      writeFiredRow({ planId, app: "jarvis", mode: "claim-recovered", reason: `new ${i + 1}` });
    }

    expect(countRecoveriesSinceLastAgentCall(db, planId, windowCutoffIso)).toBe(2);

    recoverStaleExecuting(dbFile(sandbox.dataDir), fakeDaemonCtx().logger);

    expect(findPlan(sandbox.dataDir, planId)?.plan.metadata.status).toBe("approved");
    const claimed = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'claim-recovered' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(claimed.cnt).toBe(6); // 3 old + 2 new + 1 from this recovery
  });

  it("regression: 5 successive stale-executing ticks → exactly 3 claim-recovered, then blocked, then zero more", () => {
    const planId = "2026-05-12-cap-regression-5ticks";
    const app = "regression-no-repo";
    const baseMs = Date.now();
    const logger = fakeDaemonCtx().logger;
    // Executing transitions are seeded 1h before baseMs — they appear stale at
    // nowMs = baseMs + N*3600_000 (cutoff = baseMs + N*3600_000 - 30min > baseMs - 1h).
    // The approved transitions written by recovery at real-time ≈ baseMs also appear
    // stale on subsequent ticks since baseMs < baseMs + N*3600_000 - 30min for N >= 1.
    const execTs = new Date(baseMs - 3600_000).toISOString();

    function seedExecutingForTick(): void {
      dropPlan(sandbox, planId, { status: "executing", app });
      db.prepare(
        "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(app, "personal", "plan-transition",
        JSON.stringify({ planId, from: "approved", to: "executing", actor: "test" }),
        execTs);
    }

    // Ticks 1–3: each recovery increments claim-recovered count, stays under cap
    for (let tick = 1; tick <= 3; tick++) {
      seedExecutingForTick();
      recoverStaleExecuting(dbFile(sandbox.dataDir), logger, baseMs + tick * 3600_000);
    }

    const claimedAfter3 = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'claim-recovered' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(claimedAfter3.cnt).toBe(3);

    // Tick 4: count == 3 → exhausted → plan blocked
    seedExecutingForTick();
    recoverStaleExecuting(dbFile(sandbox.dataDir), logger, baseMs + 4 * 3600_000);

    expect(findPlan(sandbox.dataDir, planId)?.plan.metadata.status).toBe("blocked");

    const exhausted = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'recovery-exhausted' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(exhausted.cnt).toBe(1);

    // Tick 5: latest plan-transition is now to=blocked (written by applyPlanTransition
    // on tick 4), so findStaleExecuting does not return the plan — no-op.
    recoverStaleExecuting(dbFile(sandbox.dataDir), logger, baseMs + 5 * 3600_000);

    const finalClaimed = db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE kind = 'plan-executor-fired' AND json_extract(payload, '$.mode') = 'claim-recovered' AND json_extract(payload, '$.planId') = ?",
    ).get(planId) as { cnt: number };
    expect(finalClaimed.cnt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end recovery — all three patterns in one tick
// ---------------------------------------------------------------------------

describe("end-to-end recovery — all three patterns in one tick", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let db: Database.Database;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    db = new Database(dbFile(sandbox.dataDir));
  });

  afterEach(() => {
    db.close();
    silencer.restore();
    sandbox.cleanup();
  });

  it("orphaned claim, stale executing, and done:false are all unlocked after one tick", async () => {
    // Plans A and B use apps with no brain.repo. After recovery transitions
    // them back to approved, the tick skips them with a non-terminal refusal
    // ("no brain.repo configured"), keeping them absent from the locked set.
    // Plan C uses the "jarvis" app backed by a brain that points at a real
    // clean repo — it is the only plan that actually fires.

    // Plan A: orphaned claim masked by a non-final BLOCKED follow event
    // (the 954→955 pattern).
    const planA = "2026-05-12-e2e-plan-a";
    dropPlan(sandbox, planA, { status: "executing", app: "app-no-repo-a", implementationReview: "skip" });
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?,?,?,?,?)",
    ).run("app-no-repo-a", "personal", "plan-executor-fired",
      JSON.stringify({ planId: planA, app: "app-no-repo-a", mode: "skipped", reason: "claimed; result pending" }),
      new Date().toISOString());
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?,?,?,?,?)",
    ).run("app-no-repo-a", "personal", "plan-executor-fired",
      JSON.stringify({ planId: planA, app: "app-no-repo-a", mode: "execute", reason: "BLOCKED: assertCleanMain: dirty" }),
      new Date().toISOString());

    // Plan B: stale — plan file in executing, last activity 31 min ago.
    const planB = "2026-05-12-e2e-plan-b";
    dropPlan(sandbox, planB, { status: "executing", app: "app-no-repo-b", implementationReview: "skip" });
    const staleTs = new Date(Date.now() - 31 * 60_000).toISOString();
    db.prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?,?,?,?,?)",
    ).run("app-no-repo-b", "personal", "plan-executor-fired",
      JSON.stringify({ planId: planB, app: "app-no-repo-b", mode: "skipped", reason: "claimed; result pending" }),
      staleTs);
    appendEvent(db, {
      appId: "app-no-repo-b",
      vaultId: "personal",
      kind: "plan-transition",
      payload: { planId: planB, from: "approved", to: "executing", actor: "plan-executor" },
      createdAt: staleTs,
    });

    // Plan C: done:false — fired by the tick via brain-based cwd resolution.
    // We seed a brain for "jarvis" that points at a clean fixture repo.
    const planC = "2026-05-12-e2e-plan-c";
    dropPlan(sandbox, planC, { status: "approved", implementationReview: "skip" });

    const { transport } = scriptedTransport(["Nothing here, no done or blocked."]);
    const repo = makeCleanMainRepo();
    try {
      // Seed a brain for jarvis so resolveAppCwd returns repo.dir for Plan C.
      seedBrain(sandbox, "jarvis", { repo: { rootPath: repo.dir } });

      await runPlanExecutorTick({
        dataDir: sandbox.dataDir,
        transport,
        ctx: fakeDaemonCtx(),
        // No repoRoot override — Plans A and B use brain lookup which returns
        // null (no brain), so they are skipped rather than fired.
      });

      const locked = readFiredPlanIds(dbFile(sandbox.dataDir));
      expect(locked.has(planA)).toBe(false);
      expect(locked.has(planB)).toBe(false);
      expect(locked.has(planC)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});
