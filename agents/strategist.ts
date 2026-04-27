import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import type { AnthropicClient, ChatResponse } from "../orchestrator/anthropic-client.ts";
import type { Brain } from "../orchestrator/brain.ts";
import { loadBrain } from "../orchestrator/brain.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { recordFeedback } from "../orchestrator/feedback-store.ts";
import { savePlan } from "../orchestrator/plan-store.ts";
import { parsePlan, transitionPlan } from "../orchestrator/plan.ts";
import type { Plan } from "../orchestrator/plan.ts";
import type { Profile } from "../orchestrator/profile.ts";
import { loadProfile } from "../orchestrator/profile.ts";
import {
  brainFile,
  dbFile,
  planDir,
  profileFile,
  repoRoot,
} from "../cli/paths.ts";

export interface Prompter {
  ask(prompt: string): Promise<string>;
  print(message: string): void;
}

export interface StrategistInput {
  client: AnthropicClient;
  brief: string;
  app: string;
  vault: string;
  dataDir: string;
  type?: string;
  subtype?: string;
  challenge?: boolean;
  prompter?: Prompter;
}

export interface ClarificationRound {
  questions: string[];
  answers: string[];
}

export interface StrategistResult {
  planId: string;
  planPath: string;
  rounds: number;
  clarifications: ClarificationRound[];
}

export class StrategistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategistError";
  }
}

const MAX_CHALLENGE_ROUNDS = 3;

export async function runStrategist(
  input: StrategistInput,
): Promise<StrategistResult> {
  const challenge = input.challenge ?? true;

  const brain = loadBrain(brainFile(input.dataDir, input.vault, input.app));
  const profile = loadProfile(profileFile(input.dataDir));
  const systemPrompt = loadStrategistPrompt();

  const initialContext = buildContext({
    brain,
    profile,
    brief: input.brief,
    ...(input.type !== undefined && { typeHint: input.type }),
    ...(input.subtype !== undefined && { subtypeHint: input.subtype }),
  });

  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: initialContext },
  ];
  const clarifications: ClarificationRound[] = [];

  for (let round = 1; round <= MAX_CHALLENGE_ROUNDS + 1; round += 1) {
    const response = await input.client.chat({
      system: systemPrompt,
      cacheSystem: true,
      messages: conversation,
    });
    const action = parseStrategistResponse(response);

    if (action.kind === "draft") {
      const result = await persistDraft({
        markdown: action.markdown,
        input,
        clarifications,
        rounds: clarifications.length,
      });
      return result;
    }

    if (!challenge || round > MAX_CHALLENGE_ROUNDS) {
      // Force draft on the next turn under "## Open questions / assumptions"
      conversation.push({ role: "assistant", content: response.text });
      conversation.push({
        role: "user",
        content:
          "Drafting required now. Use <plan> with the residual gaps surfaced under '## Open questions / assumptions'. Do not ask further questions.",
      });
      continue;
    }

    if (!input.prompter) {
      throw new StrategistError(
        "Strategist asked for clarification but no prompter is wired. Run with --no-challenge to force a draft, or use the interactive CLI.",
      );
    }

    input.prompter.print(
      `\nStrategist needs clarification (round ${round}/${MAX_CHALLENGE_ROUNDS}):`,
    );
    const answers: string[] = [];
    for (const q of action.questions) {
      const answer = await input.prompter.ask(`  ${q}\n  > `);
      answers.push(answer.trim());
    }
    clarifications.push({ questions: action.questions, answers });

    conversation.push({ role: "assistant", content: response.text });
    conversation.push({
      role: "user",
      content: formatAnswers(action.questions, answers),
    });
  }

  throw new StrategistError(
    "Strategist exceeded max challenge rounds without drafting.",
  );
}

interface DraftAction {
  kind: "draft";
  markdown: string;
}

interface ClarifyAction {
  kind: "clarify";
  questions: string[];
}

type StrategistAction = DraftAction | ClarifyAction;

export function parseStrategistResponse(
  response: ChatResponse,
): StrategistAction {
  const text = response.text;
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/);
  if (planMatch && planMatch[1]) {
    return { kind: "draft", markdown: planMatch[1].trim() };
  }
  const clarifyMatch = text.match(/<clarify>([\s\S]*?)<\/clarify>/);
  if (clarifyMatch && clarifyMatch[1]) {
    const questions = clarifyMatch[1]
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);
    if (questions.length === 0) {
      throw new StrategistError(
        "Strategist returned <clarify> with no questions.",
      );
    }
    return { kind: "clarify", questions };
  }
  throw new StrategistError(
    `Strategist response had neither <plan> nor <clarify>. First 200 chars: ${text.slice(0, 200)}`,
  );
}

interface PersistDraftArgs {
  markdown: string;
  input: StrategistInput;
  clarifications: ClarificationRound[];
  rounds: number;
}

