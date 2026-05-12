import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { dbFile, planDir } from "../cli/paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import {
  generatePlanId,
  parseStrategistResponse,
  redraftPlan,
  runStrategist,
  StrategistError,
  type Prompter,
} from "./strategist.ts";

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
Confidence: 70 — straightforward CLI extension

## Problem
The CLI lacks a one-shot health summary.

## Build plan
- Add a status case to cli/index.ts dispatch.
- Print daemon, lock, plan-pending, vault summary.

## Testing strategy
Unit on the formatter; integration via doctor.

## Acceptance criteria
- yarn jarvis status prints the snapshot.
- Exit code 0 when clean.

## Success metric
- Metric: subjective check
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
Pause and amend if scope expands beyond a single command.
</plan>`;

const CLARIFY_BLOCK = `<clarify>
Should status include vault sync state, or just daemon liveness?
What format do you prefer: terse table or labeled lines?
</clarify>`;

interface ClientCall {
  request: ChatRequest;
}

function makeMockClient(responses: string[]): {
  client: AnthropicClient;
  calls: ClientCall[];
} {
  const calls: ClientCall[] = [];
  let index = 0;
  const client: AnthropicClient = {
    async chat(request) {
      calls.push({ request });
      if (index >= responses.length) {
        throw new Error("Mock client ran out of responses.");
      }
      const text = responses[index++]!;
      const fakeResponse: ChatResponse = {
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
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
      return fakeResponse;
    },
  };
  return { client, calls };
}

function makeRecordingPrompter(answers: string[]): {
  prompter: Prompter;
  asked: string[];
  printed: string[];
} {
  const asked: string[] = [];
  const printed: string[] = [];
  let i = 0;
  const prompter: Prompter = {
    async ask(prompt) {
      asked.push(prompt);
      const answer = answers[i++] ?? "";
      return answer;
    },
    print(msg) {
      printed.push(msg);
    },
  };
  return { prompter, asked, printed };
}

describe("parseStrategistResponse", () => {
  function fakeResponse(text: string): ChatResponse {
    return {
      text,
      blocks: [],
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
  }

  it("extracts a plan markdown from <plan> tags", () => {
    const action = parseStrategistResponse(fakeResponse(PLAN_BLOCK));
    expect(action.kind).toBe("draft");
    if (action.kind === "draft") {
      expect(action.markdown).toContain("# Plan: Add status command");
    }
  });

  it("extracts questions from <clarify> tags", () => {
    const action = parseStrategistResponse(fakeResponse(CLARIFY_BLOCK));
    expect(action.kind).toBe("clarify");
    if (action.kind === "clarify") {
      expect(action.questions).toHaveLength(2);
      expect(action.questions[0]).toContain("vault sync state");
    }
  });

  it("strips bullet markers from clarification questions", () => {
    const action = parseStrategistResponse(
      fakeResponse(`<clarify>\n- First?\n* Second?\n• Third?\n</clarify>`),
    );
    expect(action.kind).toBe("clarify");
    if (action.kind === "clarify") {
      expect(action.questions).toEqual(["First?", "Second?", "Third?"]);
    }
  });

  it("throws when neither tag is present", () => {
    expect(() =>
      parseStrategistResponse(fakeResponse("just some chatter")),
    ).toThrow(StrategistError);
  });

  it("throws when <clarify> contains no questions", () => {
    expect(() =>
      parseStrategistResponse(fakeResponse(`<clarify>\n\n</clarify>`)),
    ).toThrow(StrategistError);
  });
});

describe("generatePlanId", () => {
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

  it("formats date + slug from the title", () => {
    const id = generatePlanId(
      "Add Status Command",
      "jarvis",
      sandbox.dataDir,
      "personal",
      new Date("2026-04-27T12:00:00Z"),
    );
    expect(id).toBe("2026-04-27-add-status-command");
  });

  it("appends -2, -3 on collisions in the same dir", () => {
    const folder = planDir(sandbox.dataDir, "personal", "jarvis");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(`${folder}/2026-04-27-foo.md`, "");
    fs.writeFileSync(`${folder}/2026-04-27-foo-2.md`, "");
    const id = generatePlanId(
      "foo",
      "jarvis",
      sandbox.dataDir,
      "personal",
      new Date("2026-04-27T12:00:00Z"),
    );
    expect(id).toBe("2026-04-27-foo-3");
  });

  it("never returns an id with a trailing dash when slice lands on a dash boundary", () => {
    // "Fix slack slash flag parsing for jarvis service" slugifies to
    // "fix-slack-slash-flag-parsing-for-jarvis-servi" at 45 chars; slicing to
    // 40 lands on "fix-slack-slash-flag-parsing-for-jarvis-" — trailing dash
    // must be trimmed.
    const id = generatePlanId(
      "Fix slack slash flag parsing for jarvis service",
      "jarvis",
      sandbox.dataDir,
      "personal",
      new Date("2026-05-12T00:00:00Z"),
    );
    expect(id).not.toMatch(/-$/);
    expect(id).toMatch(/^2026-05-12-/);
  });

  it("trims leading dashes that survive a post-slice re-trim", () => {
    // Title that starts with punctuation should still produce no leading dash.
    const id = generatePlanId(
      "---fix something",
      "jarvis",
      sandbox.dataDir,
      "personal",
      new Date("2026-05-12T00:00:00Z"),
    );
    expect(id).not.toMatch(/^2026-05-12--/);
  });
});

describe("runStrategist", () => {
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

  it("drafts directly when the response is <plan>", async () => {
    const { client, calls } = makeMockClient([PLAN_BLOCK]);
    const result = await runStrategist({
      client,
      brief: "Add a CLI status command",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    expect(result.rounds).toBe(0);
    expect(result.clarifications).toEqual([]);
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.cacheSystem).toBe(true);
    expect(calls[0]?.request.system).toContain("Strategist");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT * FROM events WHERE kind = 'plan-drafted'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        planId: result.planId,
        rounds: 0,
        author: "strategist",
      });
    } finally {
      db.close();
    }
  });

  it("loops on <clarify> and records answers as feedback", async () => {
    const { client } = makeMockClient([CLARIFY_BLOCK, PLAN_BLOCK]);
    const { prompter, asked } = makeRecordingPrompter(["both", "table"]);

    const result = await runStrategist({
      client,
      brief: "Add a status command",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      prompter,
    });

    expect(result.rounds).toBe(1);
    expect(result.clarifications).toHaveLength(1);
    expect(result.clarifications[0]?.answers).toEqual(["both", "table"]);
    expect(asked).toHaveLength(2);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const fb = db
        .prepare(
          "SELECT * FROM feedback WHERE kind = 'clarification-answer' ORDER BY id",
        )
        .all() as Array<{ note: string; context_snapshot: string }>;
      expect(fb).toHaveLength(2);
      expect(fb[0]?.note).toBe("both");
      expect(JSON.parse(fb[1]!.context_snapshot)).toMatchObject({
        question: expect.stringContaining("format"),
      });
    } finally {
      db.close();
    }
  });

  it("forces a draft after MAX_CHALLENGE_ROUNDS rounds", async () => {
    const { client, calls } = makeMockClient([
      CLARIFY_BLOCK,
      CLARIFY_BLOCK,
      CLARIFY_BLOCK,
      PLAN_BLOCK,
    ]);
    const { prompter } = makeRecordingPrompter(["a", "b", "c", "d", "e", "f"]);
    const result = await runStrategist({
      client,
      brief: "Add a status command",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      prompter,
    });
    expect(result.rounds).toBe(3);
    expect(calls).toHaveLength(4);
  });

  it("respects challenge: false by skipping prompter and forcing a draft", async () => {
    const { client, calls } = makeMockClient([CLARIFY_BLOCK, PLAN_BLOCK]);
    const result = await runStrategist({
      client,
      brief: "Add a status command",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      challenge: false,
    });
    expect(result.rounds).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.messages.at(-1)?.content).toContain(
      "Drafting required now",
    );
  });

  it("throws StrategistError when clarification is needed but no prompter is provided", async () => {
    const { client } = makeMockClient([CLARIFY_BLOCK]);
    await expect(
      runStrategist({
        client,
        brief: "Add a status command",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(StrategistError);
  });

  it("throws StrategistError when the draft fails Zod validation", async () => {
    const broken = "<plan>\n# Not a real plan\nType: improvement\n</plan>";
    const { client } = makeMockClient([broken]);
    await expect(
      runStrategist({
        client,
        brief: "Add a status command",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/schema validation/);
  });
});

describe("runStrategist — type-specific prompts", () => {
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

  it("loads strategist-improvement.md for type='improvement' (default)", async () => {
    const { client, calls } = makeMockClient([PLAN_BLOCK]);
    await runStrategist({
      client,
      brief: "Add a CLI status command",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });
    const sys = String(calls[0]?.request.system ?? "");
    expect(sys).toContain("improvement plans");
  });

  it("loads strategist-business.md for type='business' and persists Type: business", async () => {
    const businessPlan = `<plan>
