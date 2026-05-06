import Database from "better-sqlite3";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import {
  buildDiscussInitialContext,
  DiscussError,
  executeDiscussOutcome,
  formatDiscussRejection,
  generateDiscussConversationId,
  parseDiscussResponse,
  runDiscussTurn,
  type DiscussProposalTurn,
  type DiscussTurnResult,
  type RunDiscussTurnInput,
} from "../../agents/discuss.ts";
import type { AnthropicClient } from "../../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { dbFile } from "../../cli/paths.ts";

/**
 * Slack thread-based driver for `/jarvis discuss`. The CLI version
 * (agents/discuss.ts → runDiscuss) uses a sync prompter loop. Slack
 * is event-driven — each user message in the thread triggers a fresh
 * `app.message` handler invocation, so state has to be persisted
 * between messages.
 *
 * Persistence model: events. Three event kinds carry the full thread
 * state:
 *   - `discuss-conversation-started` — payload includes
 *     `{ conversationId, app, vault, channel, threadTs, topic,
 *        rawAssistantText }`. Written when the slash command opens
 *     the thread.
 *   - `discuss-conversation-message` — payload includes
 *     `{ conversationId, role, content }`. One per turn after the
 *     start event, in conversation order. The `content` for an
 *     assistant message is the raw model text (with the XML tags).
 *   - `discuss-conversation-closed` — terminal. Payload includes
 *     `{ conversationId, outcome, refId? }`.
 *
 * Reconstruction is a single ordered scan of all three event kinds.
 *
 * Acceptance protocol: when the previous assistant turn was a
 * `<propose-*>`, the next user message is interpreted as the
 * accept/reject decision per the same protocol the CLI uses:
 *   - `y` / `yes` / `accept` → execute the proposal, close.
 *   - `n` / `no` / empty → silent reject, conversation continues.
 *   - anything else → reject with comment, fold into next turn.
 */

export interface SlackDiscussContext {
  dataDir: string;
  client: WebClient;
  anthropic: AnthropicClient;
  /** Optional fixed clock for tests. */
  now?: () => Date;
}

interface ConversationStartedPayload {
  conversationId: string;
  app: string;
  vault: string;
  channel: string;
  threadTs: string;
  topic: string;
  rawAssistantText: string;
}

interface ConversationMessagePayload {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
}

interface ConversationClosedPayload {
  conversationId: string;
  outcome: string;
  refId?: string;
}

export interface DiscussConversationLookup {
  conversationId: string;
  app: string;
  vault: string;
  channel: string;
  threadTs: string;
  /** Full conversation in send order. Includes the system-built initial context as msg #1. */
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  closed: boolean;
  /** True when the most recent assistant message was a `<propose-*>` block. */
  awaitingDecision: boolean;
  /** Set when awaitingDecision is true. */
  pendingProposal?: DiscussProposalTurn;
}

/**
 * Looks up an active discuss conversation by Slack channel + thread.
 * Returns null when no started event matches (likely a thread not
 * owned by us). Returns the lookup with `closed: true` when a closed
 * event exists; the caller should ignore additional thread replies.
 */
