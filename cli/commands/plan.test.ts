import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/anthropic-client.ts";
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

  it("returns 1 when ANTHROPIC_API_KEY is missing and no client is injected", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const code = await runPlan([
        "--app",
        "jarvis",
        "Add a status command",
      ]);
      expect(code).toBe(1);
    } finally {
      if (previous !== undefined) process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("joins multi-word positional briefs", async () => {
    const code = await runPlan(
      ["--app", "jarvis", "Add", "a", "status", "command"],
      { client: makeFixedClient(PLAN_BLOCK), prompter: noopPrompter },
    );
    expect(code).toBe(0);
  });
});