# Plan: Q2 2026 — focus on returning customers
Type: business
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — based on the brief

## Current situation
Active dev pipeline; no formal Q2 frame yet.

## Strategy
Returning-customer focus.

## Target segment
Existing users who haven't shipped a plan in 30 days.

## Key initiatives
- Re-engagement digest.
- Friction audit.

## Measurable goals
30-day return rate up by 10pp.

## Constraints
Solo founder; one app live.

## Success metric
- Metric: 30-day return rate
- Baseline: ~22%
- Target: 32%
- Data source: app analytics

## Observation window
90d.

## Connections required
- analytics: present

## Rollback
Park the strategy; resume previous focus.

## Estimated effort
- Claude calls: ~15
- Your review time: 20 min
- Wall-clock to ship: 1 day

## Amendment clauses
Pause and amend if monthly metrics drift > 15% mid-window.
</plan>`;
    const { client, calls } = makeMockClient([businessPlan]);
    const result = await runStrategist({
      client,
      brief: "Quarterly business plan focusing on returning customers",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      type: "business",
    });

    const sys = String(calls[0]?.request.system ?? "");
    expect(sys).toContain("business plans");
    const written = fs.readFileSync(result.planPath, "utf8");
    expect(written).toContain("Type: business");
    expect(written).toContain("Status: awaiting-review");
  });

  it("loads strategist-marketing.md for type='marketing' and persists Type: marketing + Subtype", async () => {
    const marketingPlan = `<plan>
