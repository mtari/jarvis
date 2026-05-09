import fs from "node:fs";
import path from "node:path";
import {
  runAgent,
  type RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { repoRoot as defaultRepoRoot } from "../cli/paths.ts";
import {
  type IntakeIO,
  type IntakeProgress,
} from "./intake.ts";

export class IdeaIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaIntakeError";
  }
}

export interface DraftIdea {
  title: string;
  app: string;
  brief: string;
  tags: string[];
  body: string;
}

export interface IdeaIntakeAgentInput {
  /** App ids the user has already onboarded — surfaced in STATE so the agent
   * can pick a known app id (or `new`) for the `App:` field. */
  knownApps: ReadonlyArray<string>;
  io: IntakeIO;
  /** cwd for the SDK call. Doesn't matter much — agent has no Read tool. */
  cwd?: string;
  maxRounds?: number;
  transport?: RunAgentTransport;
  model?: string;
}

export interface IdeaIntakeAgentResult {
  idea: DraftIdea;
  totalRounds: number;
  finishedCleanly: boolean;
}

const DEFAULT_MAX_ROUNDS = 50;

const PROMPT_PATH = "prompts/strategist-idea-intake.md";

let cachedPrompt: string | null = null;
function loadPrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(defaultRepoRoot(), PROMPT_PATH),
    "utf8",
  );
  return cachedPrompt;
}

interface ParsedIdeaTurn {
  ask?: string;
  followup?: string;
  idea?: DraftIdea;
}

const ASK_PATTERN = /<ask\b[^>]*>([\s\S]*?)<\/ask>/;
const FOLLOWUP_PATTERN = /<followup\b[^>]*>([\s\S]*?)<\/followup>/;
const IDEA_PATTERN = /<idea\b[^>]*>([\s\S]*?)<\/idea>/;

export function parseIdeaTurn(text: string): ParsedIdeaTurn {
  const out: ParsedIdeaTurn = {};
  const ask = text.match(ASK_PATTERN);
  if (ask?.[1]) out.ask = ask[1].trim();
  const followup = text.match(FOLLOWUP_PATTERN);
  if (followup?.[1]) out.followup = followup[1].trim();
  const idea = text.match(IDEA_PATTERN);
  if (idea?.[1]) {
    const draft = parseIdeaBlock(idea[1]);
    if (draft !== undefined) out.idea = draft;
  }
  return out;
}

/**
 * Parses the body of an `<idea>` block. The format is a small header of
 * `Key: value` lines (Title, App, Brief, Tags), then a blank line, then
 * free-form prose body. Returns `undefined` when required fields are
 * missing — the orchestrator surfaces that as an IdeaIntakeError.
 */
export function parseIdeaBlock(body: string): DraftIdea | undefined {
  const lines = body.split(/\r?\n/);
  let title: string | undefined;
  let app: string | undefined;
  let brief: string | undefined;
  let tags: string[] = [];
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" && (title !== undefined || app !== undefined)) {
      bodyStart = i + 1;
      break;
    }
    const m = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "title") title = value;
    else if (key === "app") app = value;
    else if (key === "brief") brief = value;
    else if (key === "tags") {
      tags = value
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
    }
  }

  if (title === undefined || app === undefined || brief === undefined) {
    return undefined;
  }
  const ideaBody =
    bodyStart >= 0 ? lines.slice(bodyStart).join("\n").trim() : "";
  return { title, app, brief, tags, body: ideaBody };
}

export interface TranscriptEntry {
  role: "agent" | "user";
  /** For agent rows, the question text (from <ask> / <followup>).
   * For user rows, the verbatim reply. */
  text: string;
  /** Set on user rows when the user typed /skip — so the agent can see
   * which questions the user explicitly skipped. */
  skipped?: boolean;
}

interface IdeaIntakeState {
  transcript: TranscriptEntry[];
  userSignaledEnd: boolean;
}

export function buildIdeaIntakeUserPrompt(args: {
  transcript: ReadonlyArray<TranscriptEntry>;
  knownApps: ReadonlyArray<string>;
  userSignaledEnd: boolean;
}): string {
  return buildUserPrompt(
    { transcript: [...args.transcript], userSignaledEnd: args.userSignaledEnd },
    args.knownApps,
    args.transcript.length === 0,
  );
}

function buildUserPrompt(
  state: IdeaIntakeState,
  knownApps: ReadonlyArray<string>,
  isFirstTurn: boolean,
): string {
  const lines: string[] = [];
  lines.push("STATE");
  lines.push(`- known apps: [${knownApps.join(", ")}]`);
  if (state.userSignaledEnd) {
    lines.push(
      `- user signaled end: true (emit <idea> now with what you have; use placeholders for missing required fields)`,
    );
  }

  if (isFirstTurn || state.transcript.length === 0) {
    lines.push(`- transcript: (none — this is the first turn)`);
  } else {
    lines.push("");
    lines.push(
      "TRANSCRIPT — every question you've asked and every reply you've heard. Build on this; don't re-ask what's already been answered.",
    );
    lines.push("");
    let askCounter = 0;
    for (const entry of state.transcript) {
      if (entry.role === "agent") {
        askCounter += 1;
        lines.push(`Q${askCounter}: ${entry.text.trim()}`);
      } else {
        if (entry.skipped) {
          lines.push(`A${askCounter}: (user skipped — make your best inference and don't re-ask)`);
        } else {
          lines.push(`A${askCounter}: ${entry.text.trim()}`);
        }
      }
    }
  }
  return lines.join("\n");
}

