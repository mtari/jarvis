import fs from "node:fs";
import path from "node:path";
import {
  runAgent,
  type RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { repoRoot as defaultRepoRoot } from "../cli/paths.ts";

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export type SectionStatus = "answered" | "partial" | "skipped";

export interface IntakeSection {
  id: string;
  status: SectionStatus;
  body: string;
}

export interface IntakeProgress {
  /** Round number, 1-based — i.e. how many turns have been issued so far. */
  round: number;
  answered: number;
  partial: number;
  skipped: number;
}

export interface IntakeQuestion {
  sectionId: string;
  text: string;
  /** True when this is a `<followup>`, false when it's a fresh `<ask>`. */
  isFollowup: boolean;
  progress: IntakeProgress;
}

export type UserAnswer =
  | { kind: "answer"; text: string }
  | { kind: "skip" }
  | { kind: "end" };

export interface IntakeIO {
  /**
   * Display the agent's question to the user, then read the user's answer.
   * Returns:
   *   - `{ kind: "answer", text }` for a normal answer
   *   - `{ kind: "skip" }` when the user asks to skip the current section
   *   - `{ kind: "end" }` on Ctrl-D / EOF, or when the user asks to wrap up
   */
  readUserAnswer: (question: IntakeQuestion) => Promise<UserAnswer>;
  /** Free-form output (status messages, the agent's `<done>` summary). */
  writeOutput: (text: string) => void;
}

export interface IntakeAgentInput {
  app: string;
  repoRoot: string;
  io: IntakeIO;
  /** Absolute path where the running intake markdown is persisted. */
  intakeFilePath: string;
  maxRounds?: number;
  transport?: RunAgentTransport;
  model?: string;
}

export interface IntakeAgentResult {
  sections: IntakeSection[];
  totalRounds: number;
  /** True when the agent emitted `<done>`. False when capped by maxRounds or stdin EOF. */
  finishedCleanly: boolean;
  /** Markdown content written to `intakeFilePath`. */
  content: string;
  /** Optional summary the agent wrote in its `<done>` block. */
  doneSummary?: string;
}

// Effectively no cap — the user controls termination via /end or Ctrl-D.
// Kept as a runaway-loop guard, not a budget.
const DEFAULT_MAX_ROUNDS = 500;

const PROMPT_PATH = "prompts/strategist-intake.md";

let cachedPrompt: string | null = null;
function loadIntakePrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(defaultRepoRoot(), PROMPT_PATH),
    "utf8",
  );
  return cachedPrompt;
}

interface ParsedTurn {
  saves: Array<{ sectionId: string; status: SectionStatus; body: string }>;
  ask?: { sectionId: string; text: string };
  followup?: { sectionId: string; text: string };
  done?: { summary: string };
}

const TAG_PATTERN =
  /<(ask|save|followup|done)(\s+[^>]*?)?>([\s\S]*?)<\/\1>/g;

function parseAttr(attrs: string | undefined, name: string): string | undefined {
  if (!attrs) return undefined;
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

export function parseAgentTurn(text: string): ParsedTurn {
  const out: ParsedTurn = { saves: [] };
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = match[1] ?? "";
    const attrs = match[2];
    const body = (match[3] ?? "").trim();
    if (tag === "ask") {
      out.ask = { sectionId: parseAttr(attrs, "sectionId") ?? "", text: body };
    } else if (tag === "followup") {
      out.followup = {
        sectionId: parseAttr(attrs, "sectionId") ?? "",
        text: body,
      };
    } else if (tag === "save") {
      const rawStatus = parseAttr(attrs, "status") ?? "answered";
      const status: SectionStatus =
        rawStatus === "partial" || rawStatus === "skipped"
          ? rawStatus
          : "answered";
      out.saves.push({
        sectionId: parseAttr(attrs, "sectionId") ?? "",
        status,
        body,
      });
    } else if (tag === "done") {
      out.done = { summary: body };
    }
  }
  return out;
}

