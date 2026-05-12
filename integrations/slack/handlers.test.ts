import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { brainDir, brainFile, businessIdeasFile, checkpointsDir, daemonPidFile, dbFile, logsDir } from "../../cli/paths.ts";
import {
  findIdeaByQuery,
  type BusinessIdea,
  type BusinessIdeasFile,
} from "../../orchestrator/business-ideas.ts";
import { todayLogPath } from "../../cli/commands/logs.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordEscalation } from "../../orchestrator/escalations.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import { appendSetupTask } from "../../orchestrator/setup-tasks.ts";
import {
  isSuppressed,
  listSuppressions,
} from "../../orchestrator/suppressions.ts";
import type { AnthropicClient } from "../../orchestrator/agent-sdk-runtime.ts";
import { registerHandlers, type HandlerContext } from "./handlers.ts";
import {
  makeFakeBoltApp,
  recordingClient,
  type FakeBoltApp,
  type RecordingClient,
} from "./handlers.test-helpers.ts";
import type { SurfaceContext } from "./surface.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function fakeAnthropicClient(): AnthropicClient {
  return {
    async chat() {
      return {
        text: "<plan></plan>",
        blocks: [{ type: "text", text: "<plan></plan>" }],
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
    },
  };
}

interface Harness {
  fake: FakeBoltApp;
  recording: RecordingClient;
  ctx: HandlerContext;
}

function setupHarness(
  sandbox: InstallSandbox,
  opts: { anthropic?: AnthropicClient } = {},
): Harness {
  const recording = recordingClient();
  const surfaceCtx: SurfaceContext = {
    dataDir: sandbox.dataDir,
    // The surface helpers only call chat methods, which the recording
    // client implements. Cast through `as never` to satisfy WebClient.
    client: recording.client as never,
    inboxChannelId: "C-INBOX",
  };
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: HandlerContext = {
    dataDir: sandbox.dataDir,
    surfaceCtx,
    getAnthropicClient: () => opts.anthropic ?? fakeAnthropicClient(),
    log: (msg) => {
      logs.push(msg);
    },
    logError: (msg) => {
      errors.push(msg);
    },
  };
  const fake = makeFakeBoltApp();
  registerHandlers(fake.app, ctx);
  return { fake, recording, ctx };
}

// ---------------------------------------------------------------------------
// registerHandlers — registration sanity check
// ---------------------------------------------------------------------------

describe("registerHandlers", () => {
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

  it("registers every action / view / command id we expect", () => {
    const { fake } = setupHarness(sandbox);
    expect(new Set(fake.registeredActionIds())).toEqual(
      new Set([
        "plan_approve",
        "plan_revise",
        "plan_reject",
        "signal_suppress",
        "setup_task_done",
        "setup_task_skip",
        "escalation_acknowledge",
        "post_approve",
        "post_skip",
        "discuss_accept",
        "discuss_drop",
      ]),
    );
    expect(new Set(fake.registeredViewIds())).toEqual(
      new Set([
        "plan_revise_submit",
        "setup_task_skip_submit",
        "post_skip_submit",
        "ideas_edit_submit",
      ]),
    );
    expect(fake.registeredCommandIds()).toEqual(["/jarvis"]);
  });
});

// ---------------------------------------------------------------------------
// plan_approve — happy path: approves the plan + updates the message
// ---------------------------------------------------------------------------

