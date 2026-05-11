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
import { findPlan } from "../../orchestrator/plan-store.ts";
import {
  assertCleanMain,
  createPlanExecutorService,
  findOrphanedClaims,
  readFiredPlanIds,
  recoverOrphanedClaims,
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
