import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import type { Prompter } from "../../agents/strategist.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runPlan } from "./plan.ts";

const PLAN_BLOCK = `<plan>
# Plan: Add status command
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — straightforward extension

## Problem
The CLI lacks a one-shot health summary.

## Build plan
- Add a status case to dispatch.

## Testing strategy
Unit + integration via doctor.

## Acceptance criteria
- yarn jarvis status prints the snapshot.

## Success metric
- Metric: subjective
- Baseline: today
- Target: ships
- Data source: manual

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert the PR.

## Estimated effort
- Claude calls: ~5
- Your review time: 10 min
- Wall-clock to ship: 2 hours

## Amendment clauses
Pause and amend if scope expands.
</plan>`;

function makeFixedClient(text: string): AnthropicClient {
  return {
    async chat() {
      const response: ChatResponse = {
        text,
        blocks: [
          { type: "text", text, citations: null } as Anthropic.TextBlock,
        ],
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
      return response;
    },
  };
}

const noopPrompter: Prompter = {
  async ask() {
    return "";
  },
  print() {},
};

describe("runPlan", () => {
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

  it("drafts a plan via Strategist and writes it to disk", async () => {
    const code = await runPlan(["--app", "jarvis", "Add a status command"], {
      client: makeFixedClient(PLAN_BLOCK),
      prompter: noopPrompter,
    });
    expect(code).toBe(0);

    const planFiles = fs.readdirSync(
      `${sandbox.dataDir}/vaults/personal/plans/jarvis`,
    );
    expect(planFiles.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("returns 1 when --app is missing", async () => {
    const code = await runPlan(["Add a status command"], {
      client: makeFixedClient(PLAN_BLOCK),
      prompter: noopPrompter,
    });
    expect(code).toBe(1);
  });

  it("returns 1 when no brief is given", async () => {
    const code = await runPlan(["--app", "jarvis"], {
      client: makeFixedClient(PLAN_BLOCK),
      prompter: noopPrompter,
    });
    expect(code).toBe(1);
  });

  it("joins multi-word positional briefs", async () => {
    const code = await runPlan(
      ["--app", "jarvis", "Add", "a", "status", "command"],
      { client: makeFixedClient(PLAN_BLOCK), prompter: noopPrompter },
    );
    expect(code).toBe(0);
  });

  it("re-throws unknown errors so programming bugs aren't swallowed", async () => {
    const buggy: AnthropicClient = {
      async chat() {
        throw new Error("unexpected programming bug");
      },
    };
    await expect(
      runPlan(["--app", "jarvis", "Add a status command"], {
        client: buggy,
        prompter: noopPrompter,
      }),
    ).rejects.toThrow("unexpected programming bug");
  });

  it("rejects an invalid --type", async () => {
    const code = await runPlan(
      ["--app", "jarvis", "--type", "implementation", "anything"],
      { client: makeFixedClient(PLAN_BLOCK), prompter: noopPrompter },
    );
    expect(code).toBe(1);
  });

  it("rejects --subtype that doesn't match an improvement subtype", async () => {
    const code = await runPlan(
      [
        "--app",
        "jarvis",
        "--type",
        "improvement",
        "--subtype",
        "campaign",
        "anything",
      ],
      { client: makeFixedClient(PLAN_BLOCK), prompter: noopPrompter },
    );
    expect(code).toBe(1);
  });

  it("rejects --subtype on business plans", async () => {
    const code = await runPlan(
      [
        "--app",
        "jarvis",
        "--type",
        "business",
        "--subtype",
        "campaign",
        "anything",
      ],
      { client: makeFixedClient(PLAN_BLOCK), prompter: noopPrompter },
    );
    expect(code).toBe(1);
  });

  it("accepts --type business + valid brief", async () => {
    const businessPlan = `<plan>
# Plan: Q2 — focus shift
Type: business
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 60

## Current situation
Active dev pipeline.

## Strategy
Focus on returning users.

## Target segment
Returning users.

## Key initiatives
- Re-engage email.

## Measurable goals
+10pp 30-day return.

## Constraints
Solo founder.

## Success metric
- Metric: 30-day return
- Baseline: 22%
- Target: 32%
- Data source: analytics

## Observation window
90d.

## Connections required
- analytics: present

## Rollback
Park strategy.

## Estimated effort
- Claude calls: ~15
- Your review time: 20 min
- Wall-clock to ship: 1d

## Amendment clauses
Pause if drift > 15%.
</plan>`;
    const code = await runPlan(
      [
        "--app",
        "jarvis",
        "--type",
        "business",
        "Quarterly business plan",
      ],
      { client: makeFixedClient(businessPlan), prompter: noopPrompter },
    );
    expect(code).toBe(0);
  });

  it("accepts --type marketing --subtype single-post", async () => {
    const marketingPlan = `<plan>
# Plan: Announce new feature
Type: marketing
Subtype: single-post
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 60

## Opportunity
New feature shipped.

## Audience
Existing users.

## Channels
Email.

## Content calendar
- 2026-04-29 (email): "We just shipped X — here's what it does..."

## Schedule
2026-04-29 09:00.

## Tracking & KPIs
Open rate.

## Success metric
- Metric: clicks
- Baseline: 0
- Target: 50
- Data source: analytics

## Observation window
14d.

## Connections required
- email: present

## Rollback
Retract email.

## Estimated effort
- Claude calls: ~5
- Your review time: 5 min
- Wall-clock to ship: 1h

## Amendment clauses
None.
</plan>`;
    const code = await runPlan(
      [
        "--app",
        "jarvis",
        "--type",
        "marketing",
        "--subtype",
        "single-post",
        "announce something",
      ],
      { client: makeFixedClient(marketingPlan), prompter: noopPrompter },
    );
    expect(code).toBe(0);
  });
});