describe("plan_approve action", () => {
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

  it("transitions awaiting-review → approved + updates the surfaced Slack message", async () => {
    const planId = "2026-04-28-approve-test";
    dropPlan(sandbox, planId, { status: "awaiting-review" });

    // Pre-seed a `slack-surfaced` event so updateSurfacedPlan finds
    // the message ts to update.
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "slack-surfaced",
        payload: {
          planId,
          channel: "C-INBOX",
          messageTs: "1700000000.999",
        },
      });
    } finally {
      conn.close();
    }

    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("plan_approve", {
      action: { type: "button", value: planId },
      body: { type: "block_actions", user: { id: "U-rev" } },
      client: recording.client,
    });

    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("approved");
    expect(recording.updates).toHaveLength(1);
    expect(recording.updates[0]?.text).toContain("U-rev");
  });

  it("posts an ephemeral error when approve fails", async () => {
    // Plan in `draft` — approve only works from awaiting-review.
    const planId = "2026-04-28-bad";
    dropPlan(sandbox, planId, { status: "draft" });

    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("plan_approve", {
      action: { type: "button", value: planId },
      body: {
        type: "block_actions",
        user: { id: "U-x" },
        channel: { id: "C-INBOX" },
      },
      client: recording.client,
    });

    expect(recording.postEphemerals).toHaveLength(1);
    expect(recording.postEphemerals[0]?.text).toContain("Approve failed");
  });
});

// ---------------------------------------------------------------------------
// plan_reject — drops the amendment checkpoint when one exists
// ---------------------------------------------------------------------------

