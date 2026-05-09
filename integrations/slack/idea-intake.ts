import Database from "better-sqlite3";
import type { WebClient } from "@slack/web-api";
import {
  IdeaIntakeError,
  runIdeaIntakeTurn,
  type DraftIdea,
  type TranscriptEntry,
} from "../../agents/idea-intake.ts";
import type { RunAgentTransport } from "../../orchestrator/agent-sdk-runtime.ts";
import {
  loadBusinessIdeas,
  saveBusinessIdeas,
  type BusinessIdea,
} from "../../orchestrator/business-ideas.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { dbFile } from "../../cli/paths.ts";

/**
 * Slack thread-based driver for `/jarvis ideas add`. Mirrors the
 * discuss adapter's persistence model: each thread reply triggers a
 * fresh handler invocation, so state is rebuilt from events rather
 * than held in memory.
 *
 * Three event kinds carry the conversation:
 *   - `idea-intake-started` — payload: `{ conversationId, vault,
 *     channel, threadTs, knownApps, firstAskText, firstAskKind }`.
 *     Written when the slash command opens the thread.
 *   - `idea-intake-message` — payload: `{ conversationId, role,
 *     text, skipped? }`. One per turn after the start event, in
 *     conversation order.
 *   - `idea-intake-closed` — terminal. Payload: `{ conversationId,
 *     outcome: "saved" | "abandoned", ideaId? }`.
 *
 * Reconstruction is a single ordered scan of the three event kinds.
 *
 * Acceptance protocol:
 *   - Plain replies become user transcript entries.
 *   - Empty reply or `/end` → user signals end; the model is asked to
 *     wrap up next turn with placeholders for missing fields.
 *   - `/skip` → recorded as a skipped user entry; agent infers the
 *     missing field and continues.
 */

export interface SlackIdeaIntakeContext {
  dataDir: string;
  client: WebClient;
  /** Optional fixed clock for tests. */
  now?: () => Date;
  /** Test injection — overrides the SDK transport for runIdeaIntakeTurn. */
  transport?: RunAgentTransport;
}

export interface IdeaIntakeStartedPayload {
  conversationId: string;
  vault: string;
  channel: string;
  threadTs: string;
  knownApps: string[];
  firstAskText: string;
  firstAskKind: "ask" | "followup";
}

export interface IdeaIntakeMessagePayload {
  conversationId: string;
  role: "agent" | "user";
  text: string;
  /** Set on user rows when the user typed /skip. */
  skipped?: boolean;
  /** Set on agent rows: which control tag the message came from. */
  kind?: "ask" | "followup";
}

export interface IdeaIntakeClosedPayload {
  conversationId: string;
  outcome: "saved" | "abandoned";
  ideaId?: string;
}

export interface IdeaIntakeConversationLookup {
  conversationId: string;
  vault: string;
  channel: string;
  threadTs: string;
  knownApps: string[];
  /** Full transcript in turn order, including the first agent ask. */
  transcript: TranscriptEntry[];
  closed: boolean;
}

export function findIdeaIntakeConversation(
  dataDir: string,
  channel: string,
  threadTs: string,
): IdeaIntakeConversationLookup | null {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const startedRows = db
      .prepare(
        "SELECT id, payload FROM events WHERE kind = 'idea-intake-started' ORDER BY id ASC",
      )
      .all() as Array<{ id: number; payload: string }>;
    let startedRow:
      | { id: number; payload: IdeaIntakeStartedPayload }
      | null = null;
    for (const r of startedRows) {
      try {
        const p = JSON.parse(r.payload) as IdeaIntakeStartedPayload;
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
        "SELECT payload FROM events WHERE kind = 'idea-intake-message' AND id > ? ORDER BY id ASC",
      )
      .all(startedRow.id) as Array<{ payload: string }>;

    const transcript: TranscriptEntry[] = [
      {
        role: "agent",
        text: startedRow.payload.firstAskText,
      },
    ];
    for (const m of messageRows) {
      try {
        const p = JSON.parse(m.payload) as IdeaIntakeMessagePayload;
        if (p.conversationId !== conversationId) continue;
        transcript.push({
          role: p.role,
          text: p.text,
          ...(p.skipped === true && { skipped: true }),
        });
      } catch {
        // skip malformed
      }
    }

    const closedRows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'idea-intake-closed' ORDER BY id ASC",
      )
      .all() as Array<{ payload: string }>;
    let closed = false;
    for (const r of closedRows) {
      try {
        const p = JSON.parse(r.payload) as IdeaIntakeClosedPayload;
        if (p.conversationId === conversationId) {
          closed = true;
          break;
        }
      } catch {
        // skip
      }
    }

    return {
      conversationId,
      vault: startedRow.payload.vault,
      channel: startedRow.payload.channel,
      threadTs: startedRow.payload.threadTs,
      knownApps: startedRow.payload.knownApps,
      transcript,
      closed,
    };
  } finally {
    db.close();
  }
}