async function persistDraft(
  args: PersistDraftArgs,
): Promise<StrategistResult> {
  let plan: Plan;
  try {
    plan = parsePlan(args.markdown);
  } catch (err) {
    throw new StrategistError(
      `Strategist's draft failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (plan.metadata.status !== "draft") {
    throw new StrategistError(
      `Strategist's draft must have Status: draft, got "${plan.metadata.status}"`,
    );
  }
  plan = transitionPlan(plan, "awaiting-review");

  const planId = generatePlanId(
    plan.metadata.title,
    args.input.app,
    args.input.dataDir,
    args.input.vault,
  );
  const planFolder = planDir(args.input.dataDir, args.input.vault, args.input.app);
  fs.mkdirSync(planFolder, { recursive: true });
  const planPath = path.join(planFolder, `${planId}.md`);

  const db = new Database(dbFile(args.input.dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: args.input.app,
        vaultId: args.input.vault,
        kind: "plan-drafted",
        payload: {
          planId,
          brief: args.input.brief,
          rounds: args.rounds,
          author: "strategist",
        },
      });
      for (const round of args.clarifications) {
        for (let i = 0; i < round.questions.length; i += 1) {
          recordFeedback(db, {
            kind: "clarification-answer",
            actor: "user",
            targetType: "plan",
            targetId: planId,
            note: round.answers[i] ?? "",
            contextSnapshot: { question: round.questions[i] ?? "" },
          });
        }
      }
    })();
  } finally {
    db.close();
  }

  savePlan(planPath, plan);

  return {
    planId,
    planPath,
    rounds: args.rounds,
    clarifications: args.clarifications,
  };
}

function buildContext(args: {
  brain: Brain;
  profile: Profile;
  brief: string;
  typeHint?: string;
  subtypeHint?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Brief: ${args.brief}`);
  lines.push("");
  lines.push("Project context (brain):");
  lines.push(`- name: ${args.brain.projectName}`);
  lines.push(`- type: ${args.brain.projectType}`);
  lines.push(`- status: ${args.brain.projectStatus}`);
  lines.push(`- priority: ${args.brain.projectPriority}`);
  if (args.brain.userPreferences.areasOfInterest?.length) {
    lines.push(
      `- areasOfInterest: ${args.brain.userPreferences.areasOfInterest.join(", ")}`,
    );
  }
  if (args.brain.userPreferences.areasToAvoid?.length) {
    lines.push(
      `- areasToAvoid: ${args.brain.userPreferences.areasToAvoid.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("User profile:");
  lines.push(
    `- identity: ${args.profile.identity.name || "(unset)"}, ${args.profile.identity.role || "(role unset)"}`,
  );
  if (args.profile.preferences.responseStyle) {
    lines.push(`- responseStyle: ${args.profile.preferences.responseStyle}`);
  }
  if (args.profile.preferences.planVerbosity) {
    lines.push(`- planVerbosity: ${args.profile.preferences.planVerbosity}`);
  }
  if (args.profile.preferences.languageRules.length) {
    lines.push(
      `- languageRules: ${args.profile.preferences.languageRules.join("; ")}`,
    );
  }
  if (args.profile.preferences.globalExclusions.length) {
    lines.push(
      `- globalExclusions: ${args.profile.preferences.globalExclusions.join("; ")}`,
    );
  }
  if (args.typeHint) {
    lines.push("");
    lines.push(`Type hint from CLI: ${args.typeHint}`);
  }
  if (args.subtypeHint) {
    lines.push(`Subtype hint from CLI: ${args.subtypeHint}`);
  }
  return lines.join("\n");
}

function formatAnswers(questions: string[], answers: string[]): string {
  const lines: string[] = ["Clarification answers:"];
  for (let i = 0; i < questions.length; i += 1) {
    lines.push(`Q: ${questions[i] ?? ""}`);
    lines.push(`A: ${answers[i] ?? ""}`);
    lines.push("");
  }
  lines.push(
    "Now respond with <plan>...</plan> or another <clarify>...</clarify> if essential.",
  );
  return lines.join("\n");
}

export function generatePlanId(
  title: string,
  app: string,
  dataDir: string,
  vault: string,
  today: Date = new Date(),
): string {
  const date = today.toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const base = slug ? `${date}-${slug}` : date;
  let candidate = base;
  let counter = 2;
  const folder = planDir(dataDir, vault, app);
  while (fs.existsSync(path.join(folder, `${candidate}.md`))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

let cachedPrompt: string | null = null;
function loadStrategistPrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  const promptPath = path.join(repoRoot(), "prompts", "strategist.md");
  cachedPrompt = fs.readFileSync(promptPath, "utf8");
  return cachedPrompt;
}

export function createStdinPrompter(): Prompter {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    ask(prompt) {
      return new Promise<string>((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
      });
    },
    print(message) {
      process.stdout.write(`${message}\n`);
    },
  };
}