export function findDiscussConversation(
  dataDir: string,
  channel: string,
  threadTs: string,
): DiscussConversationLookup | null {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const startedRows = db
      .prepare(
        "SELECT id, payload FROM events WHERE kind = 'discuss-conversation-started' ORDER BY id ASC",
      )
      .all() as Array<{ id: number; payload: string }>;
    let startedRow:
      | { id: number; payload: ConversationStartedPayload }
      | null = null;
    for (const r of startedRows) {
      try {
        const p = JSON.parse(r.payload) as ConversationStartedPayload;
        if (p.channel === channel && p.threadTs === threadTs) {
          startedRow = { id: r.id, payload: p };
        }
      } catch {
        // skip malformed
      }
    }
    if (!startedRow) return null;

    const conversationId = startedRow.payload.conversationId;
    const messageRows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'discuss-conversation-message' AND id > ? ORDER BY id ASC",
      )
      .all(startedRow.id) as Array<{ payload: string }>;

    // The first user message in the LLM conversation is the initial
    // context (rebuilt from the started payload) — it's not stored as
    // a discuss-conversation-message event.
    const conversation: Array<{ role: "user" | "assistant"; content: string }> =
      [
        {
          role: "user",
          content: rebuildInitialContext(dataDir, startedRow.payload),
        },
        {
          role: "assistant",
          content: startedRow.payload.rawAssistantText,
        },
      ];
    for (const m of messageRows) {
      try {
        const p = JSON.parse(m.payload) as ConversationMessagePayload;
        if (p.conversationId !== conversationId) continue;
        conversation.push({ role: p.role, content: p.content });
      } catch {
        // skip malformed
      }
    }

    const closedRows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'discuss-conversation-closed' ORDER BY id ASC",
      )
      .all() as Array<{ payload: string }>;
    let closed = false;
    for (const r of closedRows) {
      try {
        const p = JSON.parse(r.payload) as ConversationClosedPayload;
        if (p.conversationId === conversationId) {
          closed = true;
          break;
        }
      } catch {
        // skip
      }
    }

    // Determine whether the most recent assistant message was a proposal.
    const lastAssistant = [...conversation].reverse().find(
      (m) => m.role === "assistant",
    );
    let pendingProposal: DiscussProposalTurn | undefined;
    if (lastAssistant) {
      try {
        const parsed = parseLastAssistantTurn(lastAssistant.content);
        if (
          parsed.kind === "propose-plan" ||
          parsed.kind === "propose-idea" ||
          parsed.kind === "propose-note" ||
          parsed.kind === "propose-setup-task"
        ) {
          pendingProposal = parsed;
        }
      } catch {
        // Last message wasn't parseable as a turn — treat as no pending proposal.
      }
    }

    return {
      conversationId,
      app: startedRow.payload.app,
      vault: startedRow.payload.vault,
      channel: startedRow.payload.channel,
      threadTs: startedRow.payload.threadTs,
      conversation,
      closed,
      awaitingDecision: pendingProposal !== undefined,
      ...(pendingProposal !== undefined && { pendingProposal }),
    };
  } finally {
    db.close();
  }
}

function rebuildInitialContext(
  dataDir: string,
  payload: ConversationStartedPayload,
): string {
  return buildDiscussInitialContext({
    app: payload.app,
    vault: payload.vault,
    dataDir,
    topic: payload.topic,
  });
}

function parseLastAssistantTurn(text: string): DiscussTurnResult {
  return parseDiscussResponse(text);
}

// ---------------------------------------------------------------------------
// Start: open a thread + post the first response
// ---------------------------------------------------------------------------

export interface StartDiscussInput {
  ctx: SlackDiscussContext;
  channel: string;
  app: string;
  vault: string;
  topic: string;
  /** Slack user id who invoked the slash command — written into events. */
  invokedBy: string;
}

export interface StartDiscussResult {
  conversationId: string;
  threadTs: string;
}

/**
 * Posts the topic + Jarvis's first response as a thread in `channel`.
 * Records `discuss-conversation-started` with the assistant's raw
 * text so subsequent replies can reconstruct the conversation.
 */
export async function startDiscussConversation(
  input: StartDiscussInput,
): Promise<StartDiscussResult> {
  const conversationId = generateDiscussConversationId(
    input.ctx.now ? input.ctx.now() : undefined,
  );
  const initialContext = buildDiscussInitialContext({
    app: input.app,
    vault: input.vault,
    dataDir: input.ctx.dataDir,
    topic: input.topic,
  });
  const conversation: RunDiscussTurnInput["conversation"] = [
    { role: "user", content: initialContext },
  ];

  // Step 1: post the user's topic as the thread root, so the thread
  // exists and the user has visual continuity.
  const rootMessage = await input.ctx.client.chat.postMessage({
    channel: input.channel,
    text: `:speech_balloon: <@${input.invokedBy}> opened a discuss session for *${input.app}*: _${input.topic}_`,
  });
  if (!rootMessage.ok || !rootMessage.ts) {
    throw new DiscussError(
      `chat.postMessage (root) failed: ${rootMessage.error ?? "unknown"}`,
    );
  }
  const threadTs = rootMessage.ts;

  // Step 2: run the first turn.
  const first = await runDiscussTurn({
    client: input.ctx.anthropic,
    conversation,
  });

  // Step 3: render + post Jarvis's reply in the thread.
  const renderedReply = renderTurnForSlack(first.turn, threadTs);
  await input.ctx.client.chat.postMessage({
    channel: input.channel,
    thread_ts: threadTs,
    text: renderedReply.text,
    ...(renderedReply.blocks !== undefined && {
      blocks: renderedReply.blocks as never,
    }),
  });

  // Step 4: persist the conversation start event.
  const startedPayload: ConversationStartedPayload = {
    conversationId,
    app: input.app,
    vault: input.vault,
    channel: input.channel,
    threadTs,
    topic: input.topic,
    rawAssistantText: first.rawAssistantText,
  };
  const db = new Database(dbFile(input.ctx.dataDir));
  try {
    appendEvent(db, {
      appId: input.app,
      vaultId: input.vault,
      kind: "discuss-conversation-started",
      payload: startedPayload,
    });
    if (first.turn.kind === "close") {
      appendEvent(db, {
        appId: input.app,
        vaultId: input.vault,
        kind: "discuss-conversation-closed",
        payload: {
          conversationId,
          outcome: "closed",
          reason: "first-turn-close",
        },
      });
    }
  } finally {
    db.close();
  }

  return { conversationId, threadTs };
}

