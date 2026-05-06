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
import { checkpointsDir, dbFile } from "../../cli/paths.ts";
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

function setupHarness(sandbox: InstallSandbox): Harness {
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
    getAnthropicClient: () => fakeAnthropicClient(),
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
      ]),
    );
    expect(new Set(fake.registeredViewIds())).toEqual(
      new Set([
        "plan_revise_submit",
        "setup_task_skip_submit",
        "post_skip_submit",
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