interface IntakeState {
  answered: string[];
  partial: string[];
  skipped: string[];
  lastAsked?: string;
  lastUserMessage: string;
  audience?: string;
  userSignaledEnd: boolean;
  /** Status per saved sectionId — used when rendering the PRIOR ANSWERS
   * block so each section is shown with its current status. */
  savedStatuses: Map<string, SectionStatus>;
}

function buildUserPrompt(
  state: IntakeState,
  input: { app: string; repoRoot: string },
  isFirstTurn: boolean,
  collected: ReadonlyArray<IntakeSection>,
): string {
  const lines: string[] = [];
  lines.push(`Project app id: ${input.app}`);
  lines.push(`Repo root: ${input.repoRoot}`);
  lines.push("");
  lines.push("STATE");
  lines.push(`- audience: ${state.audience ?? "unknown"}`);
  lines.push(`- answered: [${state.answered.join(", ")}]`);
  lines.push(`- partial: [${state.partial.join(", ")}]`);
  lines.push(`- skipped: [${state.skipped.join(", ")}]`);
  lines.push(`- last asked: ${state.lastAsked ?? "none"}`);

  if (state.userSignaledEnd) {
    lines.push(
      `- user signaled end: true (save what's collected, mark remaining required as partial with "Gap: not collected", emit <done>)`,
    );
  }

  if (collected.length > 0) {
    lines.push("");
    lines.push(
      "PRIOR ANSWERS — full bodies of every section already saved. Build on these.",
    );
    lines.push(
      "If a later answer changes the picture for an earlier section (e.g. user reveals a different segment, contradicts a prior fact, refines a number), emit a fresh <save> for that earlier section in the same turn — multiple <save> blocks per turn are allowed. Don't re-ask sections you've already heard.",
    );
    lines.push("");
    for (const section of collected) {
      const tag =
        section.status === "answered"
          ? ""
          : ` (${section.status})`;
      lines.push(`### ${section.id}${tag}`);
      lines.push(section.body.trim());
      lines.push("");
    }
  }

  lines.push("");
  if (isFirstTurn) {
    lines.push(`LAST USER MESSAGE: (none — this is the first turn)`);
  } else {
    lines.push(`LAST USER MESSAGE: ${quoteMultiline(state.lastUserMessage)}`);
  }
  return lines.join("\n");
}

function quoteMultiline(s: string): string {
  if (s.length === 0) return '""';
  if (!s.includes("\n")) return `"${s.replace(/"/g, '\\"')}"`;
  return "<<<\n" + s + "\n>>>";
}

function applyTurn(
  state: IntakeState,
  parsed: ParsedTurn,
  collected: IntakeSection[],
): void {
  for (const save of parsed.saves) {
    if (!save.sectionId) continue;
    const existing = collected.findIndex((s) => s.id === save.sectionId);
    const section: IntakeSection = {
      id: save.sectionId,
      status: save.status,
      body: save.body,
    };
    if (existing >= 0) {
      collected[existing] = section;
    } else {
      collected.push(section);
    }
    state.answered = state.answered.filter((id) => id !== save.sectionId);
    state.partial = state.partial.filter((id) => id !== save.sectionId);
    state.skipped = state.skipped.filter((id) => id !== save.sectionId);
    if (save.status === "answered") state.answered.push(save.sectionId);
    else if (save.status === "partial") state.partial.push(save.sectionId);
    else state.skipped.push(save.sectionId);

    state.savedStatuses.set(save.sectionId, save.status);

    if (
      save.sectionId === "audience-and-context" &&
      state.audience === undefined
    ) {
      state.audience = sniffAudience(save.body);
    }
  }
}