// ---------------------------------------------------------------------------
// Continue: process a thread reply
// ---------------------------------------------------------------------------

export interface ContinueDiscussInput {
  ctx: SlackDiscussContext;
  channel: string;
  threadTs: string;
  /** The user's message text (already de-mentioned, etc.). */
  userText: string;
  /** Slack user id of the replier. */
  userId: string;
}

export interface ContinueDiscussResult {
  /**
   * `not-our-thread`: no started event matches. Caller ignores.
   * `closed`: thread is already closed. Caller ignores.
   * `continued`: a new assistant message was posted.
   * `accepted`: a pending proposal was accepted; outcome executed.
   */
  status: "not-our-thread" | "closed" | "continued" | "accepted";
  /** Set when status === "accepted". */
  outcome?: string;
  /** Set when status === "accepted" and the outcome produced an artifact id. */
  refId?: string;
}

const ACCEPT_TOKENS = new Set(["y", "yes", "accept", "ok"]);
const REJECT_TOKENS = new Set(["n", "no", "skip", "drop"]);

export async function continueDiscussConversation(
  input: ContinueDiscussInput,
): Promise<ContinueDiscussResult> {
  const lookup = findDiscussConversation(
    input.ctx.dataDir,
    input.channel,
    input.threadTs,
  );
  if (!lookup) return { status: "not-our-thread" };
  if (lookup.closed) return { status: "closed" };

  const trimmed = input.userText.trim();

  // Acceptance check — only when the prior assistant turn was a proposal.
  if (lookup.awaitingDecision && lookup.pendingProposal) {
    const lower = trimmed.toLowerCase();
    if (ACCEPT_TOKENS.has(lower)) {
      const result = await executeDiscussOutcome({
        turn: lookup.pendingProposal,
        client: input.ctx.anthropic,
        app: lookup.app,
        vault: lookup.vault,
        dataDir: input.ctx.dataDir,
        conversationId: lookup.conversationId,
        ...(input.ctx.now !== undefined && { now: input.ctx.now() }),
      });
      await input.ctx.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: [`Accepted by <@${input.userId}>.`, ...result.summary].join("\n"),
      });
      const db = new Database(dbFile(input.ctx.dataDir));
      try {
        appendEvent(db, {
          appId: lookup.app,
          vaultId: lookup.vault,
          kind: "discuss-conversation-message",
          payload: {
            conversationId: lookup.conversationId,
            role: "user",
            content: trimmed,
          },
        });
        appendEvent(db, {
          appId: lookup.app,
          vaultId: lookup.vault,
          kind: "discuss-conversation-closed",
          payload: {
            conversationId: lookup.conversationId,
            outcome: result.outcome,
            ...(result.refId !== undefined && { refId: result.refId }),
            actor: `slack:${input.userId}`,
          },
        });
      } finally {
        db.close();
      }
      return {
        status: "accepted",
        outcome: result.outcome,
        ...(result.refId !== undefined && { refId: result.refId }),
      };
    }
    // Reject: append a rejection-as-refinement instruction instead of
    // the user's literal text, so the model knows to address-not-repropose.
    const rejectionContent =
      lower.length === 0 || REJECT_TOKENS.has(lower)
        ? formatDiscussRejection("")
        : formatDiscussRejection(trimmed);
    return processNextTurn(
      input,
      lookup,
      rejectionContent,
      /* recordRawText */ trimmed,
    );
  }

  // Plain continuation: append the user's literal text + run a turn.
  return processNextTurn(input, lookup, trimmed, trimmed);
}

