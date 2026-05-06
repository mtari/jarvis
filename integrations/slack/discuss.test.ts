import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import {
  continueDiscussConversation,
  findDiscussConversation,
  startDiscussConversation,
  type SlackDiscussContext,
} from "./discuss.ts";

// ---------------------------------------------------------------------------
// Fakes — Anthropic client (scripted) + Slack WebClient (recording)
// ---------------------------------------------------------------------------

function scriptedClient(responses: string[]): AnthropicClient {
  let i = 0;
  return {
    async chat() {
      const text = responses[i++];
      if (text === undefined) {
        throw new Error(`scripted client out of responses (after ${i - 1})`);
      }
      const r: ChatResponse = {
        text,
        blocks: [{ type: "text", text }],
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
      return r;
    },
  };
}

interface SlackPostCall {
  channel: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown[];
}

function fakeSlackClient(): {
  client: SlackDiscussContext["client"];
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

// ---------------------------------------------------------------------------
// startDiscussConversation
// ---------------------------------------------------------------------------

describe("startDiscussConversation", () => {
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
    const anthropic = scriptedClient([
      "<continue>What's the goal for this campaign?</continue>",
    ]);
    const result = await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "thinking through April pricing",
      invokedBy: "U123",
    });
    expect(result.conversationId).toMatch(/^discuss-/);
    expect(result.threadTs).toMatch(/^17/);

    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[0]?.thread_ts).toBeUndefined(); // root
    expect(slack.posts[0]?.text).toContain("U123");
    expect(slack.posts[0]?.text).toContain("April pricing");
    expect(slack.posts[1]?.thread_ts).toBe(result.threadTs);
    expect(slack.posts[1]?.text).toContain("What's the goal");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-started'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload);
      expect(payload.channel).toBe("C-INBOX");
      expect(payload.app).toBe("demo");
      expect(payload.threadTs).toBe(result.threadTs);
      expect(payload.rawAssistantText).toContain("<continue>");
    } finally {
      db.close();
    }
  });

  it("renders proposals with Accept/Drop action blocks", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([
      "<propose-note>address-step is the funnel killer</propose-note>",
    ]);
    const result = await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "x",
      invokedBy: "U123",
    });
    // The thread reply (second postMessage) carries blocks for the proposal.
    const proposalPost = slack.posts[1];
    expect(proposalPost?.blocks).toBeDefined();
    const blocks = (proposalPost?.blocks ?? []) as Array<{
      type?: string;
      elements?: Array<{ action_id?: string; value?: string }>;
    }>;
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const actionIds = (actions?.elements ?? []).map((e) => e.action_id);
    expect(actionIds).toContain("discuss_accept");
    expect(actionIds).toContain("discuss_drop");
    // Each button's value is the threadTs for the routing handler.
    expect(
      (actions?.elements ?? []).every((e) => e.value === result.threadTs),
    ).toBe(true);
  });

  it("non-proposal turns do NOT include action blocks", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([
      "<continue>What's the goal?</continue>",
    ]);
    await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "x",
      invokedBy: "U123",
    });
    expect(slack.posts[1]?.blocks).toBeUndefined();
  });

  it("first turn that closes immediately writes a closed event", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([
      "<close>Already covered — nothing to add.</close>",
    ]);
    await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "x",
      invokedBy: "U123",
    });
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const closed = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed'",
        )
        .all() as Array<{ payload: string }>;
      expect(closed).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// findDiscussConversation
// ---------------------------------------------------------------------------

describe("findDiscussConversation", () => {
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

  it("returns null for unknown thread", () => {
    expect(
      findDiscussConversation(sandbox.dataDir, "C-OTHER", "1700000000.999"),
    ).toBeNull();
  });

  it("finds an open conversation by (channel, threadTs)", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([
      "<continue>What's the goal?</continue>",
    ]);
    const start = await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "x",
      invokedBy: "U123",
    });
    const lookup = findDiscussConversation(
      sandbox.dataDir,
      "C-INBOX",
      start.threadTs,
    );
    expect(lookup).not.toBeNull();
    expect(lookup?.app).toBe("demo");
    expect(lookup?.closed).toBe(false);
    expect(lookup?.awaitingDecision).toBe(false);
    // Conversation should include initial context (rebuilt) + first assistant.
    expect(lookup?.conversation.length).toBe(2);
    expect(lookup?.conversation[0]?.role).toBe("user");
    expect(lookup?.conversation[1]?.role).toBe("assistant");
  });

  it("flags awaitingDecision when last assistant turn was a proposal", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([
      "<propose-note>address-step is the funnel killer</propose-note>",
    ]);
    const start = await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "the funnel",
      invokedBy: "U123",
    });
    const lookup = findDiscussConversation(
      sandbox.dataDir,
      "C-INBOX",
      start.threadTs,
    );
    expect(lookup?.awaitingDecision).toBe(true);
    expect(lookup?.pendingProposal?.kind).toBe("propose-note");
  });
});