function sniffAudience(body: string): string {
  const haystack = body.toLowerCase();
  const hits: string[] = [];
  if (/\binvestors?\b|\bvc\b|\bfunding\b|\braise\b/.test(haystack)) hits.push("investor");
  if (/\bmentors?\b|\bcoach(es)?\b|\badvisers?\b|\badvisors?\b/.test(haystack)) hits.push("mentor");
  if (/\bco-?owners?\b|\bco-?founders?\b|\bpartners?\b/.test(haystack)) hits.push("co-owner");
  if (hits.length === 0) return "unknown";
  return hits.join("/");
}

function renderIntakeMarkdown(
  app: string,
  sections: ReadonlyArray<IntakeSection>,
  doneSummary: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`# Intake — ${app} — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  if (doneSummary !== undefined) {
    lines.push("## Summary");
    lines.push("");
    lines.push(doneSummary.trim());
    lines.push("");
  }
  for (const section of sections) {
    const tag =
      section.status === "answered"
        ? ""
        : section.status === "partial"
          ? " (partial)"
          : " (skipped)";
    lines.push(`## ${section.id}${tag}`);
    lines.push("");
    lines.push(section.body.trim());
    lines.push("");
  }
  return lines.join("\n");
}

function writeIntake(
  filePath: string,
  app: string,
  sections: ReadonlyArray<IntakeSection>,
  doneSummary?: string,
): string {
  const content = renderIntakeMarkdown(app, sections, doneSummary);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return content;
}

/**
 * Runs the intake interview loop. The agent asks one section at a time; we
 * read the user's answer from `io.readUserAnswer` and feed it back. On every
 * `<save>` we persist the running intake markdown so a crash mid-interview
 * doesn't lose the user's work.
 */
export async function runIntakeAgent(
  input: IntakeAgentInput,
): Promise<IntakeAgentResult> {
  if (!path.isAbsolute(input.repoRoot)) {
    throw new IntakeError(
      `repoRoot must be absolute, got "${input.repoRoot}"`,
    );
  }
  if (!fs.existsSync(input.repoRoot)) {
    throw new IntakeError(`repoRoot does not exist: ${input.repoRoot}`);
  }
  if (!path.isAbsolute(input.intakeFilePath)) {
    throw new IntakeError(
      `intakeFilePath must be absolute, got "${input.intakeFilePath}"`,
    );
  }

  const systemPrompt = loadIntakePrompt();
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const state: IntakeState = {
    answered: [],
    partial: [],
    skipped: [],
    lastUserMessage: "",
    userSignaledEnd: false,
    savedStatuses: new Map(),
  };
  const sections: IntakeSection[] = [];
  let round = 0;
  let doneSummary: string | undefined;
  let finishedCleanly = false;

  while (round < maxRounds) {
    round += 1;
    const userPrompt = buildUserPrompt(state, input, round === 1, sections);
    const result = await runAgent({
      systemPrompt,
      userPrompt,
      cwd: input.repoRoot,
      // Per-round budget. The SDK counts each Read/Glob/Grep tool call as
      // a turn. Generous so a tool-heavy round 1 (skimming repo files)
      // doesn't trip the cap; text-only rounds use ~1 turn anyway.
      maxTurns: 60,
      toolPreset: { kind: "readonly" },
      ...(input.model !== undefined && { model: input.model }),
      ...(input.transport !== undefined && { transport: input.transport }),
    });

    if (result.subtype !== "success") {
      throw new IntakeError(
        `Intake agent failed at round ${round}: ${result.subtype}` +
          (result.errors.length > 0 ? ` — ${result.errors.join("; ")}` : ""),
      );
    }

    const parsed = parseAgentTurn(result.text);
    applyTurn(state, parsed, sections);

    // Persist after every turn so partial work survives a crash. The summary
    // is only known once <done> arrives, so we re-render below in that case.
    writeIntake(input.intakeFilePath, input.app, sections);

    if (parsed.done !== undefined) {
      doneSummary = parsed.done.summary;
      writeIntake(input.intakeFilePath, input.app, sections, doneSummary);
      finishedCleanly = true;
      input.io.writeOutput(`\n${doneSummary.trim()}\n`);
      break;
    }

    const askBlock = parsed.ask;
    const followupBlock = parsed.followup;
    const next = askBlock ?? followupBlock;
    if (next === undefined) {
      throw new IntakeError(
        `Round ${round}: agent emitted no <ask>, <followup>, or <done>. First 200 chars: ${result.text.slice(0, 200)}`,
      );
    }

    const answer = await input.io.readUserAnswer({
      sectionId: next.sectionId,
      text: next.text,
      isFollowup: askBlock === undefined && followupBlock !== undefined,
      progress: {
        round,
        answered: state.answered.length,
        partial: state.partial.length,
        skipped: state.skipped.length,
      },
    });

    state.lastAsked = next.sectionId;
    if (answer.kind === "end") {
      state.userSignaledEnd = true;
      state.lastUserMessage = "";
      continue;
    }
    if (answer.kind === "skip") {
      state.lastUserMessage =
        "(user asked to skip this section — save it as `skipped` with a one-line reason if you have one, otherwise reason: \"user skipped\")";
      continue;
    }
    state.lastUserMessage = answer.text;
  }

  const content = writeIntake(
    input.intakeFilePath,
    input.app,
    sections,
    doneSummary,
  );

  return {
    sections,
    totalRounds: round,
    finishedCleanly,
    content,
    ...(doneSummary !== undefined ? { doneSummary } : {}),
  };
}

