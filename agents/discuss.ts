import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { brainExists, loadBrain } from "../orchestrator/brain.ts";
import {
  loadBusinessIdeas,
  saveBusinessIdeas,
  type BusinessIdea,
} from "../orchestrator/business-ideas.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { appendNote, notesContextBlock } from "../orchestrator/notes.ts";
import { appendSetupTask } from "../orchestrator/setup-tasks.ts";
import {
  brainFile,
  dbFile,
  repoRoot,
} from "../cli/paths.ts";
import {
  runStrategist,
  type Prompter,
  type StrategistResult,
} from "./strategist.ts";

/**
 * `discuss` — multi-turn co-owner conversation. The user opens with a
 * topic; Jarvis (the Strategist's voice by default, with the other
 * agents' perspectives folded in) thinks it through with them. The
 * conversation can land on a concrete artifact — plan, idea, note,
 * setup task — or just close without one.
 *
 * Orchestration: a single LLM call per turn, full conversation history
 * in context. The model emits exactly one of six XML blocks per turn
 * (`<continue>`, `<propose-plan>`, `<propose-idea>`, `<propose-note>`,
 * `<propose-setup-task>`, `<close>`); the parser maps that to a
 * `DiscussTurnResult`. When the model proposes, the runtime asks the
 * user to accept; on accept, the artifact is created and the session
 * closes. On reject + comment, the comment becomes the next user turn
 * and the conversation continues.
 *
 * Slack threading + multi-agent fan-out are deliberate follow-ups —
 * v1 is CLI-only, single voice.
 */

export interface DiscussInput {
  client: AnthropicClient;
  app: string;
  vault: string;
  dataDir: string;
  /** Opening message from the user. */
  topic: string;
  prompter: Prompter;
  /** Bound on LLM-call count; defaults to 20. */
  maxTurns?: number;
  /** Test seam — fixed clock for event timestamps + conversation id. */
  now?: Date;
}

export type DiscussOutcome = "plan" | "idea" | "note" | "setup-task" | "closed";

export interface DiscussResult {
  conversationId: string;
  /** Number of model turns consumed (LLM calls made). */
  turns: number;
  outcome: DiscussOutcome;
  /** Plan id, idea id, or setup-task id when applicable. */
  refId?: string;
}

export type DiscussTurnResult =
  | { kind: "continue"; text: string }
  | { kind: "propose-plan"; brief: string }
  | { kind: "propose-idea"; title: string; brief: string }
  | { kind: "propose-note"; text: string }
  | { kind: "propose-setup-task"; title: string; detail: string }
  | { kind: "close"; text: string };

/** A `<propose-*>` turn — the discriminated subset that requires an accept/reject decision. */
export type DiscussProposalTurn = Extract<
  DiscussTurnResult,
  | { kind: "propose-plan" }
  | { kind: "propose-idea" }
  | { kind: "propose-note" }
  | { kind: "propose-setup-task" }
>;

export class DiscussError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscussError";
  }
}

const DEFAULT_MAX_TURNS = 20;

/**
 * Drives the conversation end-to-end. Loops:
 *   1. Send conversation history → LLM → parse turn result.
 *   2. If `<continue>`: print, ask the user for the next message, append.
 *   3. If `<close>`: print, close the session with outcome "closed".
 *   4. If `<propose-*>`: print, ask the user to accept. On accept,
 *      execute the outcome handler and close. On reject (with optional
 *      comment), append the user comment + a "do not re-propose
 *      immediately, refine first" hint and continue.
 */
