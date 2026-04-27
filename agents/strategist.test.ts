import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/anthropic-client.ts";
import { dbFile, planDir } from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  generatePlanId,
  parseStrategistResponse,
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
