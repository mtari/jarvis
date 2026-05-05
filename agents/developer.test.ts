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
  appendAmendmentToPlan,
  draftImplementationPlan,
  DeveloperError,
  executePlan,
  parseAmendmentResponse,
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

// ---------------------------------------------------------------------------
// parseAmendmentResponse — pure parser
// ---------------------------------------------------------------------------

describe("parseAmendmentResponse", () => {
  it("parses a well-formed AMEND block", () => {
    const text = [
      "AMEND",
      "Reason: scope expanded — discovered upstream API change",
      "",
      "The plan calls for a one-line patch but the upstream library renamed",
      "`fooBar` to `fooBaz` in the version this repo pins. Patching one",
      "callsite leaves twelve others broken.",
      "",
      "Proposed amendment: extend the plan to update all twelve callsites,",
      "or revert to the prior pinned version.",
    ].join("\n");
    const result = parseAmendmentResponse(text);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe(
      "scope expanded — discovered upstream API change",
    );
    expect(result!.proposal).toContain("twelve others broken");
    expect(result!.proposal).toContain("Proposed amendment");
  });

  it("returns null when no AMEND marker is present", () => {
    expect(parseAmendmentResponse("DONE\nBranch: x\n")).toBeNull();
    expect(
      parseAmendmentResponse("BLOCKED: tests fail\nBranch: x"),
    ).toBeNull();
    expect(parseAmendmentResponse("")).toBeNull();
  });

  it("returns null when AMEND is present but Reason: is missing", () => {
    expect(parseAmendmentResponse("AMEND\n\nproposal here")).toBeNull();
  });

  it("returns null when AMEND has Reason but no proposal body", () => {
    expect(
      parseAmendmentResponse("AMEND\nReason: something\n\n"),
    ).toBeNull();
  });

  it("returns null when something else appears between AMEND and Reason:", () => {
    const text = ["AMEND", "Branch: feat/x", "Reason: r", "", "p"].join("\n");
    expect(parseAmendmentResponse(text)).toBeNull();
  });

  it("trims trailing whitespace from the proposal", () => {
    const text = "AMEND\nReason: r\n\nbody body\n\n\n";
    const result = parseAmendmentResponse(text);
    expect(result?.proposal).toBe("body body");
  });
});

// ---------------------------------------------------------------------------
// appendAmendmentToPlan — plan body mutation
// ---------------------------------------------------------------------------

describe("appendAmendmentToPlan", () => {
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

  it("appends an amendment section to the plan markdown", () => {
    const planId = "amend-test";
    const planPath = dropPlan(sandbox, planId, { status: "executing" });
    const record = findPlan(sandbox.dataDir, planId)!;

    appendAmendmentToPlan(
      record,
      { reason: "scope shift", proposal: "do X instead of Y" },
      new Date("2026-05-05T10:00:00Z"),
    );

    const contents = fs.readFileSync(planPath, "utf8");
    expect(contents).toContain(
      "## Amendment proposal (mid-execution, 2026-05-05)",
    );
    expect(contents).toContain("**Reason:** scope shift");
    expect(contents).toContain("do X instead of Y");
  });

  it("stacks multiple amendments without overwriting previous ones", () => {
    const planId = "stack-test";
    const planPath = dropPlan(sandbox, planId, { status: "executing" });
    const record = findPlan(sandbox.dataDir, planId)!;

    appendAmendmentToPlan(
      record,
      { reason: "first reason", proposal: "first proposal" },
      new Date("2026-05-05T10:00:00Z"),
    );
    const recordReloaded = findPlan(sandbox.dataDir, planId)!;
    appendAmendmentToPlan(
      recordReloaded,
      { reason: "second reason", proposal: "second proposal" },
      new Date("2026-05-06T10:00:00Z"),
    );

    const contents = fs.readFileSync(planPath, "utf8");
    expect(contents).toContain("first reason");
    expect(contents).toContain("first proposal");
    expect(contents).toContain("second reason");
    expect(contents).toContain("second proposal");
    // Two amendment sections
    const matches = contents.match(/## Amendment proposal/g);
    expect(matches).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// executePlan — AMEND integration
// ---------------------------------------------------------------------------

describe("executePlan AMEND integration", () => {
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

  function readEvents(kind: string): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT payload FROM events WHERE kind = ?")
        .all(kind) as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      conn.close();
    }
  }

  it("transitions executing → awaiting-review when SDK returns AMEND", async () => {
    const planId = "2026-04-27-amend";
    dropPlan(sandbox, planId, { status: "approved" });

    const { transport } = scriptedTransport([
      fixedRunResult(
        [
          "AMEND",
          "Reason: rollback condition triggered",
          "",
          "Tests pass but the new behavior contradicts an existing UX rule",
          "the plan didn't mention. Propose: split this plan into two —",
          "one for the data change, one for the UX update.",
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

    expect(result.amended).toBe(true);
    expect(result.done).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.amendmentReason).toBe("rollback condition triggered");
    expect(result.amendmentProposal).toContain("split this plan");

    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("awaiting-review");

    // Plan body has the amendment section
    const planText = fs.readFileSync(finalRecord!.path, "utf8");
    expect(planText).toContain("## Amendment proposal");
    expect(planText).toContain("**Reason:** rollback condition triggered");

    // amendment-proposed event recorded
    const amendments = readEvents("amendment-proposed");
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({
      planId,
      reason: "rollback condition triggered",
      actor: "developer",
    });

    // Transition history: approved -> executing -> awaiting-review
    const transitions = readEvents("plan-transition");
    const sequence = transitions.map((t) => t["to"]);
    expect(sequence).toEqual(["executing", "awaiting-review"]);
  });

  it("amendment takes precedence over BLOCKED + DONE in the same response", async () => {
    const planId = "2026-04-27-precedence";
    dropPlan(sandbox, planId, { status: "approved" });

    const { transport } = scriptedTransport([
      fixedRunResult(
        // The Developer prompt forbids this combination, but defense-in-depth:
        // if both somehow appear, AMEND wins.
        [
          "AMEND",
          "Reason: bad situation",
          "",
          "proposal body",
          "",
          "DONE",
          "BLOCKED: stale state",
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

    expect(result.amended).toBe(true);
    expect(result.done).toBe(false);
    expect(result.blocked).toBe(false);
    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("awaiting-review");
  });

  it("does NOT mirror the parent plan's status when an impl plan amends", async () => {
    const parentId = "2026-04-27-parent-stays";
    dropPlan(sandbox, parentId, { status: "executing" });
    const childId = "2026-04-27-child-amends";
    const childPath = path.join(planDir(sandbox.dataDir, "personal", "jarvis"), `${childId}.md`);
    fs.writeFileSync(
      childPath,
      [
        "# Plan: child impl",
        "Type: implementation",
        `ParentPlan: ${parentId}`,
        "App: jarvis",
        "Priority: normal",
        "Destructive: false",
        "Status: approved",
        "Author: developer",
        "Confidence: 80 — small change",
        "",
        "## Approach",
        "Implement the parent plan.",
      ].join("\n"),
    );

    const { transport } = scriptedTransport([
      fixedRunResult(
        ["AMEND", "Reason: discovered new file", "", "proposal text"].join(
          "\n",
        ),
      ),
    ]);
    await executePlan({
      transport,
      planId: childId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    const child = findPlan(sandbox.dataDir, childId);
    const parent = findPlan(sandbox.dataDir, parentId);
    expect(child?.plan.metadata.status).toBe("awaiting-review");
    // Parent stays at executing — not mirrored
    expect(parent?.plan.metadata.status).toBe("executing");
  });
});
