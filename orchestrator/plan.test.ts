import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransition,
  InvalidTransitionError,
  parsePlan,
  serializePlan,
  transitionPlan,
} from "./plan.ts";
import type { Plan, PlanStatus } from "./plan.ts";

const VALID_IMPROVEMENT = `# Plan: Add status command
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 75 — based on similar past CLI additions

## Problem
We need a quick health summary on the CLI surface.

## Build plan
Add a \`status\` command to cli/index.ts.

## Testing strategy
Unit test the formatter; manual smoke run.

## Acceptance criteria
- \`yarn jarvis status\` prints the current daemon state.
`;

const VALID_IMPLEMENTATION = `# Plan: Add status command — implementation
Type: implementation
ParentPlan: 2026-04-27-add-status-command
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: developer
Confidence: 80

## Approach
Wire a new subcommand into the existing dispatcher.

## File changes
- cli/index.ts: add status case.

## Testing strategy
Unit + manual smoke.
`;

describe("parsePlan", () => {
  it("parses a valid improvement plan", () => {
    const plan = parsePlan(VALID_IMPROVEMENT);
    expect(plan.metadata.title).toBe("Add status command");
    expect(plan.metadata.type).toBe("improvement");
    expect(plan.metadata.subtype).toBe("new-feature");
    expect(plan.metadata.implementationReview).toBe("required");
    expect(plan.metadata.app).toBe("jarvis");
    expect(plan.metadata.priority).toBe("normal");
    expect(plan.metadata.destructive).toBe(false);
    expect(plan.metadata.status).toBe("draft");
    expect(plan.metadata.author).toBe("strategist");
    expect(plan.metadata.confidence).toEqual({
      score: 75,
      rationale: "based on similar past CLI additions",
    });
    expect(plan.sections.map((s) => s.title)).toEqual([
      "Problem",
      "Build plan",
      "Testing strategy",
      "Acceptance criteria",
    ]);
  });

  it("parses a confidence with no rationale", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Confidence: 75 — based on similar past CLI additions",
      "Confidence: 60",
    );
    const plan = parsePlan(text);
    expect(plan.metadata.confidence).toEqual({ score: 60 });
  });

  it("parses a confidence with hyphen separator", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Confidence: 75 — based on similar past CLI additions",
      "Confidence: 60 - hyphen rationale",
    );
    const plan = parsePlan(text);
    expect(plan.metadata.confidence).toEqual({
      score: 60,
      rationale: "hyphen rationale",
    });
  });

  it("parses an implementation plan with parentPlan", () => {
    const plan = parsePlan(VALID_IMPLEMENTATION);
    expect(plan.metadata.type).toBe("implementation");
    expect(plan.metadata.parentPlan).toBe("2026-04-27-add-status-command");
  });

  it("rejects an improvement plan with no subtype", () => {
    const text = VALID_IMPROVEMENT.replace(/^Subtype:.*\n/m, "");
    expect(() => parsePlan(text)).toThrow(/subtype required/);
  });

  it("rejects an improvement plan with an invalid subtype", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Subtype: new-feature",
      "Subtype: random-thing",
    );
    expect(() => parsePlan(text)).toThrow(/invalid improvement subtype/);
  });

  it("rejects an implementation plan with no parentPlan", () => {
    const text = VALID_IMPLEMENTATION.replace(/^ParentPlan:.*\n/m, "");
    expect(() => parsePlan(text)).toThrow(/parentPlan required/);
  });

  it("rejects an unknown Type", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Type: improvement",
      "Type: scheme",
    );
    expect(() => parsePlan(text)).toThrow();
  });

  it("rejects an invalid Status enum", () => {
    const text = VALID_IMPROVEMENT.replace("Status: draft", "Status: foo");
    expect(() => parsePlan(text)).toThrow();
  });

  it("rejects a non-boolean Destructive", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Destructive: false",
      "Destructive: maybe",
    );
    expect(() => parsePlan(text)).toThrow(/Destructive/);
  });

  it("rejects a confidence outside 0..100", () => {
    const text = VALID_IMPROVEMENT.replace(
      "Confidence: 75 — based on similar past CLI additions",
      "Confidence: 150",
    );
    expect(() => parsePlan(text)).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => parsePlan("")).toThrow();
  });

  it("rejects a missing title", () => {
    expect(() => parsePlan("Type: improvement\n")).toThrow(/Plan/);
  });
});