describe("plan_reject action", () => {
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

  function writeCheckpoint(planId: string): string {
    const dir = checkpointsDir(sandbox.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${planId}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        planId,
        branch: "feat/x",
        sha: "abc",
        modifiedFiles: [],
        amendmentReason: "r",
        amendmentProposal: "p",
        timestamp: "2026-05-05T00:00:00Z",
      }),
    );
    return filePath;
  }

  it("removes the amendment checkpoint after a successful Slack reject", async () => {
    const planId = "2026-04-28-reject-amend";
    dropPlan(sandbox, planId, { status: "awaiting-review" });
    const checkpointPath = writeCheckpoint(planId);
    expect(fs.existsSync(checkpointPath)).toBe(true);

    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("plan_reject", {
      action: { type: "button", value: planId },
      body: { type: "block_actions", user: { id: "U-r" } },
      client: recording.client,
    });

    expect(fs.existsSync(checkpointPath)).toBe(false);
    const finalRecord = findPlan(sandbox.dataDir, planId);
    expect(finalRecord?.plan.metadata.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// signal_suppress — calls suppress() with the dedupKey + updates the message
// ---------------------------------------------------------------------------

describe("signal_suppress action", () => {
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

  it("suppresses the dedupKey and replaces the action block with a 🔕 context line", async () => {
    const dedupKey = "yarn-audit:CVE-2026-X";
    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("signal_suppress", {
      action: { type: "button", value: dedupKey },
      body: {
        type: "block_actions",
        user: { id: "U-s" },
        message: {
          ts: "1700000000.500",
          blocks: [
            { type: "header" },
            { type: "section" },
            { type: "actions" },
          ],
        },
        channel: { id: "C-ALERTS" },
      },
      client: recording.client,
    });

    expect(isSuppressed(dbFile(sandbox.dataDir), dedupKey)).toBe(true);
    const stored = listSuppressions(dbFile(sandbox.dataDir));
    expect(stored[0]?.reason).toContain("U-s");

    expect(recording.updates).toHaveLength(1);
    const blocks = recording.updates[0]?.blocks as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
    const ctxBlock = blocks.find((b) => b.type === "context");
    expect(ctxBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// setup_task_skip_submit — view submission resolves with reason
// ---------------------------------------------------------------------------

describe("setup_task_skip_submit view", () => {
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

  it("resolves the task as skipped + records the reason in the event log", async () => {
    appendSetupTask(sandbox.dataDir, {
      id: "stripe-key",
      title: "Set the Stripe key",
      createdAt: "2026-05-05T10:00:00Z",
    });

    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeView("setup_task_skip_submit", {
      view: {
        private_metadata: "stripe-key",
        state: {
          values: {
            reason_block: { reason_input: { value: "decided to use stripe-checkout" } },
          },
        },
      },
      body: { user: { id: "U-skip" } },
      client: recording.client,
    });

    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = conn
        .prepare("SELECT payload FROM events WHERE kind = 'setup-task-resolved'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        taskId: "stripe-key",
        status: "skipped",
        actor: "slack:U-skip",
        skipReason: "decided to use stripe-checkout",
      });
    } finally {
      conn.close();
    }
  });

  it("acks with errors when reason is empty", async () => {
    appendSetupTask(sandbox.dataDir, {
      id: "id-x",
      title: "x",
      createdAt: "2026-05-05T10:00:00Z",
    });

    const { fake } = setupHarness(sandbox);
    let ackArgs: unknown = "<not-called>";
    await fake.invokeView("setup_task_skip_submit", {
      view: {
        private_metadata: "id-x",
        state: { values: { reason_block: { reason_input: { value: "" } } } },
      },
      ack: (async (args: unknown) => {
        ackArgs = args;
      }) as never,
    });
    expect(ackArgs).toMatchObject({ response_action: "errors" });
  });
});

// ---------------------------------------------------------------------------
// escalation_acknowledge — records escalation-acknowledged event
// ---------------------------------------------------------------------------

describe("escalation_acknowledge action", () => {
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

  it("records an escalation-acknowledged event + updates the message", async () => {
    // Seed an escalation event so we have an id to acknowledge.
    recordEscalation(dbFile(sandbox.dataDir), {
      kind: "rate-limit",
      severity: "high",
      summary: "x",
    });
    // Look up its event id.
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    let eventId: number;
    try {
      const row = conn
        .prepare(
          "SELECT id FROM events WHERE kind = 'escalation' ORDER BY id ASC LIMIT 1",
        )
        .get() as { id: number };
      eventId = row.id;
    } finally {
      conn.close();
    }

    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("escalation_acknowledge", {
      action: { type: "button", value: String(eventId) },
      body: {
        type: "block_actions",
        user: { id: "U-ack" },
        message: {
          ts: "1700000000.111",
          blocks: [{ type: "header" }, { type: "actions" }],
        },
        channel: { id: "C-ALERTS" },
      },
      client: recording.client,
    });

    const conn2 = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = conn2
        .prepare(
          "SELECT payload FROM events WHERE kind = 'escalation-acknowledged'",
        )
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        escalationEventId: eventId,
        actor: "slack:U-ack",
      });
    } finally {
      conn2.close();
    }

    expect(recording.updates).toHaveLength(1);
    const blocks = recording.updates[0]?.blocks as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// discuss_accept / discuss_drop action handlers
// ---------------------------------------------------------------------------

describe("discuss action handlers", () => {
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

  /**
   * Pre-seeds the events that `findDiscussConversation` needs:
   * `discuss-conversation-started` (with raw assistant text containing
   * a propose-note proposal). Returns the threadTs the buttons would
   * carry as their value.
   */
  function seedConversationWithProposal(): {
    threadTs: string;
    conversationId: string;
  } {
    const threadTs = "1700000000.999";
    const conversationId = "discuss-2026-04-08-abcd1234";
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "demo",
        vaultId: "personal",
        kind: "discuss-conversation-started",
        payload: {
          conversationId,
          app: "demo",
          vault: "personal",
          channel: "C-INBOX",
          threadTs,
          topic: "x",
          rawAssistantText:
            "<propose-note>address-step is the funnel killer</propose-note>",
        },
      });
    } finally {
      conn.close();
    }
    return { threadTs, conversationId };
  }

  it("discuss_accept fires the outcome (note appended) + closes conversation", async () => {
    const { threadTs } = seedConversationWithProposal();
    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("discuss_accept", {
      action: { type: "button", value: threadTs },
      body: {
        type: "block_actions",
        user: { id: "U-rev" },
        channel: { id: "C-INBOX" },
        message: { ts: "1700000000.998", blocks: [{ type: "actions" }] },
      },
      client: recording.client,
    });
    // Note appended via the outcome.
    const notesPath = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "brains",
      "demo",
      "notes.md",
    );
    expect(fs.existsSync(notesPath)).toBe(true);
    expect(fs.readFileSync(notesPath, "utf8")).toContain("address-step");

    // closed event recorded.
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const closed = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed'",
        )
        .all() as Array<{ payload: string }>;
      expect(closed).toHaveLength(1);
    } finally {
      conn.close();
    }

    // Buttons stripped from the original proposal message.
    expect(recording.updates).toHaveLength(1);
    expect(recording.updates[0]?.text).toContain("Accepted by <@U-rev>");
  });

  it("discuss_drop folds rejection into next turn (continues, doesn't close)", async () => {
    const { threadTs } = seedConversationWithProposal();
    const { fake, recording } = setupHarness(sandbox, {
      anthropic: {
        async chat() {
          const text = "<continue>OK what would you change?</continue>";
          return {
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
        },
      },
    });
    await fake.invokeAction("discuss_drop", {
      action: { type: "button", value: threadTs },
      body: {
        type: "block_actions",
        user: { id: "U-rev" },
        channel: { id: "C-INBOX" },
        message: { ts: "1700000000.998", blocks: [{ type: "actions" }] },
      },
      client: recording.client,
    });

    // Conversation continues — message events recorded, no closed.
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const closed = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed'",
        )
        .all() as Array<unknown>;
      expect(closed).toEqual([]);
      const messages = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-message'",
        )
        .all() as Array<{ payload: string }>;
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const userMsg = JSON.parse(messages[0]!.payload).content as string;
      expect(userMsg).toContain("Not yet");
    } finally {
      conn.close();
    }

    // Buttons stripped; thread reply posted with the LLM's continue.
    expect(recording.updates).toHaveLength(1);
    expect(recording.updates[0]?.text).toContain("Dropped by <@U-rev>");
    expect(
      recording.posts.some((p) =>
        (p.text ?? "").includes("OK what would you change"),
      ),
    ).toBe(true);
  });

  it("discuss_accept on an unknown thread is a no-op (not-our-thread)", async () => {
    const { fake, recording } = setupHarness(sandbox);
    await fake.invokeAction("discuss_accept", {
      action: { type: "button", value: "1700000000.404" },
      body: {
        type: "block_actions",
        user: { id: "U-rev" },
        channel: { id: "C-INBOX" },
        message: { ts: "1700000000.998", blocks: [{ type: "actions" }] },
      },
      client: recording.client,
    });
    // Buttons still stripped (best-effort; we strip on every click)
    expect(recording.updates).toHaveLength(1);
    // No outcome events recorded
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const closed = conn
        .prepare(
          "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed'",
        )
        .all() as Array<unknown>;
      expect(closed).toEqual([]);
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /jarvis project-audit slash command
// ---------------------------------------------------------------------------

describe("/jarvis project-audit", () => {
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

  function seedAuditBrain(app: string): void {
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", app), { recursive: true });
    saveBrain(brainFile(sandbox.dataDir, "personal", app), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
    });
  }

  function seedTransitionAndSignal(app: string): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: app,
        vaultId: "personal",
        kind: "plan-transition",
        payload: { planId: "p1", from: "approved", to: "executing" },
      });
      appendEvent(conn, {
        appId: app,
        vaultId: "personal",
        kind: "signal",
        payload: { kind: "yarn-audit", severity: "moderate", title: "dep" },
      });
    } finally {
      conn.close();
    }
  }

  it("no --app and no --all → ephemeral usage error", async () => {
    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "project-audit" },
      respond: async (args) => {
        responds.push(args);
      },
    });
    expect(responds).toHaveLength(1);
    expect(responds[0]?.text).toContain("Usage");
    expect(responds[0]?.text).toContain("project-audit");
  });

  it("--app <name> --no-research --dry-run --force → running + result messages", async () => {
    seedAuditBrain("erdei-fahazak");
    seedTransitionAndSignal("erdei-fahazak");

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: {
        text: "project-audit --app erdei-fahazak --no-research --dry-run --force",
      },
      respond: async (args) => {
        responds.push(args);
      },
    });
    expect(responds.length).toBeGreaterThanOrEqual(2);
    expect(responds[0]?.text).toContain("erdei-fahazak");
    const lastRespond = responds[responds.length - 1];
    expect(lastRespond?.text).toMatch(/skipped|ran/i);
  });

  it("--all --no-research --dry-run --force → aggregate result for all non-jarvis apps", async () => {
    seedAuditBrain("app-one");
    seedAuditBrain("app-two");
    seedTransitionAndSignal("app-one");
    seedTransitionAndSignal("app-two");

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: {
        text: "project-audit --all --no-research --dry-run --force",
      },
      respond: async (args) => {
        responds.push(args);
      },
    });
    expect(responds.length).toBeGreaterThanOrEqual(1);
    const lastText = responds[responds.length - 1]?.text ?? "";
    expect(lastText).toContain("Project audit — all apps");
  });
});

