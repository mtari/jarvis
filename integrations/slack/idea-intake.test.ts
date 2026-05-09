import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResult,
  RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import {
  loadBusinessIdeas,
} from "../../orchestrator/business-ideas.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import {
  continueIdeaIntakeConversation,
  findIdeaIntakeConversation,
  startIdeaIntakeConversation,
  type SlackIdeaIntakeContext,
} from "./idea-intake.ts";

function fixedRunResult(text: string): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 1,
    durationMs: 1,
    totalCostUsd: 0,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  };
}

function scriptedTransport(responses: string[]): RunAgentTransport {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      throw new Error(`scripted transport out of responses (got ${i + 1})`);
    }
    return fixedRunResult(responses[i++]!);
  };
}

interface SlackPostCall {
  channel: string;
  thread_ts?: string;
  text?: string;
}

function fakeSlackClient(): {
  client: SlackIdeaIntakeContext["client"];
  posts: SlackPostCall[];
} {
  const posts: SlackPostCall[] = [];
  let counter = 1;
  const client = {
    chat: {
      async postMessage(opts: SlackPostCall) {
        posts.push({ ...opts });
        return { ok: true, ts: `1700000000.00${counter++}` };
      },
    },
  };
  return { client: client as never, posts };
}

describe("startIdeaIntakeConversation", () => {
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

  it("posts thread root + first reply, records started event", async () => {
    const slack = fakeSlackClient();
    const transport = scriptedTransport([
      `<ask>Working title and target app?</ask>`,
    ]);

    const result = await startIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      vault: "personal",
      invokedBy: "U123",
    });

    expect(result.threadTs).toBeTruthy();
    expect(result.conversationId).toMatch(/^idea-/);

    // Two posts: thread root + first agent ask
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[0]?.text).toContain("opened an idea-intake thread");
    expect(slack.posts[1]?.thread_ts).toBe(result.threadTs);
    expect(slack.posts[1]?.text).toBe("Working title and target app?");

    // Started event on disk
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'idea-intake-started'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const p = JSON.parse(events[0]!.payload);
      expect(p).toMatchObject({
        conversationId: result.conversationId,
        vault: "personal",
        channel: "C-IDEAS",
        threadTs: result.threadTs,
        firstAskText: "Working title and target app?",
        firstAskKind: "ask",
      });
    } finally {
      db.close();
    }
  });
});

describe("continueIdeaIntakeConversation", () => {
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

  async function openThread(transport: RunAgentTransport): Promise<{
    slack: ReturnType<typeof fakeSlackClient>;
    threadTs: string;
  }> {
    const slack = fakeSlackClient();
    const result = await startIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      vault: "personal",
      invokedBy: "U123",
    });
    return { slack, threadTs: result.threadTs };
  }

  it("returns 'not-our-thread' for an unknown thread", async () => {
    const slack = fakeSlackClient();
    const result = await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client },
      channel: "C-X",
      threadTs: "9999.0001",
      userText: "hi",
      userId: "U1",
    });
    expect(result.status).toBe("not-our-thread");
  });

  it("plain reply continues the thread and persists messages", async () => {
    // 1. Open thread (uses 1 transport response)
    // 2. Reply (uses 1 more)
    const transport = scriptedTransport([
      `<ask>Working title and target app?</ask>`,
      `<ask>Audience and rough effort?</ask>`,
    ]);
    const { slack, threadTs } = await openThread(transport);

    const result = await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      threadTs,
      userText: "Personal-brand newsletter, new project",
      userId: "U123",
    });
    expect(result.status).toBe("continued");

    // 3 posts: root + first ask + second ask
    expect(slack.posts).toHaveLength(3);
    expect(slack.posts[2]?.text).toBe("Audience and rough effort?");

    // Messages persisted: 1 user + 1 agent
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'idea-intake-message' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(2);
      const p1 = JSON.parse(events[0]!.payload);
      const p2 = JSON.parse(events[1]!.payload);
      expect(p1.role).toBe("user");
      expect(p1.text).toBe("Personal-brand newsletter, new project");
      expect(p2.role).toBe("agent");
      expect(p2.text).toBe("Audience and rough effort?");
    } finally {
      db.close();
    }
  });

  it("appends the saved idea to Business_Ideas.md when the agent emits <idea> and closes the thread", async () => {
    const transport = scriptedTransport([
      `<ask>Title?</ask>`,
      `<idea>
Title: Personal-brand newsletter
App: new
Brief: Weekly behind-the-scenes letter on solo product-building.
Tags: brand, content

Audience: indie devs. Effort: 2h/week. No deps.
</idea>`,
    ]);
    const { slack, threadTs } = await openThread(transport);

    const result = await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      threadTs,
      userText: "Personal-brand newsletter, new project",
      userId: "U123",
    });
    expect(result.status).toBe("saved");
    expect(result.ideaId).toBe("personal-brand-newsletter");

    // Idea appended to Business_Ideas.md
    const file = loadBusinessIdeas(sandbox.dataDir);
    expect(file.ideas).toHaveLength(1);
    expect(file.ideas[0]?.title).toBe("Personal-brand newsletter");
    expect(file.ideas[0]?.app).toBe("new");
    expect(file.ideas[0]?.tags).toEqual(["brand", "content"]);

    // Thread closed
    const lookup = findIdeaIntakeConversation(
      sandbox.dataDir,
      "C-IDEAS",
      threadTs,
    );
    expect(lookup?.closed).toBe(true);

    // Confirmation posted in thread
    const lastPost = slack.posts[slack.posts.length - 1];
    expect(lastPost?.thread_ts).toBe(threadTs);
    expect(lastPost?.text).toContain("Idea saved");
    expect(lastPost?.text).toContain("Personal-brand newsletter");

    // idea-added event written
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'idea-added' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        title: "Personal-brand newsletter",
        app: "new",
        source: "slack-thread",
      });
    } finally {
      db.close();
    }
  });

  it("/end signals wrap-up: the next turn passes userSignaledEnd to the agent", async () => {
    const transport = scriptedTransport([
      `<ask>Title?</ask>`,
      `<idea>
Title: (untitled)
App: new
Brief: (no brief — captured early)

User wrapped early.
</idea>`,
    ]);
    const { slack, threadTs } = await openThread(transport);

    const result = await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      threadTs,
      userText: "/end",
      userId: "U123",
    });
    expect(result.status).toBe("saved");

    const file = loadBusinessIdeas(sandbox.dataDir);
    expect(file.ideas).toHaveLength(1);
    expect(file.ideas[0]?.title).toBe("(untitled)");
  });

  it("ignores replies once the thread is closed", async () => {
    const transport = scriptedTransport([
      `<ask>Title?</ask>`,
      `<idea>
Title: Foo
App: new
Brief: bar

body
</idea>`,
    ]);
    const { slack, threadTs } = await openThread(transport);

    // First reply saves and closes
    await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      threadTs,
      userText: "x",
      userId: "U1",
    });

    // Second reply on closed thread
    const result = await continueIdeaIntakeConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, transport },
      channel: "C-IDEAS",
      threadTs,
      userText: "another reply",
      userId: "U1",
    });
    expect(result.status).toBe("closed");
  });
});