export type IdeaIntakeTurnResult =
  | { kind: "ask"; text: string }
  | { kind: "followup"; text: string }
  | { kind: "idea"; draft: DraftIdea };

export interface IdeaIntakeTurnInput {
  /** Conversation history: every prior <ask>/<followup> + every reply. */
  transcript: ReadonlyArray<TranscriptEntry>;
  knownApps: ReadonlyArray<string>;
  /** Set true when the user just typed /end or hit Ctrl-D (the agent
   * should wrap up with an <idea> block). */
  userSignaledEnd: boolean;
  cwd?: string;
  transport?: RunAgentTransport;
  model?: string;
}

/**
 * Runs ONE turn of the idea-intake conversation. Stateless — the caller
 * passes the entire transcript so this works in both the CLI loop
 * (sync prompter) and Slack threads (async, event-driven, state in DB).
 *
 * Returns one of three outcomes: a new `<ask>`, a `<followup>`, or the
 * final `<idea>`. Throws IdeaIntakeError if the agent emits something
 * else, the SDK fails, or the <idea> block is missing required fields.
 */
export async function runIdeaIntakeTurn(
  input: IdeaIntakeTurnInput,
): Promise<IdeaIntakeTurnResult> {
  const systemPrompt = loadPrompt();
  const userPrompt = buildIdeaIntakeUserPrompt({
    transcript: input.transcript,
    knownApps: input.knownApps,
    userSignaledEnd: input.userSignaledEnd,
  });
  const result = await runAgent({
    systemPrompt,
    userPrompt,
    cwd: input.cwd ?? defaultRepoRoot(),
    maxTurns: 60,
    toolPreset: { kind: "none" },
    ...(input.model !== undefined && { model: input.model }),
    ...(input.transport !== undefined && { transport: input.transport }),
  });

  if (result.subtype !== "success") {
    throw new IdeaIntakeError(
      `idea-intake agent failed: ${result.subtype}` +
        (result.errors.length > 0 ? ` — ${result.errors.join("; ")}` : ""),
    );
  }

  const parsed = parseIdeaTurn(result.text);
  if (parsed.idea !== undefined) {
    return { kind: "idea", draft: parsed.idea };
  }
  if (parsed.ask !== undefined) {
    return { kind: "ask", text: parsed.ask };
  }
  if (parsed.followup !== undefined) {
    return { kind: "followup", text: parsed.followup };
  }
  throw new IdeaIntakeError(
    `agent emitted no <ask>, <followup>, or <idea>. First 200 chars: ${result.text.slice(0, 200)}`,
  );
}

/**
 * Runs the conversational idea-intake loop. The agent walks the user
 * through 5–6 cluster questions, then emits one `<idea>` block. The
 * caller is responsible for persisting the returned `DraftIdea` (e.g.
 * appending it to Business_Ideas.md).
 */
export async function runIdeaIntakeAgent(
  input: IdeaIntakeAgentInput,
): Promise<IdeaIntakeAgentResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const cwd = input.cwd ?? defaultRepoRoot();

  const state: IdeaIntakeState = {
    transcript: [],
    userSignaledEnd: false,
  };

  let round = 0;
  let idea: DraftIdea | undefined;

  while (round < maxRounds) {
    round += 1;
    const turn = await runIdeaIntakeTurn({
      transcript: state.transcript,
      knownApps: input.knownApps,
      userSignaledEnd: state.userSignaledEnd,
      cwd,
      ...(input.model !== undefined && { model: input.model }),
      ...(input.transport !== undefined && { transport: input.transport }),
    });

    if (turn.kind === "idea") {
      idea = turn.draft;
      input.io.writeOutput(
        `\n✓ Idea captured: "${idea.title}" → ${idea.app}\n`,
      );
      break;
    }

    const next = turn.text;
    state.transcript.push({ role: "agent", text: next });

    const progress: IntakeProgress = {
      round,
      // Ideas don't have multi-section progress, so the counters stay 0.
      answered: 0,
      partial: 0,
      skipped: 0,
    };

    const answer = await input.io.readUserAnswer({
      sectionId: "idea",
      text: next,
      isFollowup: turn.kind === "followup",
      progress,
    });

    if (answer.kind === "end") {
      state.userSignaledEnd = true;
      continue;
    }
    if (answer.kind === "skip") {
      state.transcript.push({ role: "user", text: "", skipped: true });
      continue;
    }
    state.transcript.push({ role: "user", text: answer.text });
  }

  if (idea === undefined) {
    throw new IdeaIntakeError(
      `idea-intake reached maxRounds (${maxRounds}) without emitting <idea>`,
    );
  }

  return {
    idea,
    totalRounds: round,
    finishedCleanly: !state.userSignaledEnd,
  };
}