/** Generates a stable conversation id `idea-<unix-ms>-<random>`. */
export function generateIdeaIntakeConversationId(now?: Date): string {
  const t = (now ?? new Date()).getTime();
  const r = Math.random().toString(36).slice(2, 8);
  return `idea-${t}-${r}`;
}

// ---------------------------------------------------------------------------
// Start: open a thread + post the first response
// ---------------------------------------------------------------------------

export interface StartIdeaIntakeInput {
  ctx: SlackIdeaIntakeContext;
  channel: string;
  vault: string;
  invokedBy: string;
}

export interface StartIdeaIntakeResult {
  conversationId: string;
  threadTs: string;
}

export async function startIdeaIntakeConversation(
  input: StartIdeaIntakeInput,
): Promise<StartIdeaIntakeResult> {
  const conversationId = generateIdeaIntakeConversationId(
    input.ctx.now ? input.ctx.now() : undefined,
  );

  const onboarded = listOnboardedApps(input.ctx.dataDir).filter(
    (a) => a.vault === input.vault,
  );
  const knownApps = onboarded.map((a) => a.app).sort();

  // 1. Post the topic message as the thread root for visual continuity.
  const rootMessage = await input.ctx.client.chat.postMessage({
    channel: input.channel,
    text:
      `:bulb: <@${input.invokedBy}> opened an idea-intake thread.\n` +
      `Reply in this thread to answer. Type \`/end\` to wrap up early, \`/skip\` to skip a question.`,
  });
  if (!rootMessage.ok || !rootMessage.ts) {
    throw new IdeaIntakeError(
      `chat.postMessage (root) failed: ${rootMessage.error ?? "unknown"}`,
    );
  }
  const threadTs = rootMessage.ts;

  // 2. Run the first turn (empty transcript, knownApps).
  const turn = await runIdeaIntakeTurn({
    transcript: [],
    knownApps,
    userSignaledEnd: false,
    ...(input.ctx.transport !== undefined && { transport: input.ctx.transport }),
  });
  if (turn.kind === "idea") {
    // The agent shouldn't emit <idea> on turn one — but if it does, treat as
    // saved-immediately so the thread doesn't become a zombie.
    await saveDraftAndClose({
      ctx: input.ctx,
      lookup: {
        conversationId,
        vault: input.vault,
        channel: input.channel,
        threadTs,
        knownApps,
        transcript: [],
        closed: false,
      },
      draft: turn.draft,
      invokedBy: input.invokedBy,
    });
    return { conversationId, threadTs };
  }

  // 3. Post the agent's first ask in the thread.
  await input.ctx.client.chat.postMessage({
    channel: input.channel,
    thread_ts: threadTs,
    text: turn.text,
  });

  // 4. Persist the started event.
  const startedPayload: IdeaIntakeStartedPayload = {
    conversationId,
    vault: input.vault,
    channel: input.channel,
    threadTs,
    knownApps,
    firstAskText: turn.text,
    firstAskKind: turn.kind,
  };
  const db = new Database(dbFile(input.ctx.dataDir));
  try {
    appendEvent(db, {
      appId: "ideas",
      vaultId: input.vault,
      kind: "idea-intake-started",
      payload: startedPayload,
    });
  } finally {
    db.close();
  }

  return { conversationId, threadTs };
}

// ---------------------------------------------------------------------------
// Continue: process a thread reply
// ---------------------------------------------------------------------------

export interface ContinueIdeaIntakeInput {
  ctx: SlackIdeaIntakeContext;
  channel: string;
  threadTs: string;
  userText: string;
  userId: string;
}

export interface ContinueIdeaIntakeResult {
  status: "not-our-thread" | "closed" | "continued" | "saved";
  ideaId?: string;
}

