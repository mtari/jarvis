import { describe, expect, it } from "vitest";
import { parsePlan } from "../../../orchestrator/plan.ts";
import {
  buildPlanReviewBlocks,
  buildReviseModal,
  buildOutcomeContext,
} from "./plan-review.ts";

const SAMPLE_PLAN = parsePlan(`# Plan: Add status command
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: jarvis
Priority: high
Destructive: false
Status: awaiting-review
Author: strategist
Confidence: 80 — solid grounding

## Problem
Need a quick health summary on the CLI surface.

## Build plan
Add a status command to dispatch.

## Testing strategy
Unit + manual.

## Acceptance criteria
- prints the snapshot
`);

describe("buildPlanReviewBlocks", () => {
  it("includes header, summary, and three action buttons", () => {
    const blocks = buildPlanReviewBlocks({
      planId: "2026-04-28-test",
      plan: SAMPLE_PLAN,
      path: "/tmp/test.md",
    });
    expect(blocks.find((b) => b.type === "header")).toBeDefined();
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    if (actions && actions.type === "actions") {
      const ids = actions.elements
        .filter((e): e is Extract<typeof e, { action_id?: string }> =>
          "action_id" in e,
        )
        .map((e) => e["action_id"]);
      expect(ids).toEqual(["plan_approve", "plan_revise", "plan_reject"]);
    }
  });

  it("attaches a Slack confirm dialog to the approve button on destructive plans", () => {
    const destructive = parsePlan(
      SAMPLE_PLAN.sections.length > 0
        ? `# Plan: Drop production users table
Type: improvement
Subtype: refactor
ImplementationReview: skip
App: jarvis
Priority: blocking
Destructive: true
Status: awaiting-review
Author: strategist
Confidence: 95 — irreversible

## Problem
Dummy.

## Build plan
Dummy.

## Testing strategy
Dummy.

## Acceptance criteria
- ok
`
        : "",
    );
    const blocks = buildPlanReviewBlocks({
      planId: "2026-04-28-d",
      plan: destructive,
    });
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const approve = actions.elements.find(
      (e) => e.type === "button" && "action_id" in e && e.action_id === "plan_approve",
    );
    expect(approve).toBeDefined();
    if (approve && approve.type === "button") {
      expect(approve.confirm).toBeDefined();
      expect(approve.confirm?.style).toBe("danger");
    }
  });

  it("includes a fallback `text` for clients that don't render Block Kit (handled by caller)", () => {
    // The caller uses `text:` on chat.postMessage; here we just confirm the
    // first block has a header so the message is informative as a notification.
    const blocks = buildPlanReviewBlocks({
      planId: "2026-04-28-h",
      plan: SAMPLE_PLAN,
    });
    const header = blocks[0];
    expect(header?.type).toBe("header");
    if (header?.type === "header") {
      expect(header.text.text).toContain("Add status command");
    }
  });
});

describe("buildReviseModal", () => {
  it("returns a modal with the plan id stored in private_metadata", () => {
    const modal = buildReviseModal("2026-04-28-x");
    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe("plan_revise_submit");
    expect(modal.private_metadata).toBe("2026-04-28-x");
  });
});

describe("buildOutcomeContext", () => {
  it("renders an mrkdwn context block", () => {
    const block = buildOutcomeContext("✓ Approved by <@U123>");
    expect(block.type).toBe("context");
    if (block.type === "context") {
      const first = block.elements[0];
      expect(first?.type).toBe("mrkdwn");
    }
  });
});