export async function runDiscuss(
  input: DiscussInput,
): Promise<DiscussResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const conversationId = generateConversationId(input.now);
  const systemPrompt = loadDiscussPrompt();

  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: buildInitialContextImpl(input) },
  ];

  recordEvent(input, conversationId, "conversation-started", {
    topic: input.topic,
  });

  let turns = 0;
  while (turns < maxTurns) {
    turns += 1;
    const response = await input.client.chat({
      system: systemPrompt,
      cacheSystem: true,
      messages: conversation,
    });
    const turn = parseDiscussResponse(response.text);
    conversation.push({ role: "assistant", content: response.text });

    if (turn.kind === "continue") {
      input.prompter.print(`\nJarvis: ${turn.text}\n`);
      const userReply = await input.prompter.ask("You: ");
      const trimmed = userReply.trim();
      if (trimmed.length === 0 || isQuitCommand(trimmed)) {
        recordEvent(input, conversationId, "conversation-closed", {
          outcome: "closed",
          reason: "user-quit",
          turns,
        });
        return { conversationId, turns, outcome: "closed" };
      }
      conversation.push({ role: "user", content: trimmed });
      continue;
    }

    if (turn.kind === "close") {
      input.prompter.print(`\nJarvis: ${turn.text}\n`);
      recordEvent(input, conversationId, "conversation-closed", {
        outcome: "closed",
        turns,
      });
      return { conversationId, turns, outcome: "closed" };
    }

    // Proposal — ask the user to accept.
    const accepted = await askToAccept(turn, input.prompter);
    if (accepted.kind === "accept") {
      const refId = await executeOutcome(turn, input, conversationId);
      recordEvent(input, conversationId, "conversation-closed", {
        outcome: outcomeFromTurn(turn),
        turns,
        ...(refId !== undefined && { refId }),
      });
      return {
        conversationId,
        turns,
        outcome: outcomeFromTurn(turn),
        ...(refId !== undefined && { refId }),
      };
    }
    // Rejection — fold the user's comment back in. The prompt instructs
    // the model not to immediately re-propose; treat reject as refine.
    conversation.push({
      role: "user",
      content: formatRejection(accepted.comment),
    });
  }

  recordEvent(input, conversationId, "conversation-closed", {
    outcome: "closed",
    reason: "max-turns",
    turns,
  });
  input.prompter.print(
    `\n(Hit max turns of ${maxTurns}. Closing without an artifact.)\n`,
  );
  return { conversationId, turns, outcome: "closed" };
}

// ---------------------------------------------------------------------------
// Stateless turn driver — the per-LLM-call primitive
// ---------------------------------------------------------------------------

