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

export interface IntakeIO {
  /**
   * Display the agent's question to the user, then read the user's answer.
   * Resolve to `null` when the user signals "end the interview" (Ctrl-D / EOF).
   * Resolve to an empty string only when the user actually typed nothing but
   * pressed enter — the agent will treat that as a non-answer.
   */
  readUserAnswer: (question: { sectionId: string; text: string }) => Promise<string | null>;
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

const DEFAULT_MAX_ROUNDS = 50;

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
}

function buildUserPrompt(
  state: IntakeState,
  input: { app: string; repoRoot: string },
  isFirstTurn: boolean,
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
  if (isFirstTurn) {
    lines.push(`- last user message: (none — this is the first turn)`);
  } else {
    lines.push(`- last user message: ${quoteMultiline(state.lastUserMessage)}`);
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
  };
  const sections: IntakeSection[] = [];
  let round = 0;
  let doneSummary: string | undefined;
  let finishedCleanly = false;

  while (round < maxRounds) {
    round += 1;
    const userPrompt = buildUserPrompt(state, input, round === 1);
    const result = await runAgent({
      systemPrompt,
      userPrompt,
      cwd: input.repoRoot,
      // Per-round budget. The SDK counts each Read/Glob/Grep tool call as a
      // turn; the agent typically skims 1–3 repo files on round 1 before
      // emitting <ask>, then mostly text-only on subsequent rounds. 20 leaves
      // headroom for tool-heavy rounds without letting a wandering agent
      // burn an unbounded budget.
      maxTurns: 20,
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

    const next = parsed.ask ?? parsed.followup;
    if (next === undefined) {
      throw new IntakeError(
        `Round ${round}: agent emitted no <ask>, <followup>, or <done>. First 200 chars: ${result.text.slice(0, 200)}`,
      );
    }

    const answer = await input.io.readUserAnswer({
      sectionId: next.sectionId,
      text: next.text,
    });

    if (answer === null) {
      // User signaled end. Tell the agent on the next turn so it wraps up.
      state.userSignaledEnd = true;
      state.lastAsked = next.sectionId;
      state.lastUserMessage = "";
      continue;
    }

    state.lastAsked = next.sectionId;
    state.lastUserMessage = answer;
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
 * stdin via `readline`. A blank line submits the answer; EOF (Ctrl-D)
 * resolves to `null` so the agent can wrap up early.
 */
export function makeStdioIntakeIO(opts: {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): IntakeIO {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  return {
    readUserAnswer: async (q) => {
      stdout.write(`\n[${q.sectionId}]\n${q.text.trim()}\n\n`);
      stdout.write("(answer below; submit a blank line; Ctrl-D ends the interview)\n> ");
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: stdin as NodeJS.ReadableStream,
        output: stdout as NodeJS.WritableStream,
        terminal: false,
      });
      return new Promise<string | null>((resolve) => {
        const lines: string[] = [];
        let resolved = false;
        const finish = (val: string | null): void => {
          if (resolved) return;
          resolved = true;
          rl.close();
          resolve(val);
        };
        rl.on("line", (line) => {
          if (line.trim() === "" && lines.length > 0) {
            finish(lines.join("\n").trim());
            return;
          }
          if (line.trim() !== "") lines.push(line);
        });
        rl.on("close", () => {
          finish(lines.length > 0 ? lines.join("\n").trim() : null);
        });
      });
    },
    writeOutput: (text) => {
      stdout.write(text);
    },
  };
}
