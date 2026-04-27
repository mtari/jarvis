import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/anthropic-client.ts";
import { parsePlan, type Plan } from "../../orchestrator/plan.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { detectDeveloperMode, runRun } from "./run.ts";

function planFromMetadata(meta: Partial<Plan["metadata"]>): Plan {
  const type = meta.type ?? "improvement";
  let subtype = meta.subtype;
  if (subtype === undefined) {
    if (type === "improvement") subtype = "new-feature";
    else if (type === "marketing") subtype = "campaign";
  }
  const text = `# Plan: Sample
Type: ${type}
${subtype ? `Subtype: ${subtype}\n` : ""}${
    meta.parentPlan ? `ParentPlan: ${meta.parentPlan}\n` : ""
  }${
    meta.implementationReview
      ? `ImplementationReview: ${meta.implementationReview}\n`
      : ""
  }App: jarvis
Priority: normal
Destructive: false
Status: ${meta.status ?? "draft"}
Author: strategist
Confidence: 60

## Problem
sample
`;
  return parsePlan(text);
}

const VALID_IMPL_PLAN = (parentId: string): string =>
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
Small change to dispatcher.

## File changes
- cli/index.ts

## Schema changes
N/A

## New dependencies
N/A

## API surface
N/A

## Testing strategy
Unit + manual.

## Risk & rollback
Low.

## Open questions
None.

## Success metric
N/A

## Observation window
N/A

## Connections required
- None: present

## Rollback
Revert.

## Estimated effort
- Claude calls: ~3
- Your review time: 5 min
- Wall-clock to ship: 1 hour

## Amendment clauses
None.
</plan>`;

function fixedTextResponse(text: string): ChatResponse {
  return {
    text,
    blocks: [
      { type: "text", text, citations: null } as Anthropic.TextBlock,
    ],
    stopReason: "end_turn",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    redactions: [],
  };
}

function fixedClient(text: string): AnthropicClient {
  return {
    async chat() {
      return fixedTextResponse(text);
    },
  };
}

describe("detectDeveloperMode", () => {
  it("returns null when the plan is not approved", () => {
    expect(
      detectDeveloperMode(
        planFromMetadata({ type: "improvement", status: "draft" }),
      ),
    ).toBeNull();
  });

  it("returns 'execute' for an approved implementation plan", () => {
    expect(
      detectDeveloperMode(
        planFromMetadata({
          type: "implementation",
          parentPlan: "2026-04-27-foo",
          status: "approved",
        }),
      ),
    ).toBe("execute");
  });

  it("returns 'draft-impl' for an approved improvement plan with ImplementationReview: required", () => {
    expect(
      detectDeveloperMode(
        planFromMetadata({
          type: "improvement",
          subtype: "new-feature",
          implementationReview: "required",
          status: "approved",
        }),
      ),
    ).toBe("draft-impl");
  });

  it("returns 'execute' for an approved improvement plan with ImplementationReview: skip", () => {
    expect(
      detectDeveloperMode(
        planFromMetadata({
          type: "improvement",
          subtype: "refactor",
          implementationReview: "skip",
          status: "approved",
        }),
      ),
    ).toBe("execute");
  });

  it("auto-resolves new-feature/rework to draft-impl", () => {
    for (const subtype of ["new-feature", "rework"]) {
      expect(
        detectDeveloperMode(
          planFromMetadata({
            type: "improvement",
            subtype,
            implementationReview: "auto",
            status: "approved",
          }),
        ),
      ).toBe("draft-impl");
    }
  });

  it("auto-resolves refactor/security-fix/dep-update/bugfix/meta to execute", () => {
    for (const subtype of [
      "refactor",
      "security-fix",
      "dep-update",
      "bugfix",
      "meta",
    ]) {
      expect(
        detectDeveloperMode(
          planFromMetadata({
            type: "improvement",
            subtype,
            implementationReview: "auto",
            status: "approved",
          }),
        ),
      ).toBe("execute");
    }
  });
});

describe("runRun", () => {
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

  it("returns 1 with no agent argument", async () => {
    expect(await runRun([])).toBe(1);
  });

  it("returns 1 for unknown agents", async () => {
    expect(await runRun(["analyst", "x"])).toBe(1);
  });

  it("returns 1 when plan id is missing", async () => {
    expect(await runRun(["developer"])).toBe(1);
  });

  it("returns 1 when plan is not found", async () => {
    expect(
      await runRun(["developer", "does-not-exist"], {
        client: fixedClient("DONE"),
      }),
    ).toBe(1);
  });

  it("returns 1 when plan is not in approved state", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "draft" });
    expect(
      await runRun(["developer", "2026-04-27-test"], {
        client: fixedClient("DONE"),
      }),
    ).toBe(1);
  });

  it("fires Mode A on an approved improvement plan with ImplementationReview: required", async () => {
    const parentId = "2026-04-27-mode-a";
    dropPlan(sandbox, parentId, {
      status: "approved",
      implementationReview: "required",
    });
    const code = await runRun(["developer", parentId], {
      client: fixedClient(VALID_IMPL_PLAN(parentId)),
    });
    expect(code).toBe(0);
    // The impl plan should now exist
    expect(
      await runRun(["developer", parentId], {
        client: fixedClient(VALID_IMPL_PLAN(parentId)),
      }),
    ).toBe(1);
  });

  it("fires Mode B on an approved implementation plan", async () => {
    const planId = "2026-04-27-mode-b";
    dropPlan(sandbox, planId, {
      type: "implementation",
      parentPlan: "2026-04-27-parent",
      status: "approved",
    });
    const code = await runRun(["developer", planId], {
      client: fixedClient(
        [
          "DONE",
          "Branch: feat/2026-04-27-mode-b",
          "PR URL: https://example/pr/1",
          "Tests: pass",
        ].join("\n"),
      ),
    });
    expect(code).toBe(0);
  });

  it("returns 1 when Developer reports BLOCKED", async () => {
    const planId = "2026-04-27-blocked";
    dropPlan(sandbox, planId, {
      status: "approved",
      implementationReview: "skip",
    });
    const code = await runRun(["developer", planId], {
      client: fixedClient("BLOCKED: cannot fix tests"),
    });
    expect(code).toBe(1);
  });

  it("rejects extra positional arguments", async () => {
    expect(
      await runRun(["developer", "some-id", "extra"], {
        client: fixedClient("DONE"),
      }),
    ).toBe(1);
  });
});