async function processNextTurn(
  input: ContinueDiscussInput,
  lookup: DiscussConversationLookup,
  contentForLlm: string,
  contentForRecord: string,
): Promise<ContinueDiscussResult> {
  const conversation: RunDiscussTurnInput["conversation"] = [
    ...lookup.conversation,
    { role: "user", content: contentForLlm },
  ];
  const result = await runDiscussTurn({
    client: input.ctx.anthropic,
    conversation,
  });
  const rendered = renderTurnForSlack(result.turn, input.threadTs);
  await input.ctx.client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text: rendered.text,
    ...(rendered.blocks !== undefined && {
      blocks: rendered.blocks as never,
    }),
  });

  const db = new Database(dbFile(input.ctx.dataDir));
  try {
    appendEvent(db, {
      appId: lookup.app,
      vaultId: lookup.vault,
      kind: "discuss-conversation-message",
      payload: {
        conversationId: lookup.conversationId,
        role: "user",
        // Persist what the LLM actually saw — that way reconstruction
        // gives the same conversation history on re-load.
        content: contentForLlm,
      },
    });
    appendEvent(db, {
      appId: lookup.app,
      vaultId: lookup.vault,
      kind: "discuss-conversation-message",
      payload: {
        conversationId: lookup.conversationId,
        role: "assistant",
        content: result.rawAssistantText,
      },
    });
    if (result.turn.kind === "close") {
      appendEvent(db, {
        appId: lookup.app,
        vaultId: lookup.vault,
        kind: "discuss-conversation-closed",
        payload: {
          conversationId: lookup.conversationId,
          outcome: "closed",
          reason: "model-close",
          actor: `slack:${input.userId}`,
        },
      });
    }
  } finally {
    db.close();
  }
  void contentForRecord; // reserved for future analytics (literal user text vs LLM prompt)
  return { status: "continued" };
}

// ---------------------------------------------------------------------------
// Slack rendering
// ---------------------------------------------------------------------------

interface RenderedTurn {
  text: string;
  /**
   * Block Kit blocks for proposal turns (so the user can click Accept
   * or Drop instead of typing y/n). Continue / close turns are
   * text-only — undefined.
   */
  blocks?: KnownBlock[];
}

/**
 * Builds Block Kit blocks for a proposal turn — header / section /
 * actions row with two buttons (Accept primary, Drop danger). The
 * action `value` is the thread_ts so the handler can route by
 * `(channel, thread_ts)` via `findDiscussConversation`.
 *
 * Refinement text is still supported via plain replies in the thread —
 * the buttons are an additional fast path for the common y/n case.
 */
function buildProposalBlocks(args: {
  threadTs: string;
  headerText: string;
  bodyText: string;
}): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${args.headerText}*\n${args.bodyText}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Accept", emoji: true },
          style: "primary",
          action_id: "discuss_accept",
          value: args.threadTs,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Drop", emoji: true },
          style: "danger",
          action_id: "discuss_drop",
          value: args.threadTs,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Or reply with refinement text to keep the conversation going._",
        },
      ],
    },
  ];
}

function renderTurnForSlack(
  turn: DiscussTurnResult,
  threadTs: string,
): RenderedTurn {
  switch (turn.kind) {
    case "continue":
      return { text: turn.text };
    case "close":
      return { text: `_(closing thread)_ ${turn.text}` };
    case "propose-plan":
      return {
        text: `Proposed plan — ${turn.brief.slice(0, 80)}`,
        blocks: buildProposalBlocks({
          threadTs,
          headerText: "Proposed plan",
          bodyText: turn.brief,
        }),
      };
    case "propose-idea":
      return {
        text: `Proposed idea: ${turn.title}`,
        blocks: buildProposalBlocks({
          threadTs,
          headerText: `Proposed idea: ${turn.title}`,
          bodyText: turn.brief,
        }),
      };
    case "propose-note":
      return {
        text: `Proposed note — ${turn.text.slice(0, 80)}`,
        blocks: buildProposalBlocks({
          threadTs,
          headerText: "Proposed note",
          bodyText: turn.text,
        }),
      };
    case "propose-setup-task":
      return {
        text: `Proposed setup task: ${turn.title}`,
        blocks: buildProposalBlocks({
          threadTs,
          headerText: `Proposed setup task: ${turn.title}`,
          bodyText: turn.detail,
        }),
      };
  }
}
