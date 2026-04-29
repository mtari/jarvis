import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { parsePlan } from "../../orchestrator/plan.ts";
import { dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runRevise } from "./revise.ts";

const REDRAFT_PLAN = `<plan>
# Plan: Test plan (revised)
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 80 — addressed feedback

## Problem
After revision: the brief is now clearer.

## Build plan
Updated build plan addressing feedback.

## Testing strategy
Standard.

## Acceptance criteria
- ok
</plan>`;

function fixedClient(text: string): {
  client: AnthropicClient;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        const response: ChatResponse = {
          text,
          blocks: [
            {
              type: "text",
              text,
              citations: null,
            } as Anthropic.TextBlock,
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
    },
  };
}

describe("runRevise", () => {
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

  it("transitions awaiting-review → draft and stores feedback note", async () => {
    const planPath = dropPlan(sandbox, "2026-04-27-test", {
      status: "awaiting-review",
    });

    // Inject a stub client so the auto-redraft path goes through cleanly
    // and the test doesn't try to spawn the SDK subprocess.
    const { client } = fixedClient(REDRAFT_PLAN);
    const code = await runRevise(
      ["2026-04-27-test", "scope is too broad"],
      { client },
    );
    expect(code).toBe(0);

    // Plan transitions through draft → awaiting-review (after redraft).
    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "awaiting-review",
    );

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const feedback = db
        .prepare("SELECT * FROM feedback WHERE kind = 'revise'")
        .all() as Array<{ note: string }>;
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.note).toBe("scope is too broad");
    } finally {
      db.close();
    }
  });

  it("accepts --note as an alternative to a positional note", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    const { client } = fixedClient(REDRAFT_PLAN);
    expect(
      await runRevise(
        ["2026-04-27-test", "--note", "swap the framing"],
        { client },
      ),
    ).toBe(0);
  });

  it("returns 1 when no feedback is provided", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    expect(await runRevise(["2026-04-27-test"])).toBe(1);
  });

  it("returns 1 when the plan is not in awaiting-review", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "draft" });
    expect(await runRevise(["2026-04-27-test", "fix this"])).toBe(1);
  });
});

describe("runRevise — auto-redraft via Strategist", () => {
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

  it("redrafts the plan back to awaiting-review with new content when a client is wired", async () => {
    const planId = "2026-04-27-redraft";
    const planPath = dropPlan(sandbox, planId, {
      status: "awaiting-review",
      title: "Test plan",
    });
    const { client } = fixedClient(REDRAFT_PLAN);
    const code = await runRevise(
      [planId, "scope is too broad"],
      { client },
    );
    expect(code).toBe(0);
    const reread = parsePlan(fs.readFileSync(planPath, "utf8"));
    expect(reread.metadata.status).toBe("awaiting-review");
    expect(reread.metadata.title).toBe("Test plan (revised)");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT * FROM events WHERE kind = 'plan-redrafted'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId,
        revisionRound: 1,
        author: "strategist",
      });
    } finally {
      db.close();
    }
  });

  it("escalates without recording or transitioning when at the 3-revision cap", async () => {
    const planId = "2026-04-27-cap";
    const planPath = dropPlan(sandbox, planId, {
      status: "awaiting-review",
    });
    // Pre-seed 3 prior revisions
    const seedDb = new Database(dbFile(sandbox.dataDir));
    try {
      for (let i = 0; i < 3; i += 1) {
        recordFeedback(seedDb, {
          kind: "revise",
          actor: "user",
          targetType: "plan",
          targetId: planId,
          note: `prior #${i + 1}`,
        });
      }
    } finally {
      seedDb.close();
    }

    const { client, calls } = fixedClient(REDRAFT_PLAN);
    const code = await runRevise(
      [planId, "fourth attempt"],
      { client },
    );
    expect(code).toBe(0);

    // No new feedback row recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const fb = db
        .prepare(
          "SELECT * FROM feedback WHERE kind = 'revise' AND target_id = ?",
        )
        .all(planId) as unknown[];
      expect(fb).toHaveLength(3); // unchanged
    } finally {
      db.close();
    }

    // Plan stays in awaiting-review (no transition)
    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "awaiting-review",
    );

    // Strategist never called
    expect(calls).toHaveLength(0);
  });

  it("leaves the plan in 'draft' when redraft throws StrategistError", async () => {
    const planId = "2026-04-27-redraft-fail";
    const planPath = dropPlan(sandbox, planId, {
      status: "awaiting-review",
    });
    const { client } = fixedClient("not a plan, no <plan> tag");
    const code = await runRevise([planId, "feedback"], { client });
    expect(code).toBe(1);
    expect(parsePlan(fs.readFileSync(planPath, "utf8")).metadata.status).toBe(
      "draft",
    );
  });

});