/**
 * Default IO: writes question text to stdout, reads multi-line answers from
 * stdin via `readline`.
 *
 * Submission rules — the user can:
 *   - type a single line and press Enter twice (one blank line submits)
 *   - type multiple lines, then press Enter on a blank line to submit
 *   - type `/skip` on a line by itself to skip the current section
 *   - type `/end` on a line by itself, or hit Ctrl-D, to end the interview
 */
export function makeStdioIntakeIO(opts: {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): IntakeIO {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  return {
    readUserAnswer: async (q) => {
      const banner = renderQuestionBanner(q);
      stdout.write(banner);
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: stdin as NodeJS.ReadableStream,
        output: stdout as NodeJS.WritableStream,
        terminal: false,
      });
      return new Promise<UserAnswer>((resolve) => {
        const lines: string[] = [];
        let resolved = false;
        const finish = (val: UserAnswer): void => {
          if (resolved) return;
          resolved = true;
          rl.close();
          resolve(val);
        };
        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (trimmed === "/skip" && lines.length === 0) {
            finish({ kind: "skip" });
            return;
          }
          if (trimmed === "/end" && lines.length === 0) {
            finish({ kind: "end" });
            return;
          }
          if (trimmed === "" && lines.length > 0) {
            finish({ kind: "answer", text: lines.join("\n").trim() });
            return;
          }
          if (trimmed !== "") {
            lines.push(line);
            // Continuation prompt for multi-line answers
            stdout.write("  ");
          }
        });
        rl.on("close", () => {
          if (lines.length > 0) {
            finish({ kind: "answer", text: lines.join("\n").trim() });
          } else {
            finish({ kind: "end" });
          }
        });
      });
    },
    writeOutput: (text) => {
      stdout.write(text);
    },
  };
}

const HRULE = "─".repeat(72);

function renderQuestionBanner(q: IntakeQuestion): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(HRULE);
  const tag = q.isFollowup ? "follow-up" : "question";
  const progress = `answered ${q.progress.answered} · partial ${q.progress.partial} · skipped ${q.progress.skipped}`;
  lines.push(`[${tag} ${q.progress.round}] ${q.sectionId}    (${progress})`);
  lines.push("");
  lines.push(q.text.trim());
  lines.push("");
  lines.push(
    "Type your answer. Submit with a blank line. " +
      "/skip = skip this section · /end (or Ctrl-D) = finish the interview.",
  );
  lines.push("");
  lines.push("> ");
  return lines.join("\n");
}