// ---------------------------------------------------------------------------
// continueDiscussConversation
// ---------------------------------------------------------------------------

describe("continueDiscussConversation", () => {
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

  async function open(
    responses: string[],
  ): Promise<{
    threadTs: string;
    slack: ReturnType<typeof fakeSlackClient>;
    anthropic: AnthropicClient;
  }> {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient(responses);
    const start = await startDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      app: "demo",
      vault: "personal",
      topic: "topic",
      invokedBy: "U123",
    });
    return { threadTs: start.threadTs, slack, anthropic };
  }

  it("ignores threads we don't own", async () => {
    const slack = fakeSlackClient();
    const anthropic = scriptedClient([]);
    const result = await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-NOPE",
      threadTs: "1700000000.999",
      userText: "hi",
      userId: "U1",
    });
    expect(result.status).toBe("not-our-thread");
    expect(slack.posts).toHaveLength(0);
  });

  it("continues with another LLM turn on a plain reply", async () => {
    const { threadTs, slack, anthropic } = await open([
      "<continue>What's the goal?</continue>",
      "<continue>Got it — what's the timeline?</continue>",
    ]);
    const result = await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      threadTs,
      userText: "Drive bookings before May.",
      userId: "U123",
    });
    expect(result.status).toBe("continued");
    // Two posts on start, one new on continue
    expect(slack.posts).toHaveLength(3);
    expect(slack.posts[2]?.text).toContain("timeline");

    // Two new discuss-conversation-message events (user + assistant)
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const msgs = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-message' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      expect(msgs).toHaveLength(2);
      expect(JSON.parse(msgs[0]!.payload).role).toBe("user");
      expect(JSON.parse(msgs[1]!.payload).role).toBe("assistant");
    } finally {
      db.close();
    }
  });

  it("on `y` reply to a proposal: executes outcome + records closed", async () => {
    const { threadTs, slack, anthropic } = await open([
      "<propose-note>address-step is the funnel killer</propose-note>",
    ]);
    const result = await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      threadTs,
      userText: "y",
      userId: "U123",
    });
    expect(result.status).toBe("accepted");
    expect(result.outcome).toBe("note");

    // Confirmation reply posted in thread
    expect(slack.posts.at(-1)?.text).toContain("Accepted by <@U123>");

    // closed event recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const closed = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed'",
        )
        .all() as Array<{ payload: string }>;
      expect(closed).toHaveLength(1);
      expect(JSON.parse(closed[0]!.payload)).toMatchObject({
        outcome: "note",
        actor: "slack:U123",
      });
    } finally {
      db.close();
    }
  });

  it("on `n` reply to a proposal: continues + flags rejection in next turn", async () => {
    const { threadTs, slack, anthropic } = await open([
      "<propose-note>some note</propose-note>",
      "<continue>OK what would you change?</continue>",
    ]);
    const result = await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      threadTs,
      userText: "n",
      userId: "U123",
    });
    expect(result.status).toBe("continued");

    // The conversation message persisted should carry the rejection text
    // (formatted), not just "n".
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const msgs = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-message' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      const userMsg = JSON.parse(msgs[0]!.payload);
      expect(userMsg.role).toBe("user");
      expect(userMsg.content).toContain("Not yet");
    } finally {
      db.close();
    }
  });

  it("on free-text reply to a proposal: folds the comment in as a refinement", async () => {
    const { threadTs, slack, anthropic } = await open([
      "<propose-note>some note</propose-note>",
      "<continue>Got it.</continue>",
    ]);
    await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      threadTs,
      userText: "the wording is wrong, make it shorter",
      userId: "U123",
    });
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const msgs = db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-message' ORDER BY id ASC",
        )
        .all() as Array<{ payload: string }>;
      const userContent = JSON.parse(msgs[0]!.payload).content as string;
      expect(userContent).toContain("the wording is wrong");
      expect(userContent).toContain("Not yet");
    } finally {
      db.close();
    }
  });

  it("when a model close fires, records closed event + future replies are no-op", async () => {
    const { threadTs, slack, anthropic } = await open([
      "<continue>Hmm.</continue>",
      "<close>We talked it through. No action.</close>",
    ]);
    // First reply triggers close
    await continueDiscussConversation({
      ctx: { dataDir: sandbox.dataDir, client: slack.client, anthropic },
      channel: "C-INBOX",
      threadTs,
      userText: "I'm done thinking out loud",
      userId: "U123",
    });
    // Second reply should be ignored
    const slack2 = fakeSlackClient();
    const result = await continueDiscussConversation({
      ctx: {
        dataDir: sandbox.dataDir,
        client: slack2.client,
        anthropic: scriptedClient([]),
      },
      channel: "C-INBOX",
      threadTs,
      userText: "anyone there?",
      userId: "U123",
    });
    expect(result.status).toBe("closed");
    expect(slack2.posts).toHaveLength(0);
  });
});