export interface RunDiscussTurnInput {
  client: AnthropicClient;
  /** Full conversation so far, ending in a user message. */
  conversation: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface RunDiscussTurnOutput {
  /** Raw assistant text — append to the conversation as-is for the next call. */
  rawAssistantText: string;
  /** Parsed turn result. */
  turn: DiscussTurnResult;
}

/**
 * One LLM call. Pure function (no event recording, no I/O). The CLI
 * loop and the Slack thread handler both use this — each is responsible
 * for state persistence appropriate to its surface.
 */
export async function runDiscussTurn(
  input: RunDiscussTurnInput,
): Promise<RunDiscussTurnOutput> {
  const response = await input.client.chat({
    system: loadDiscussPrompt(),
    cacheSystem: true,
    messages: [...input.conversation],
  });
  const turn = parseDiscussResponse(response.text);
  return { rawAssistantText: response.text, turn };
}

// ---------------------------------------------------------------------------
// Initial context + canonical helpers (used by CLI + Slack)
// ---------------------------------------------------------------------------

export interface BuildInitialContextInput {
  app: string;
  vault: string;
  dataDir: string;
  topic: string;
}

/**
 * Renders the first user message that opens a discuss conversation:
 * project context (brain) + free-text notes + the user's topic. Both
 * the CLI loop and the Slack thread starter call this.
 */
export function buildDiscussInitialContext(
  input: BuildInitialContextInput,
): string {
  return buildInitialContextImpl(input);
}

/**
 * Stable, sortable conversation id. Format `discuss-YYYY-MM-DD-<8-hex>`.
 */
export function generateDiscussConversationId(now?: Date): string {
  return generateConversationId(now);
}

/**
 * Lifts a user's rejection comment into a next-turn instruction the
 * model is trained on (don't immediately re-propose; refine first).
 * Empty comment renders as a generic "not yet" instruction.
 */
export function formatDiscussRejection(comment: string): string {
  return formatRejection(comment);
}

// ---------------------------------------------------------------------------
// Outcome executor — surface-agnostic
// ---------------------------------------------------------------------------

export type DiscussOutcomeKind = Exclude<DiscussOutcome, "closed">;

export interface ExecuteDiscussOutcomeInput {
  turn: DiscussProposalTurn;
  client: AnthropicClient;
  app: string;
  vault: string;
  dataDir: string;
  conversationId: string;
  /** Test seam — fixed clock for any timestamps the outcome touches. */
  now?: Date;
}

export interface ExecuteDiscussOutcomeOutput {
  /** Plan id, idea id, or setup-task id; undefined for note. */
  refId?: string;
  /** Outcome label for events / surfaces. */
  outcome: DiscussOutcomeKind;
  /** Human-readable summary lines — CLI prints, Slack posts. */
  summary: string[];
}

/**
 * Executes the side effect for a `<propose-*>` turn. Pure function:
 * no I/O beyond writing the artifact (plan file / Business_Ideas.md /
 * notes / setup queue). Returns the result + a list of summary lines
 * for the calling surface to render.
 */
export async function executeDiscussOutcome(
  input: ExecuteDiscussOutcomeInput,
): Promise<ExecuteDiscussOutcomeOutput> {
  switch (input.turn.kind) {
    case "propose-plan": {
      const result = await runStrategist({
        client: input.client,
        brief: input.turn.brief,
        app: input.app,
        vault: input.vault,
        dataDir: input.dataDir,
        type: "improvement",
        challenge: false,
      });
      return {
        refId: result.planId,
        outcome: "plan",
        summary: [
          `✓ Drafted plan ${result.planId}`,
          `  Path: ${result.planPath}`,
          `  Review: yarn jarvis plans --pending-review (then approve / revise / reject)`,
        ],
      };
    }
    case "propose-idea": {
      const id = saveIdeaFromProposalRaw(
        input.turn.title,
        input.turn.brief,
        input.app,
        input.dataDir,
      );
      return {
        refId: id,
        outcome: "idea",
        summary: [
          `✓ Saved idea "${input.turn.title}" to Business_Ideas.md`,
          `  Score it: yarn jarvis scout score`,
        ],
      };
    }
    case "propose-note": {
      appendNote(input.dataDir, input.vault, input.app, {
        text: input.turn.text,
        actor: `discuss:${input.conversationId}`,
        ...(input.now !== undefined && { now: input.now }),
      });
      return {
        outcome: "note",
        summary: [`✓ Appended note to ${input.app}'s notes.md`],
      };
    }
    case "propose-setup-task": {
      const id = createSetupTaskRaw(
        input.turn.title,
        input.turn.detail,
        input.dataDir,
        input.conversationId,
        input.now,
      );
      return {
        refId: id,
        outcome: "setup-task",
        summary: [
          `✓ Created setup task "${input.turn.title}"`,
          `  See: yarn jarvis inbox`,
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Parser — XML block extraction
// ---------------------------------------------------------------------------

export function parseDiscussResponse(text: string): DiscussTurnResult {
  const close = text.match(/<close>([\s\S]*?)<\/close>/);
  if (close && close[1] !== undefined) {
    const body = close[1].trim();
    if (body.length === 0) throw new DiscussError("empty <close> block");
    return { kind: "close", text: body };
  }

  const plan = text.match(/<propose-plan>([\s\S]*?)<\/propose-plan>/);
  if (plan && plan[1] !== undefined) {
    const brief = plan[1].trim();
    if (brief.length === 0)
      throw new DiscussError("empty <propose-plan> block");
    return { kind: "propose-plan", brief };
  }

  const idea = text.match(/<propose-idea>([\s\S]*?)<\/propose-idea>/);
  if (idea && idea[1] !== undefined) {
    const fields = parseKeyedBlock(idea[1]);
    const title = fields.title;
    const brief = fields.brief;
    if (!title) throw new DiscussError("<propose-idea> missing `title:` line");
    if (!brief) throw new DiscussError("<propose-idea> missing `brief:` line");
    return { kind: "propose-idea", title, brief };
  }

  const note = text.match(/<propose-note>([\s\S]*?)<\/propose-note>/);
  if (note && note[1] !== undefined) {
    const body = note[1].trim();
    if (body.length === 0) throw new DiscussError("empty <propose-note> block");
    return { kind: "propose-note", text: body };
  }

  const setup = text.match(
    /<propose-setup-task>([\s\S]*?)<\/propose-setup-task>/,
  );
  if (setup && setup[1] !== undefined) {
    const fields = parseKeyedBlock(setup[1]);
    const title = fields.title;
    const detail = fields.detail;
    if (!title)
      throw new DiscussError("<propose-setup-task> missing `title:` line");
    if (!detail)
      throw new DiscussError("<propose-setup-task> missing `detail:` line");
    return { kind: "propose-setup-task", title, detail };
  }

  const cont = text.match(/<continue>([\s\S]*?)<\/continue>/);
  if (cont && cont[1] !== undefined) {
    const body = cont[1].trim();
    if (body.length === 0) throw new DiscussError("empty <continue> block");
    return { kind: "continue", text: body };
  }

  throw new DiscussError(
    `discuss response had no recognised block. First 200 chars: ${text.slice(0, 200)}`,
  );
}

/**
 * Parses `key: value` lines out of a propose-* block body. Values
 * starting on the `key:` line continue until the next `key:` line, so
 * detail blocks for setup tasks can span multiple lines.
 */
function parseKeyedBlock(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split("\n");
  let activeKey: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (activeKey !== null) {
      const value = buf.join("\n").trim();
      if (value.length > 0) out[activeKey] = value;
    }
    buf = [];
  };
  for (const raw of lines) {
    const m = raw.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (m) {
      flush();
      activeKey = m[1]!.toLowerCase();
      buf = m[2] !== undefined && m[2].length > 0 ? [m[2]] : [];
    } else {
      if (activeKey !== null) buf.push(raw);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance dialogue
// ---------------------------------------------------------------------------

interface AcceptResult {
  kind: "accept" | "reject";
  comment: string;
}

async function askToAccept(
  turn: Exclude<DiscussTurnResult, { kind: "continue" } | { kind: "close" }>,
  prompter: Prompter,
): Promise<AcceptResult> {
  prompter.print(`\nJarvis proposes: ${describeProposal(turn)}\n`);
  prompter.print(formatProposalBody(turn));
  const reply = (
    await prompter.ask("\nAccept? [y/N, or type a comment to refine]: ")
  ).trim();
  const lower = reply.toLowerCase();
  if (lower === "y" || lower === "yes") {
    return { kind: "accept", comment: "" };
  }
  if (lower === "" || lower === "n" || lower === "no") {
    return { kind: "reject", comment: "" };
  }
  // Treat any other text as a refinement comment.
  return { kind: "reject", comment: reply };
}

function describeProposal(
  turn: Exclude<DiscussTurnResult, { kind: "continue" } | { kind: "close" }>,
): string {
  switch (turn.kind) {
    case "propose-plan":
      return "draft a plan";
    case "propose-idea":
      return "save a business idea";
    case "propose-note":
      return "append a note";
    case "propose-setup-task":
      return "create a setup task";
  }
}

function formatProposalBody(
  turn: Exclude<DiscussTurnResult, { kind: "continue" } | { kind: "close" }>,
): string {
  switch (turn.kind) {
    case "propose-plan":
      return `  Brief: ${turn.brief}`;
    case "propose-idea":
      return `  Title: ${turn.title}\n  Brief: ${turn.brief}`;
    case "propose-note":
      return `  Note:\n${indent(turn.text, "    ")}`;
    case "propose-setup-task":
      return `  Title: ${turn.title}\n  Detail:\n${indent(turn.detail, "    ")}`;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatRejection(comment: string): string {
  if (comment.length === 0) {
    return "Not yet — keep discussing. Don't immediately re-propose; ask what's missing or wrong with the proposal.";
  }
  return [
    "Not yet — refine first based on this comment:",
    comment,
    "",
    "Don't immediately re-propose the same thing. Address the comment, ask if anything else is off, then either re-propose with the change or continue the discussion.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Outcome execution
// ---------------------------------------------------------------------------

async function executeOutcome(
  turn: DiscussProposalTurn,
  input: DiscussInput,
  conversationId: string,
): Promise<string | undefined> {
  const result = await executeDiscussOutcome({
    turn,
    client: input.client,
    app: input.app,
    vault: input.vault,
    dataDir: input.dataDir,
    conversationId,
    ...(input.now !== undefined && { now: input.now }),
  });
  for (const line of result.summary) {
    input.prompter.print(`\n${line}`);
  }
  return result.refId;
}

function saveIdeaFromProposalRaw(
  title: string,
  brief: string,
  app: string,
  dataDir: string,
): string {
  const file = loadBusinessIdeas(dataDir);
  const newIdea: BusinessIdea = {
    id: slugifyTitle(title),
    title,
    app,
    brief,
    tags: [],
    body: "",
  };
  let id = newIdea.id;
  if (file.ideas.some((i) => i.id === id)) {
    let suffix = 2;
    while (file.ideas.some((i) => i.id === `${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }
  file.ideas.push({ ...newIdea, id });
  saveBusinessIdeas(dataDir, file);
  return id;
}

function createSetupTaskRaw(
  title: string,
  detail: string,
  dataDir: string,
  conversationId: string,
  now?: Date,
): string {
  const id = `${slugifyTitle(title)}-${conversationId.slice(0, 8)}`;
  const createdAt = (now ?? new Date()).toISOString();
  appendSetupTask(dataDir, {
    id,
    title,
    detail,
    createdAt,
    source: { kind: "discuss", refId: conversationId },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Context + helpers
// ---------------------------------------------------------------------------

function buildInitialContextImpl(input: BuildInitialContextInput): string {
  const lines: string[] = [];
  lines.push(`App: ${input.app}`);
  lines.push(`Vault: ${input.vault}`);
  lines.push("");

  const brainPath = brainFile(input.dataDir, input.vault, input.app);
  if (brainExists(brainPath)) {
    try {
      const brain = loadBrain(brainPath);
      lines.push("Project context (brain):");
      lines.push(`- name: ${brain.projectName}`);
      lines.push(`- type: ${brain.projectType}`);
      lines.push(`- status: ${brain.projectStatus}`);
      lines.push(`- priority: ${brain.projectPriority}`);
      if (brain.userPreferences.areasOfInterest?.length) {
        lines.push(
          `- areasOfInterest: ${brain.userPreferences.areasOfInterest.join(", ")}`,
        );
      }
      if (brain.userPreferences.areasToAvoid?.length) {
        lines.push(
          `- areasToAvoid: ${brain.userPreferences.areasToAvoid.join(", ")}`,
        );
      }
      lines.push("");
    } catch {
      // Tolerate brains we can't parse — don't block the conversation.
    }
  } else {
    lines.push(
      "(No brain on file for this app — discussion can still proceed; just don't fabricate project facts.)",
    );
    lines.push("");
  }

  const notes = notesContextBlock(input.dataDir, input.vault, input.app);
  if (notes !== null) {
    lines.push(notes);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Topic from the user:");
  lines.push(input.topic);
  return lines.join("\n");
}

function recordEvent(
  input: DiscussInput,
  conversationId: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const file = dbFile(input.dataDir);
  if (!fs.existsSync(file)) return;
  const db = new Database(file);
  try {
    appendEvent(db, {
      appId: input.app,
      vaultId: input.vault,
      kind,
      payload: { conversationId, ...payload },
      ...(input.now !== undefined && { createdAt: input.now.toISOString() }),
    });
  } finally {
    db.close();
  }
}

function outcomeFromTurn(
  turn: Exclude<DiscussTurnResult, { kind: "continue" } | { kind: "close" }>,
): DiscussOutcome {
  switch (turn.kind) {
    case "propose-plan":
      return "plan";
    case "propose-idea":
      return "idea";
    case "propose-note":
      return "note";
    case "propose-setup-task":
      return "setup-task";
  }
}

function generateConversationId(now?: Date): string {
  const stamp = (now ?? new Date()).toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString("hex");
  return `discuss-${stamp}-${rand}`;
}

function slugifyTitle(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function isQuitCommand(s: string): boolean {
  const l = s.toLowerCase();
  return l === "/quit" || l === "/exit" || l === "/done";
}

let cachedPrompt: string | undefined;
function loadDiscussPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(repoRoot(), "prompts", "discuss.md"),
    "utf8",
  );
  return cachedPrompt;
}
