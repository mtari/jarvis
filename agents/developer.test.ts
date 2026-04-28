import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { dbFile, planDir } from "../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  draftImplementationPlan,
  DeveloperError,
  executePlan,
} from "./developer.ts";
import { parsePlan } from "../orchestrator/plan.ts";
import { findPlan } from "../orchestrator/plan-store.ts";

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
- cli/commands/status.ts: new file with the formatter.

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
N/A — inherits from parent.

## Observation window
N/A — inherits from parent.

## Connections required
- None: present

## Rollback
See parent.

## Estimated effort
- Claude calls: ~5
- Your review time: 10 min
- Wall-clock to ship: 2 hours

## Amendment clauses
Pause and amend if scope expands.
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

function scriptedTransport(results: RunAgentResult[]): ScriptedTransport {
  const calls: RunAgentResolvedOptions[] = [];
  let i = 0;
  const transport: RunAgentTransport = async (resolved) => {
    calls.push(resolved);
    if (i >= results.length) {
      throw new Error("Scripted transport ran out of results");
    }
    return results[i++]!;
  };
  return { calls, transport };
}

describe("draftImplementationPlan", () => {
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

  it("drafts an implementation plan when the parent is approved", async () => {
    const parentId = "2026-04-27-add-status";
    dropPlan(sandbox, parentId, { status: "approved" });

    const { transport } = scriptedTransport([
      fixedRunResult(VALID_IMPL_PLAN_BLOCK(parentId)),
    ]);

    const result = await draftImplementationPlan({
      transport,
      parentPlanId: parentId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    expect(result.planId).toBe(`${parentId}-impl`);
    expect(fs.existsSync(result.planPath)).toBe(true);
    const reread = parsePlan(fs.readFileSync(result.planPath, "utf8"));
    expect(reread.metadata.type).toBe("implementation");
    expect(reread.metadata.parentPlan).toBe(parentId);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT * FROM events WHERE kind = 'plan-drafted' ORDER BY id",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId: result.planId,
        parentPlanId: parentId,
        author: "developer",
      });
    } finally {
      db.close();
    }
  });

  it("rejects when the parent plan is not approved", async () => {
    const parentId = "2026-04-27-pending";
    dropPlan(sandbox, parentId, { status: "draft" });
    const { transport } = scriptedTransport([
      fixedRunResult(VALID_IMPL_PLAN_BLOCK(parentId)),
    ]);
    await expect(
      draftImplementationPlan({
        transport,
        parentPlanId: parentId,
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(DeveloperError);
  });

  it("rejects when no <plan> block is in the final response", async () => {
    const parentId = "2026-04-27-bad-output";
    dropPlan(sandbox, parentId, { status: "approved" });
    const { transport } = scriptedTransport([fixedRunResult("just chatter")]);
    await expect(
      draftImplementationPlan({
        transport,
        parentPlanId: parentId,
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(DeveloperError);
  });

  it("rejects when the implementation plan's ParentPlan doesn't match", async () => {
    const parentId = "2026-04-27-mismatch";
    dropPlan(sandbox, parentId, { status: "approved" });
    const wrongParent = "2099-01-01-other";
    const { transport } = scriptedTransport([
      fixedRunResult(VALID_IMPL_PLAN_BLOCK(wrongParent)),
    ]);
    await expect(
      draftImplementationPlan({
        transport,
        parentPlanId: parentId,
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/ParentPlan must equal/);
  });

  it("rejects when an implementation plan already exists at the target path", async () => {
    const parentId = "2026-04-27-already";
    dropPlan(sandbox, parentId, { status: "approved" });
    const planFolder = planDir(sandbox.dataDir, "personal", "jarvis");
    fs.writeFileSync(
      path.join(planFolder, `${parentId}-impl.md`),
      "preexisting",
    );
    const { transport } = scriptedTransport([
      fixedRunResult(VALID_IMPL_PLAN_BLOCK(parentId)),
    ]);
    await expect(
      draftImplementationPlan({
        transport,
        parentPlanId: parentId,
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("executePlan", () => {
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

  it("transitions approved → executing → done on a DONE final response", async () => {
    const planId = "2026-04-27-execute";
    dropPlan(sandbox, planId, { status: "approved" });

    const { transport } = scriptedTransport([
      fixedRunResult(
        [
          "DONE",
          "Branch: feat/2026-04-27-execute",
          "PR URL: https://github.com/mtari/jarvis/pull/42",
          "Tests: pass",
          "Notes: All green.",
        ].join("\n"),
      ),
    ]);

    const result = await executePlan({
      transport,
      planId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    expect(result.done).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.branch).toBe("feat/2026-04-27-execute");
    expect(result.prUrl).toBe("https://github.com/mtari/jarvis/pull/42");

    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("done");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const transitions = db
        .prepare(
          "SELECT * FROM events WHERE kind = 'plan-transition' ORDER BY id",
        )
        .all() as Array<{ payload: string }>;
      const states = transitions.map(
        (e) => (JSON.parse(e.payload) as { to: string }).to,
      );
      expect(states).toEqual(["executing", "done"]);
    } finally {
      db.close();
    }
  });

  it("transitions to blocked on a BLOCKED final response", async () => {
    const planId = "2026-04-27-blocked";
    dropPlan(sandbox, planId, { status: "approved" });
    const { transport } = scriptedTransport([
      fixedRunResult(
        [
          "BLOCKED: tests fail after 3 attempts",
          "Branch: feat/2026-04-27-blocked",
          "Tests: fail",
          "Notes: cli/commands/status.ts shape mismatches an upstream type.",
        ].join("\n"),
      ),
    ]);
    const result = await executePlan({
      transport,
      planId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });
    expect(result.blocked).toBe(true);
    expect(result.done).toBe(false);
    expect(result.prUrl).toBeUndefined();

    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("blocked");
  });

  it("rejects when the plan is not in approved state", async () => {
    const planId = "2026-04-27-not-ready";
    dropPlan(sandbox, planId, { status: "draft" });
    const { transport } = scriptedTransport([fixedRunResult("DONE")]);
    await expect(
      executePlan({
        transport,
        planId,
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(DeveloperError);
  });

  it("rejects when the plan is not found", async () => {
    const { transport } = scriptedTransport([fixedRunResult("DONE")]);
    await expect(
      executePlan({
        transport,
        planId: "missing",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(DeveloperError);
  });

  it("ignores 'PR URL: not-opened-because-...' as no real URL", async () => {
    const planId = "2026-04-27-no-pr";
    dropPlan(sandbox, planId, { status: "approved" });
    const { transport } = scriptedTransport([
      fixedRunResult(
        [
          "DONE",
          "Branch: feat/2026-04-27-no-pr",
          "PR URL: not-opened-because-no-changes-needed",
          "Tests: pass",
        ].join("\n"),
      ),
    ]);
    const result = await executePlan({
      transport,
      planId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });
    expect(result.done).toBe(true);
    expect(result.prUrl).toBeUndefined();
  });

  it("mirrors done onto the parent improvement plan when impl finishes", async () => {
    const parentId = "2026-04-27-mirror-parent";
    const implId = `${parentId}-impl`;
    dropPlan(sandbox, parentId, { status: "executing" });
    dropPlan(sandbox, implId, {
      type: "implementation",
      parentPlan: parentId,
      status: "approved",
    });
    const { transport } = scriptedTransport([
      fixedRunResult("DONE\nBranch: feat/x\nPR URL: https://x\nTests: pass"),
    ]);
    await executePlan({
      transport,
      planId: implId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    const impl = findPlan(sandbox.dataDir, implId);
    const parent = findPlan(sandbox.dataDir, parentId);
    expect(impl?.plan.metadata.status).toBe("done");
    expect(parent?.plan.metadata.status).toBe("done");
  });

  it("mirrors blocked onto the parent improvement plan when impl is blocked", async () => {
    const parentId = "2026-04-27-mirror-blocked-parent";
    const implId = `${parentId}-impl`;
    dropPlan(sandbox, parentId, { status: "executing" });
    dropPlan(sandbox, implId, {
      type: "implementation",
      parentPlan: parentId,
      status: "approved",
    });
    const { transport } = scriptedTransport([
      fixedRunResult("BLOCKED: tests fail\nBranch: none\nTests: fail"),
    ]);
    await executePlan({
      transport,
      planId: implId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    const parent = findPlan(sandbox.dataDir, parentId);
    expect(parent?.plan.metadata.status).toBe("blocked");
  });

  it("does not touch parent when parent is not in 'executing'", async () => {
    const parentId = "2026-04-27-no-mirror";
    const implId = `${parentId}-impl`;
    dropPlan(sandbox, parentId, { status: "approved" });
    dropPlan(sandbox, implId, {
      type: "implementation",
      parentPlan: parentId,
      status: "approved",
    });
    const { transport } = scriptedTransport([
      fixedRunResult("DONE\nBranch: x\nPR URL: y\nTests: pass"),
    ]);
    await executePlan({
      transport,
      planId: implId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    const parent = findPlan(sandbox.dataDir, parentId);
    expect(parent?.plan.metadata.status).toBe("approved");
  });
});
