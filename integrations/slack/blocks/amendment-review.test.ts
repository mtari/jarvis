import { describe, expect, it } from "vitest";
import { parsePlan } from "../../../orchestrator/plan.ts";
import { buildAmendmentReviewBlocks } from "./amendment-review.ts";

const SAMPLE_PLAN = parsePlan(`# Plan: Tighten checkout funnel
Type: improvement
Subtype: bugfix
ImplementationReview: skip
App: erdei-fahazak
Priority: high
Destructive: false
Status: awaiting-review
Author: developer
Confidence: 70 — partial work on disk

## Problem
Address-step drop-off is high.

## Build plan
Inline-validate the address field.

## Testing strategy
Unit + manual smoke.

## Acceptance criteria
- drop-off rate falls
`);

const FULL_AMENDMENT = {
  eventId: 42,
  reason: "scope expanded — discovered upstream API change",
  proposal:
    "The plan calls for one patch but the lib renamed `fooBar` to `fooBaz`. Patching one callsite leaves twelve broken. Propose: extend the plan to update all twelve, or revert to the prior pinned version.",
  branch: "feat/2026-05-05-checkout",
  sha: "abc12345def67890",
  modifiedFileCount: 4,
} as const;

describe("buildAmendmentReviewBlocks", () => {
  it("emits a header that signals 'Amendment review'", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "2026-04-28-amend",
      plan: SAMPLE_PLAN,
      amendment: FULL_AMENDMENT,
    });
    const header = blocks[0];
    expect(header?.type).toBe("header");
    if (header?.type === "header") {
      expect(header.text.text).toContain("Amendment review");
      expect(header.text.text).toContain("Tighten checkout funnel");
    }
  });

  it("includes branch / sha / modified-file count when the checkpoint payload has them", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "2026-04-28-amend",
      plan: SAMPLE_PLAN,
      amendment: FULL_AMENDMENT,
    });
    const summary = blocks.find((b) => b.type === "section");
    if (!summary || summary.type !== "section") throw new Error("no section");
    const text = "text" in summary && summary.text && "text" in summary.text
      ? summary.text.text
      : "";
    expect(text).toContain("feat/2026-05-05-checkout");
    expect(text).toContain("abc12345"); // sha truncated to 8
    expect(text).toContain("4 modified file(s)");
  });

  it("renders the reason and a quoted proposal", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "x",
      plan: SAMPLE_PLAN,
      amendment: FULL_AMENDMENT,
    });
    const summary = blocks.find((b) => b.type === "section");
    if (!summary || summary.type !== "section") throw new Error("no section");
    const text = "text" in summary && summary.text && "text" in summary.text
      ? summary.text.text
      : "";
    expect(text).toContain("*Why amended*");
    expect(text).toContain("scope expanded");
    expect(text).toContain("*Proposed amendment*");
    expect(text).toContain("> The plan calls for one patch");
  });

  it("emits the same approve / revise / reject action ids as the plan-review surface", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "x",
      plan: SAMPLE_PLAN,
      amendment: FULL_AMENDMENT,
    });
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const ids = actions.elements
      .filter((e): e is Extract<typeof e, { action_id?: string }> =>
        "action_id" in e,
      )
      .map((e) => e["action_id"]);
    expect(ids).toEqual(["plan_approve", "plan_revise", "plan_reject"]);
  });

  it("attaches a confirm dialog to the reject button warning about checkpoint deletion", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "x",
      plan: SAMPLE_PLAN,
      amendment: FULL_AMENDMENT,
    });
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const reject = actions.elements.find(
      (e) =>
        e.type === "button" && "action_id" in e && e.action_id === "plan_reject",
    );
    expect(reject).toBeDefined();
    if (reject && reject.type === "button") {
      expect(reject.confirm).toBeDefined();
      expect(reject.confirm?.text.text).toContain("checkpoint deleted");
    }
  });

  it("works when the checkpoint payload is partial (no branch / sha / file count)", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "x",
      plan: SAMPLE_PLAN,
      amendment: {
        eventId: 1,
        reason: "ad-hoc reason",
        proposal: "ad-hoc proposal",
      },
    });
    const summary = blocks.find((b) => b.type === "section");
    if (!summary || summary.type !== "section") throw new Error("no section");
    const text = "text" in summary && summary.text && "text" in summary.text
      ? summary.text.text
      : "";
    // No branch / sha / "modified file" mentions when the data isn't present
    expect(text).not.toContain("Branch `");
    expect(text).not.toContain("HEAD `");
    expect(text).not.toContain("modified file");
    // Reason + proposal still render
    expect(text).toContain("ad-hoc reason");
    expect(text).toContain("ad-hoc proposal");
  });

  it("truncates a very long proposal", () => {
    const blocks = buildAmendmentReviewBlocks({
      planId: "x",
      plan: SAMPLE_PLAN,
      amendment: {
        ...FULL_AMENDMENT,
        proposal: "x".repeat(3000),
      },
    });
    const summary = blocks.find((b) => b.type === "section");
    if (!summary || summary.type !== "section") throw new Error("no section");
    const text = "text" in summary && summary.text && "text" in summary.text
      ? summary.text.text
      : "";
    expect(text).toContain("…");
    // Slack section text cap is 3000 — we keep margin
    expect(text.length).toBeLessThanOrEqual(2800);
  });

  it("flags Destructive plans on the approve confirm dialog", () => {
    const destructive = parsePlan(`# Plan: Drop X
Type: improvement
Subtype: refactor
ImplementationReview: skip
App: jarvis
Priority: blocking
Destructive: true
Status: awaiting-review
Author: developer
Confidence: 95 — irreversible

## Problem
x

## Build plan
x

## Testing strategy
x

## Acceptance criteria
- ok
`);
    const blocks = buildAmendmentReviewBlocks({
      planId: "y",
      plan: destructive,
      amendment: FULL_AMENDMENT,
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
});