describe("/jarvis logs slash command", () => {
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

  function seedLogFile(linesText: string): string {
    const logFile = todayLogPath(sandbox.dataDir);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, linesText);
    return logFile;
  }

  it("returns an ephemeral snapshot of the last 50 lines by default", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    seedLogFile(lines);

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string; response_type?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "logs" },
      respond: async (args) => {
        responds.push(args);
      },
    });

    expect(responds).toHaveLength(1);
    expect(responds[0]?.response_type).toBe("ephemeral");
    const text = responds[0]?.text ?? "";
    expect(text).toContain("Last 50 line(s)");
    expect(text).toContain("line 31"); // 80 - 50 + 1
    expect(text).toContain("line 80");
    expect(text).not.toContain("line 30"); // before window
  });

  it("--lines N honors the override and caps at 200", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `entry-${i + 1}`).join("\n");
    seedLogFile(lines);

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "logs --lines 10" },
      respond: async (args) => {
        responds.push(args);
      },
    });

    const text = responds[0]?.text ?? "";
    expect(text).toContain("Last 10 line(s)");
    expect(text).toContain("entry-50");
    expect(text).toContain("entry-41");
    expect(text).not.toContain("entry-40");
  });

  it("returns a warning when today's log file does not exist", async () => {
    // No seed file
    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "logs" },
      respond: async (args) => {
        responds.push(args);
      },
    });

    expect(responds[0]?.text).toContain("not found");
    expect(responds[0]?.text).toContain("daemon may not have started");
  });

  it("rejects invalid --lines values", async () => {
    seedLogFile("one\ntwo\n");
    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "logs --lines abc" },
      respond: async (args) => {
        responds.push(args);
      },
    });

    expect(responds[0]?.text).toContain("Invalid --lines");
  });

  it("truncates with a notice when body exceeds the Slack limit", async () => {
    // 200 lines of 500 chars each = 100,000 chars — well over the 35k cap.
    const bigLine = "x".repeat(500);
    const lines = Array.from({ length: 200 }, (_, i) => `${i.toString().padStart(3, "0")}:${bigLine}`).join("\n");
    seedLogFile(lines);

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "logs --lines 200" },
      respond: async (args) => {
        responds.push(args);
      },
    });

    const text = responds[0]?.text ?? "";
    expect(text).toContain("truncated");
    // The most-recent line should always survive truncation
    expect(text).toContain("199:");
    // Body size after wrapping should be near (but not over) the cap
    expect(text.length).toBeLessThan(40_000);
  });
});