describe("serializePlan", () => {
  it("round-trips a parsed plan", () => {
    const plan = parsePlan(VALID_IMPROVEMENT);
    const serialized = serializePlan(plan);
    const reparsed = parsePlan(serialized);
    expect(reparsed.metadata).toEqual(plan.metadata);
    expect(reparsed.sections).toEqual(plan.sections);
  });

  it("omits undefined optional fields", () => {
    const plan: Plan = {
      metadata: {
        title: "minimal",
        type: "business",
        app: "jarvis",
        priority: "normal",
        destructive: false,
        status: "draft",
        author: "strategist",
        confidence: { score: 50 },
      },
      sections: [],
    };
    const out = serializePlan(plan);
    expect(out).not.toContain("Subtype");
    expect(out).not.toContain("ParentPlan");
    expect(out).not.toContain("ImplementationReview");
    expect(out).toContain("Confidence: 50\n");
  });

  it("emits Confidence with em-dash when rationale present", () => {
    const plan = parsePlan(VALID_IMPROVEMENT);
    const out = serializePlan(plan);
    expect(out).toContain("Confidence: 75 — based on similar past CLI additions");
  });
});

describe("plan-templates", () => {
  const templatesDir = path.join(import.meta.dirname, "..", "plan-templates");
  const templateFiles = ["improvement.md", "implementation.md", "business.md", "marketing.md"];

  for (const name of templateFiles) {
    it(`${name} parses without error`, () => {
      const text = fs.readFileSync(path.join(templatesDir, name), "utf8");
      expect(() => parsePlan(text)).not.toThrow();
    });
  }
});

describe("state machine", () => {
  const allStates: PlanStatus[] = [
    "draft",
    "awaiting-review",
    "approved",
    "executing",
    "paused",
    "blocked",
    "cancelled",
    "done",
    "rejected",
    "shipped-pending-impact",
    "success",
    "null-result",
    "regression",
  ];

  it("draft → awaiting-review only", () => {
    expect(allowedTransitions("draft")).toEqual(["awaiting-review"]);
  });

  it("awaiting-review allows approve, revise (back to draft), and reject", () => {
    expect(new Set(allowedTransitions("awaiting-review"))).toEqual(
      new Set(["approved", "draft", "rejected"]),
    );
  });

  it("approved can begin executing", () => {
    expect(canTransition("approved", "executing")).toBe(true);
  });

  it("executing can amend back to awaiting-review", () => {
    expect(canTransition("executing", "awaiting-review")).toBe(true);
  });

  it("executing can finish at done", () => {
    expect(canTransition("executing", "done")).toBe(true);
  });

  it("done can move to shipped-pending-impact", () => {
    expect(canTransition("done", "shipped-pending-impact")).toBe(true);
  });

  it("shipped-pending-impact can resolve to success/null-result/regression", () => {
    expect(new Set(allowedTransitions("shipped-pending-impact"))).toEqual(
      new Set(["success", "null-result", "regression"]),
    );
  });

  it("terminal states have no allowed transitions", () => {
    for (const s of [
      "cancelled",
      "rejected",
      "success",
      "null-result",
      "regression",
    ] as const) {
      expect(allowedTransitions(s)).toEqual([]);
    }
  });

  it("rejects an invalid transition", () => {
    expect(canTransition("draft", "executing")).toBe(false);
  });

  it("every status appears in the transition table", () => {
    for (const s of allStates) {
      expect(() => allowedTransitions(s)).not.toThrow();
    }
  });
});

describe("transitionPlan", () => {
  it("returns a new plan with the new status when allowed", () => {
    const plan = parsePlan(VALID_IMPROVEMENT);
    const next = transitionPlan(plan, "awaiting-review");
    expect(next.metadata.status).toBe("awaiting-review");
    expect(plan.metadata.status).toBe("draft"); // original unchanged
  });

  it("throws InvalidTransitionError on disallowed transition", () => {
    const plan = parsePlan(VALID_IMPROVEMENT);
    expect(() => transitionPlan(plan, "executing")).toThrow(
      InvalidTransitionError,
    );
  });
});
