import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { dbFile, planDir } from "../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import {
  draftMetaPlansFromScan,
  runLearnScan,
  type LearnFinding,
} from "./analyst-learn.ts";

function seedFeedback(
  sandbox: InstallSandbox,
  rows: Array<{
    kind: "approve" | "reject" | "revise";
    targetId: string;
    note?: string;
    actor?: string;
    daysAgo?: number;
  }>,
): void {
  const db = new Database(dbFile(sandbox.dataDir));
  try {
    for (const r of rows) {
      const createdAt = (() => {
        const d = new Date();
        d.setDate(d.getDate() - (r.daysAgo ?? 0));
        return d.toISOString();
      })();
      const input: Parameters<typeof recordFeedback>[1] = {
        kind: r.kind,
        actor: r.actor ?? "user",
        targetType: "plan",
        targetId: r.targetId,
        createdAt,
      };
      if (r.note !== undefined) input.note = r.note;
      recordFeedback(db, input);
    }
  } finally {
    db.close();
  }
}

describe("runLearnScan", () => {
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

  it("returns an empty report when no feedback exists", () => {
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.scannedFeedbackRows).toBe(0);
    expect(r.rejectionThemes).toEqual([]);
    expect(r.reviseThemes).toEqual([]);
    expect(r.lowApprovalRates).toEqual([]);
    expect(r.recommendations).toEqual([]);
  });

  it("clusters rejection themes by recurring tokens", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope too broad" },
      { kind: "reject", targetId: "plan-2", note: "scope is unclear" },
      { kind: "reject", targetId: "plan-3", note: "scope creep — stop" },
      { kind: "reject", targetId: "plan-4", note: "looks fine actually" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    const scope = r.rejectionThemes.find((t) => t.token === "scope");
    expect(scope).toBeDefined();
    expect(scope?.count).toBe(3);
    expect(scope?.examplePlanIds).toEqual(
      expect.arrayContaining(["plan-1", "plan-2", "plan-3"]),
    );
  });

  it("does not cluster tokens below the threshold (3)", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope too broad" },
      { kind: "reject", targetId: "plan-2", note: "scope is unclear" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.rejectionThemes).toEqual([]);
  });

  it("dedupes mentions across the same plan id", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "scope scope scope" },
      { kind: "reject", targetId: "plan-1", note: "scope again" },
      { kind: "reject", targetId: "plan-2", note: "scope is bad" },
      { kind: "reject", targetId: "plan-3", note: "scope creep" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    const scope = r.rejectionThemes.find((t) => t.token === "scope");
    // 3 distinct plan ids ('plan-1', 'plan-2', 'plan-3')
    expect(scope?.count).toBe(3);
  });

  it("revise themes cluster separately from rejection themes", () => {
    seedFeedback(sandbox, [
      { kind: "revise", targetId: "plan-a", note: "rollback section weak" },
      { kind: "revise", targetId: "plan-b", note: "rollback path missing" },
      { kind: "revise", targetId: "plan-c", note: "rollback unclear" },
      { kind: "reject", targetId: "plan-x", note: "totally different reason" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.reviseThemes.find((t) => t.token === "rollback")?.count).toBe(3);
    expect(r.rejectionThemes).toEqual([]);
  });

  it("light stemming clusters inflected forms", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "plan-1", note: "rejecting this approach" },
      { kind: "reject", targetId: "plan-2", note: "rejected — try again" },
      { kind: "reject", targetId: "plan-3", note: "rejects the brief" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    // All three forms collapse to "reject" via stemming.
    const reject = r.rejectionThemes.find((t) => t.token === "reject");
    expect(reject?.count).toBe(3);
  });

  it("respects the `since` window — rows older than since are skipped", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "old-1", note: "scope problem", daysAgo: 60 },
      { kind: "reject", targetId: "old-2", note: "scope creep", daysAgo: 60 },
      { kind: "reject", targetId: "old-3", note: "scope wrong", daysAgo: 60 },
      { kind: "reject", targetId: "new-1", note: "scope too broad" },
    ]);
    const since = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    })();
    const r = runLearnScan({ dataDir: sandbox.dataDir, since });
    expect(r.scannedFeedbackRows).toBe(1);
    expect(r.rejectionThemes).toEqual([]); // only 1 in window, below threshold
  });

  it("low-approval rates surface plan-type / subtype with <50% approval over >=3 samples", () => {
    // Drop the actual plans on disk so listPlans finds them
    dropPlan(sandbox, "low-1", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-2", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-3", { type: "improvement", subtype: "new-feature" });
    dropPlan(sandbox, "low-4", { type: "improvement", subtype: "new-feature" });
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "low-1" },
      { kind: "reject", targetId: "low-2" },
      { kind: "reject", targetId: "low-3" },
      { kind: "approve", targetId: "low-4" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.lowApprovalRates).toHaveLength(1);
    expect(r.lowApprovalRates[0]).toMatchObject({
      type: "improvement",
      subtype: "new-feature",
      approved: 1,
      total: 4,
    });
    expect(r.lowApprovalRates[0]?.rate).toBeLessThan(0.5);
  });

  it("doesn't surface low-approval when sample size is under 3", () => {
    dropPlan(sandbox, "small-1", { type: "improvement", subtype: "rework" });
    seedFeedback(sandbox, [{ kind: "reject", targetId: "small-1" }]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.lowApprovalRates).toEqual([]);
  });

  it("emits recommendations for the top 3 rejection / revise / low-approval signals", () => {
    seedFeedback(sandbox, [
      { kind: "reject", targetId: "p-1", note: "scope too broad" },
      { kind: "reject", targetId: "p-2", note: "scope unclear" },
      { kind: "reject", targetId: "p-3", note: "scope creep" },
      { kind: "revise", targetId: "p-4", note: "rollback section weak" },
      { kind: "revise", targetId: "p-5", note: "rollback missing" },
      { kind: "revise", targetId: "p-6", note: "rollback unclear" },
    ]);
    const r = runLearnScan({ dataDir: sandbox.dataDir });
    expect(r.recommendations.some((rec) => rec.includes("scope"))).toBe(true);
    expect(r.recommendations.some((rec) => rec.includes("rollback"))).toBe(
      true,
    );
  });

  it("records a learn-scan-completed event", () => {
    runLearnScan({ dataDir: sandbox.dataDir });
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'learn-scan-completed'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload);
      expect(payload).toMatchObject({
        scannedFeedbackRows: 0,
        rejectionThemes: 0,
      });
    } finally {
      db.close();
    }
  });
});