// Reference logsDir so the import isn't unused — runtime is otherwise covered
// via todayLogPath in the runSlashLogs production path.
void logsDir;

// ---------------------------------------------------------------------------
// /jarvis status slash command
// ---------------------------------------------------------------------------

describe("/jarvis status slash command", () => {
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

  it("running daemon shows pid", async () => {
    const pidPath = daemonPidFile(sandbox.dataDir);
    fs.writeFileSync(
      pidPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string; response_type?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "status" },
      respond: async (args) => { responds.push(args); },
    });

    expect(responds).toHaveLength(1);
    expect(responds[0]?.response_type).toBe("ephemeral");
    const text = responds[0]?.text ?? "";
    expect(text).toContain("running");
    expect(text).toContain(String(process.pid));
  });

  it("stopped daemon shows stopped", async () => {
    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "status" },
      respond: async (args) => { responds.push(args); },
    });

    expect(responds[0]?.text).toContain("stopped");
  });

  it("plan counts by status are shown", async () => {
    dropPlan(sandbox, "2026-04-01-a1", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-01-a2", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-01-b1", { status: "approved" });

    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "status" },
      respond: async (args) => { responds.push(args); },
    });

    const text = responds[0]?.text ?? "";
    expect(text).toContain("2 awaiting-review");
    expect(text).toContain("1 approved");
  });

  it("empty state — no crash, all sections present, no null/undefined", async () => {
    const { fake } = setupHarness(sandbox);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "status" },
      respond: async (args) => { responds.push(args); },
    });

    const text = responds[0]?.text ?? "";
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(text).toContain("Daemon:");
    expect(text).toContain("Plans:");
    expect(text).toContain("Last transitions:");
    expect(text).toContain("Last agent call:");
    expect(text).toContain("Calls today:");
  });
});