export async function continueIdeaIntakeConversation(
  input: ContinueIdeaIntakeInput,
): Promise<ContinueIdeaIntakeResult> {
  const lookup = findIdeaIntakeConversation(
    input.ctx.dataDir,
    input.channel,
    input.threadTs,
  );
  if (!lookup) return { status: "not-our-thread" };
  if (lookup.closed) return { status: "closed" };

  const trimmed = input.userText.trim();
  const lower = trimmed.toLowerCase();
  const isEnd = lower === "/end";
  const isSkip = lower === "/skip";

  // Append the user's reply to the transcript.
  const userEntry: TranscriptEntry = isSkip
    ? { role: "user", text: "", skipped: true }
    : isEnd
      ? { role: "user", text: "" } // recorded so the next-turn STATE shows the user's choice
      : { role: "user", text: trimmed };

  // Persist the user message before the LLM call so a crash mid-call
  // doesn't lose the reply.
  appendIdeaIntakeMessage(input.ctx.dataDir, lookup, {
    conversationId: lookup.conversationId,
    role: "user",
    text: userEntry.text,
    ...(userEntry.skipped === true && { skipped: true }),
  });

  const transcript = isEnd
    ? lookup.transcript // don't push the empty end-marker into the transcript
    : [...lookup.transcript, userEntry];

  const turn = await runIdeaIntakeTurn({
    transcript,
    knownApps: lookup.knownApps,
    userSignaledEnd: isEnd,
    ...(input.ctx.transport !== undefined && { transport: input.ctx.transport }),
  });

  if (turn.kind === "idea") {
    await saveDraftAndClose({
      ctx: input.ctx,
      lookup,
      draft: turn.draft,
      invokedBy: input.userId,
    });
    return { status: "saved", ideaId: slugify(turn.draft.title) };
  }

  // Post the agent's next question + persist.
  await input.ctx.client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text: turn.text,
  });
  appendIdeaIntakeMessage(input.ctx.dataDir, lookup, {
    conversationId: lookup.conversationId,
    role: "agent",
    text: turn.text,
    kind: turn.kind,
  });

  return { status: "continued" };
}

interface SaveDraftAndCloseInput {
  ctx: SlackIdeaIntakeContext;
  lookup: IdeaIntakeConversationLookup;
  draft: DraftIdea;
  invokedBy: string;
}

async function saveDraftAndClose(
  input: SaveDraftAndCloseInput,
): Promise<void> {
  // Append the new idea to Business_Ideas.md.
  const file = loadBusinessIdeas(input.ctx.dataDir);
  const newIdea = toBusinessIdea(input.draft, file.ideas);
  file.ideas.push(newIdea);
  saveBusinessIdeas(input.ctx.dataDir, file);

  // Confirm in the thread.
  const confirmText = [
    `:white_check_mark: Idea saved: *${newIdea.title}* → \`${newIdea.app}\``,
    `Brief: ${newIdea.brief}`,
    newIdea.tags.length > 0 ? `Tags: ${newIdea.tags.join(", ")}` : null,
    "",
    "_Run `/jarvis scout score` to score this and any other unscored ideas._",
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  await input.ctx.client.chat.postMessage({
    channel: input.lookup.channel,
    thread_ts: input.lookup.threadTs,
    text: confirmText,
  });

  // Persist: idea-added (audit trail for the new idea) + idea-intake-closed
  // (terminate the thread session). Both go through the same DB connection.
  const db = new Database(dbFile(input.ctx.dataDir));
  try {
    appendEvent(db, {
      appId: newIdea.app,
      vaultId: input.lookup.vault,
      kind: "idea-added",
      payload: {
        ideaId: newIdea.id,
        title: newIdea.title,
        app: newIdea.app,
        brief: newIdea.brief,
        tags: newIdea.tags,
        source: "slack-thread",
        actor: `slack:${input.invokedBy}`,
      },
    });
    appendEvent(db, {
      appId: "ideas",
      vaultId: input.lookup.vault,
      kind: "idea-intake-closed",
      payload: {
        conversationId: input.lookup.conversationId,
        outcome: "saved",
        ideaId: newIdea.id,
      },
    });
  } finally {
    db.close();
  }
}

function appendIdeaIntakeMessage(
  dataDir: string,
  lookup: IdeaIntakeConversationLookup,
  payload: IdeaIntakeMessagePayload,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: "ideas",
      vaultId: lookup.vault,
      kind: "idea-intake-message",
      payload,
    });
  } finally {
    db.close();
  }
}

function toBusinessIdea(
  draft: DraftIdea,
  existing: ReadonlyArray<BusinessIdea>,
): BusinessIdea {
  const baseId = slugify(draft.title);
  const id = uniqueId(
    baseId.length > 0 ? baseId : "idea",
    existing.map((e) => e.id),
  );
  return {
    id,
    title: draft.title,
    app: draft.app,
    brief: draft.brief,
    tags: draft.tags,
    body: draft.body,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueId(base: string, existing: ReadonlyArray<string>): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