// ===========================================================================
// draftMetaPlansFromScan
// ===========================================================================

const VALID_META_PLAN_RESPONSE = `<plan>
# Plan: Add scope-tightening rule to Strategist
Type: improvement
Subtype: meta
ImplementationReview: skip
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — 5 plans rejected with "scope" theme

## Problem
Five recent plans were rejected with notes mentioning "scope" — Strategist's draft is too broad.

## Build plan
- Edit \`prompts/strategist-improvement.md\` to add a scope-tightening guardrail.

## Testing strategy
Re-run a synthetic plan request that previously triggered the pattern.

## Acceptance criteria
- Subsequent plans show clearer scope boundaries.

## Success metric
- Metric: rejection-theme "scope" occurrences per N drafts
- Baseline: 5 in last 30d
- Target: < 2 in next 30d
- Data source: \`yarn jarvis learn scan\`

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert the prompt change via git.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause and amend if "scope" theme grows after the prompt change ships.
</plan>`;

function fakeClient(text: string): AnthropicClient {
  return {
    async chat() {
      const r: ChatResponse = {
        text,
        blocks: [{ type: "text", text }],
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

describe("draftMetaPlansFromScan", () => {
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

  function seedRejectionTheme(
    sandboxArg: InstallSandbox,
    token: string,
    count: number,
  ): void {
    // Note is crafted to produce exactly ONE theme above threshold: only
    // the `token` itself is long-enough + non-stop-word. "the" / "is" /
    // "bad" are stop-words or under the 4-char minimum.
    const db = new Database(dbFile(sandboxArg.dataDir));
    try {
      for (let i = 0; i < count; i += 1) {
        recordFeedback(db, {
          kind: "reject",
          actor: "user",
          targetType: "plan",
          targetId: `p-${token}-${i}`,
          note: `the ${token} is bad`,
        });
      }
    } finally {
      db.close();
    }
  }

  it("drafts a meta plan when a finding is above threshold", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    expect(result.drafted).toHaveLength(1);
    expect(result.drafted[0]?.planId).toMatch(/scope-tightening/);

    // Plan file written under jarvis/plans
    const folder = planDir(sandbox.dataDir, "personal", "jarvis");
    expect(fs.existsSync(folder)).toBe(true);
    const files = fs.readdirSync(folder).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const planText = fs.readFileSync(path.join(folder, files[0]!), "utf8");
    expect(planText).toContain("Subtype: meta");
    expect(planText).toContain("Status: awaiting-review");

    // learn-meta-drafted event recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'learn-meta-drafted'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        findingKey: "rejection-theme:scope",
      });
    } finally {
      db.close();
    }
  });

  it("does NOT draft when count is below threshold", async () => {
    seedRejectionTheme(sandbox, "scope", 4);
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    expect(result.drafted).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("is idempotent — second call with same finding skips (within 14d)", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    const first = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    expect(first.drafted).toHaveLength(1);

    const second = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    expect(second.drafted).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.reason).toContain("already drafted");
  });

  it("skips findings when Strategist returns clarify (signal too thin)", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(
        "<clarify>\nFinding too thin to act on confidently.\n</clarify>",
      ),
      threshold: 5,
    });
    expect(result.drafted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("clarification");
  });

  it("surfaces parse errors per-finding without aborting the rest", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    seedRejectionTheme(sandbox, "rollback", 5);
    let calls = 0;
    const client: AnthropicClient = {
      async chat() {
        calls += 1;
        const text =
          calls === 1 ? "garbage no plan tags here" : VALID_META_PLAN_RESPONSE;
        return {
          text,
          blocks: [{ type: "text", text }],
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
      },
    };
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client,
      threshold: 5,
    });
    expect(result.drafted.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("respects maxDrafts", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    seedRejectionTheme(sandbox, "rollback", 5);
    seedRejectionTheme(sandbox, "metric", 5);
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
      maxDrafts: 2,
    });
    expect(result.drafted.length + result.errors.length).toBeLessThanOrEqual(2);
  });

  it("rejects plans that aren't improvement/meta", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    // Same plan body but with the wrong subtype
    const badResponse = VALID_META_PLAN_RESPONSE.replace(
      "Subtype: meta",
      "Subtype: new-feature",
    ).replace("ImplementationReview: skip", "ImplementationReview: required");
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(badResponse),
      threshold: 5,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain("improvement/meta");
  });

  it("treats existing learn-meta-drafted events older than 14d as expired (re-drafts)", async () => {
    seedRejectionTheme(sandbox, "scope", 5);
    // Pre-seed an old learn-meta-drafted event
    const long_ago = new Date();
    long_ago.setDate(long_ago.getDate() - 30);
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "learn-meta-drafted",
        payload: {
          planId: "old-plan",
          findingKind: "rejection-theme",
          findingKey: "rejection-theme:scope",
        },
        createdAt: long_ago.toISOString(),
      });
    } finally {
      db.close();
    }
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    // Old event is past the 14-day window, so we re-draft.
    expect(result.drafted).toHaveLength(1);
  });

  it("low-approval finding is included when total >= threshold", async () => {
    // Pre-seed: 5 plans of improvement/new-feature, all rejected.
    for (let i = 0; i < 5; i += 1) {
      dropPlan(sandbox, `low-${i}`, {
        type: "improvement",
        subtype: "new-feature",
      });
    }
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      for (let i = 0; i < 5; i += 1) {
        recordFeedback(db, {
          kind: "reject",
          actor: "user",
          targetType: "plan",
          targetId: `low-${i}`,
        });
      }
    } finally {
      db.close();
    }
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    // The low-approval finding above threshold should be included.
    expect(result.drafted.length).toBeGreaterThanOrEqual(1);
  });

  it("no-op when scan has no findings above threshold", async () => {
    const result = await draftMetaPlansFromScan({
      dataDir: sandbox.dataDir,
      client: fakeClient(VALID_META_PLAN_RESPONSE),
      threshold: 5,
    });
    expect(result.drafted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("LearnFinding type smoke (every kind constructible)", () => {
    const samples: LearnFinding[] = [
      {
        kind: "rejection-theme",
        token: "scope",
        count: 5,
        examplePlanIds: ["p1"],
      },
      {
        kind: "revise-theme",
        token: "rollback",
        count: 5,
        examplePlanIds: ["p1"],
      },
      {
        kind: "low-approval",
        type: "improvement",
        subtype: "new-feature",
        total: 5,
        approved: 1,
        rate: 0.2,
      },
    ];
    expect(samples).toHaveLength(3);
  });
});