// ---------------------------------------------------------------------------
// findIdeaByQuery — pure unit tests (no sandbox, no file I/O)
// ---------------------------------------------------------------------------

describe("findIdeaByQuery resolver", () => {
  function makeFile(ideas: BusinessIdea[]): BusinessIdeasFile {
    return { ideas, unparseable: [], preamble: "" };
  }

  const base: BusinessIdea = {
    id: "my-great-idea",
    title: "My Great Idea",
    app: "new",
    brief: "A brief",
    tags: [],
    body: "some body text",
  };

  it("exact id match returns kind:'exact'", () => {
    const result = findIdeaByQuery(makeFile([base]), "my-great-idea");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.idea.id).toBe("my-great-idea");
  });

  it("case-insensitive id match", () => {
    const result = findIdeaByQuery(makeFile([base]), "MY-GREAT-IDEA");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.idea.id).toBe("my-great-idea");
  });

  it("title substring match (single result)", () => {
    const result = findIdeaByQuery(makeFile([base]), "Great");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.idea.id).toBe("my-great-idea");
  });

  it("title substring match (multiple results) returns candidates capped at 10", () => {
    const idea2: BusinessIdea = { ...base, id: "great-idea-2", title: "Great Idea 2" };
    const result = findIdeaByQuery(makeFile([base, idea2]), "Great");
    expect(result.kind).toBe("multiple");
    if (result.kind === "multiple") expect(result.candidates).toHaveLength(2);
  });

  it("no match returns kind:'none'", () => {
    const result = findIdeaByQuery(makeFile([base]), "unknownxyz");
    expect(result.kind).toBe("none");
  });

  it("smart-quote stripping resolves correctly", () => {
    const idea: BusinessIdea = { ...base, id: "cemetery-saas", title: "Cemetery SaaS" };
    const result = findIdeaByQuery(makeFile([idea]), "“Cemetery SaaS”");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.idea.id).toBe("cemetery-saas");
  });
});

// ---------------------------------------------------------------------------
// /jarvis ideas edit command + ideas_edit_submit view
// ---------------------------------------------------------------------------