# Plan: April 2026 — returning-user campaign
Type: marketing
Subtype: campaign
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 65 — first draft

## Opportunity
Returning users haven't seen recent improvements.

## Audience
Past users last active > 30 days ago.

## Channels
Email primary, X secondary.

## Content calendar
- 2026-04-29 (email): "What changed in Q2 — [actual subject + body draft would go here]"

## Schedule
2026-04-29 09:00.

## Tracking & KPIs
Open rate, click-through.

## Success metric
- Metric: 7d return after campaign
- Baseline: 22%
- Target: 30%
- Data source: app analytics

## Observation window
30d.

## Connections required
- email: present

## Rollback
Stop campaign; remove scheduled posts.

## Estimated effort
- Claude calls: ~20
- Your review time: 30 min
- Wall-clock to ship: 1 day

## Amendment clauses
Pause if open rate < 5%.
</plan>`;
    const { client, calls } = makeMockClient([marketingPlan]);
    const result = await runStrategist({
      client,
      brief: "April campaign re-engaging returning users",
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
      type: "marketing",
      subtype: "campaign",
    });

    const sys = String(calls[0]?.request.system ?? "");
    expect(sys).toContain("marketing plans");
    const userMsg = String(calls[0]?.request.messages[0]?.content ?? "");
    expect(userMsg).toContain("Plan type: marketing");
    expect(userMsg).toContain("Subtype hint from CLI: campaign");

    const written = fs.readFileSync(result.planPath, "utf8");
    expect(written).toContain("Type: marketing");
    expect(written).toContain("Subtype: campaign");
  });
});

const REDRAFT_RESPONSE = `<plan>
# Plan: Test plan (after revision)
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
Better problem statement after the user's feedback.

## Build plan
Updated.

## Testing strategy
Tests.

## Acceptance criteria
- ok
</plan>`;

describe("redraftPlan", () => {
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

  it("redrafts a draft plan back to awaiting-review and emits a plan-redrafted event", async () => {
    const planId = "2026-04-27-redraft";
    const planPath = dropPlan(sandbox, planId, { status: "draft" });

    const seed = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(seed, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId, brief: "Original brief", author: "strategist" },
      });
      recordFeedback(seed, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: planId,
        note: "make it tighter",
      });
    } finally {
      seed.close();
    }

    const { client, calls } = makeMockClient([REDRAFT_RESPONSE]);
    const result = await redraftPlan({
      client,
      planId,
      app: "jarvis",
      vault: "personal",
      dataDir: sandbox.dataDir,
    });

    expect(result.planId).toBe(planId);
    expect(result.revisionRound).toBe(1);

    const reread = fs.readFileSync(planPath, "utf8");
    expect(reread).toContain("Status: awaiting-review");
    expect(reread).toContain("Test plan (after revision)");

    const userMsg = String(calls[0]?.request.messages[0]?.content ?? "");
    expect(userMsg).toContain("Original brief: Original brief");
    expect(userMsg).toContain("Round 1: make it tighter");
    expect(userMsg).toContain("Action: REDRAFT");

    const verify = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = verify
        .prepare("SELECT * FROM events WHERE kind = 'plan-redrafted'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
    } finally {
      verify.close();
    }
  });

  it("throws when the plan is not in draft state", async () => {
    dropPlan(sandbox, "2026-04-27-not-draft", { status: "awaiting-review" });
    const { client } = makeMockClient([REDRAFT_RESPONSE]);
    await expect(
      redraftPlan({
        client,
        planId: "2026-04-27-not-draft",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toBeInstanceOf(StrategistError);
  });

  it("throws when Strategist returns <clarify> instead of <plan>", async () => {
    dropPlan(sandbox, "2026-04-27-clarify", { status: "draft" });
    const { client } = makeMockClient([CLARIFY_BLOCK]);
    await expect(
      redraftPlan({
        client,
        planId: "2026-04-27-clarify",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/<plan>/);
  });

  it("throws when redrafted plan changes Type", async () => {
    dropPlan(sandbox, "2026-04-27-type-change", { status: "draft" });
    const businessPlan = `<plan>
# Plan: Now I'm a business plan
Type: business
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 50

## Current situation
x

## Strategy
x

## Target segment
x

## Key initiatives
x

## Measurable goals
x

## Constraints
x

## Success metric
- Metric: x
- Baseline: x
- Target: x
- Data source: x

## Observation window
90d.

## Connections required
- none: present

## Rollback
revert.

## Estimated effort
- Claude calls: x
- Your review time: x
- Wall-clock to ship: x

## Amendment clauses
none
</plan>`;
    const { client } = makeMockClient([businessPlan]);
    await expect(
      redraftPlan({
        client,
        planId: "2026-04-27-type-change",
        app: "jarvis",
        vault: "personal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/type/);
  });
});