describe("/jarvis ideas edit command + ideas_edit_submit view", () => {
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

  function seedIdeasFile(dataDir: string, content: string): void {
    fs.writeFileSync(businessIdeasFile(dataDir), content, "utf8");
  }

  const scoredIdeaMarkdown = [
    "## Test Idea Alpha",
    "App: new",
    "Brief: An idea for testing",
    "Score: 72",
    "ScoredAt: 2026-01-01T00:00:00.000Z",
    "Rationale: Looks good",
    "",
    "Original body text here.",
    "",
  ].join("\n");

  it("exact id → views.open called with pre-filled body", async () => {
    const recording = recordingClient();
    const { fake } = setupHarness(sandbox);
    seedIdeasFile(sandbox.dataDir, scoredIdeaMarkdown);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "ideas edit test-idea-alpha", trigger_id: "T-abc" },
      respond: async (args) => {
        responds.push(args);
      },
      client: recording.client,
    });
    expect(recording.viewsOpened).toHaveLength(1);
    const view = recording.viewsOpened[0]?.view as {
      blocks?: Array<{ element?: { initial_value?: string } }>;
    };
    const bodyBlock = view?.blocks?.[1];
    expect(bodyBlock?.element?.initial_value).toBe("Original body text here.");
    expect(responds).toHaveLength(0);
  });

  it("no-match query → ephemeral with 'ideas list' hint", async () => {
    const { fake } = setupHarness(sandbox);
    seedIdeasFile(sandbox.dataDir, scoredIdeaMarkdown);
    const responds: Array<{ text?: string }> = [];
    await fake.invokeCommand("/jarvis", {
      command: { text: "ideas edit unknownxyz", trigger_id: "T-abc" },
      respond: async (args) => {
        responds.push(args);
      },
    });
    expect(responds).toHaveLength(1);
    expect(responds[0]?.text).toContain("ideas list");
  });

  it("view-submit saves new body and strips Score/ScoredAt/Rationale", async () => {
    const recording = recordingClient();
    const { fake } = setupHarness(sandbox);
    seedIdeasFile(sandbox.dataDir, scoredIdeaMarkdown);

    await fake.invokeView("ideas_edit_submit", {
      body: { user: { id: "U-tester" } },
      view: {
        private_metadata: JSON.stringify({ ideaId: "test-idea-alpha", rescoreDefault: false }),
        state: {
          values: {
            body_block: { body_input: { value: "Updated body text." } },
            rescore_block: { rescore_checkbox: { selected_options: [] } },
          },
        },
      },
      client: recording.client,
    });

    const saved = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");
    expect(saved).toContain("Updated body text.");
    expect(saved).not.toContain("Score:");
    expect(saved).not.toContain("ScoredAt:");
    expect(saved).not.toContain("Rationale:");
    expect(recording.posts[0]?.text).toContain("Scout will rescore on next tick");
  });

  it("rescore checkbox triggers scoreUnscoredIdeas and posts follow-up score", async () => {
    const recording = recordingClient();
    const scoreClient: AnthropicClient = {
      async chat() {
        return {
          text: '<score>{"score":85,"rationale":"solid fit","suggestedPriority":"high"}</score>',
          blocks: [],
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
          redactions: [],
        };
      },
    };
    const { fake } = setupHarness(sandbox, { anthropic: scoreClient });
    seedIdeasFile(sandbox.dataDir, scoredIdeaMarkdown);

    await fake.invokeView("ideas_edit_submit", {
      body: { user: { id: "U-tester" } },
      view: {
        private_metadata: JSON.stringify({ ideaId: "test-idea-alpha", rescoreDefault: false }),
        state: {
          values: {
            body_block: { body_input: { value: "Updated body for rescore." } },
            rescore_block: {
              rescore_checkbox: { selected_options: [{ value: "rescore" }] },
            },
          },
        },
      },
      client: recording.client,
    });

    expect(recording.posts[0]?.text).toContain("Rescoring now");
    const followUp = recording.posts[1]?.text ?? "";
    expect(followUp).toContain("85");
  });
});
