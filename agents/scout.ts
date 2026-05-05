import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnthropicClient, ChatResponse } from "../orchestrator/agent-sdk-runtime.ts";
import {
  loadBusinessIdeas,
  saveBusinessIdeas,
  type BusinessIdea,
  type BusinessIdeasFile,
} from "../orchestrator/business-ideas.ts";
import type { Brain } from "../orchestrator/brain.ts";
import { brainExists, loadBrain } from "../orchestrator/brain.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { notesContextBlock } from "../orchestrator/notes.ts";
import type { Profile } from "../orchestrator/profile.ts";
import { loadProfile } from "../orchestrator/profile.ts";
import { runStrategist, StrategistError } from "./strategist.ts";
import {
  brainFile,
  dbFile,
  profileFile,
  repoRoot,
} from "../cli/paths.ts";

/**
 * Scout — research-and-evaluation agent. Phase 2 entry: score ideas in
 * `Business_Ideas.md` against the user's stated goals + the target app's
 * current brain. No web research yet; that lands with the research-tool
 * stub in a follow-up PR.
 *
 * Each `scoreIdea` call writes the score, scoredAt, and rationale back
 * to the same idea's section. `scoreUnscoredIdeas` loops over every
 * idea without a score and persists once at the end. An `idea-scored`
 * event is recorded per idea so we have an audit trail of how the
 * score evolved over time.
 */

export type SuggestedPriority = "low" | "normal" | "high" | "blocking";

export interface ScoutScoreResult {
  score: number;
  rationale: string;
  suggestedPriority: SuggestedPriority;
}

export class ScoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoutError";
  }
}

export interface ScoreIdeaInput {
  idea: BusinessIdea;
  profile: Profile;
  /** Brain of the idea's target app. Pass null when `idea.app === "new"`. */
  brain: Brain | null;
  client: AnthropicClient;
  /** Free-text notes block from `notesContextBlock(...)`. Optional. */
  notes?: string;
}

const VALID_PRIORITIES: ReadonlySet<SuggestedPriority> = new Set([
  "low",
  "normal",
  "high",
  "blocking",
]);

/**
 * Single LLM call: ask Scout to score this idea against the user's
 * profile + (optional) target-app brain. Pure function — no DB or file
 * I/O. Higher-level callers persist the score.
 */
export async function scoreIdea(
  input: ScoreIdeaInput,
): Promise<ScoutScoreResult> {
  const systemPrompt = loadScoutPrompt();
  const userMessage = buildScoreContext(input);

  const response = await input.client.chat({
    system: systemPrompt,
    cacheSystem: true,
    messages: [{ role: "user", content: userMessage }],
  });

  return parseScoreResponse(response);
}

export interface ScoreUnscoredIdeasInput {
  dataDir: string;
  client: AnthropicClient;
  vault: string;
  /**
   * Override the idea's app brain. Tests pass a stub; production
   * resolves brains from disk per idea. Pass `null` to skip brain
   * lookup entirely (treats every idea as a new-app idea).
   */
  resolveBrain?: (idea: BusinessIdea) => Brain | null;
  /** Override "now" — test seam. */
  now?: () => Date;
}

export interface ScoreUnscoredIdeasResult {
  scoredCount: number;
  errorCount: number;
  entries: Array<{
    ideaId: string;
    score?: number;
    suggestedPriority?: SuggestedPriority;
    error?: string;
  }>;
}

/**
 * Scores every idea that doesn't already have a `score` field, persists
 * the result back to `Business_Ideas.md`, and records one `idea-scored`
 * event per idea.
 *
 * Errors per-idea are isolated: a Scout failure on one entry doesn't
 * abort the rest. Already-scored ideas are skipped (re-scoring requires
 * the user to delete the score from the file first — keeps the LLM
 * cost predictable).
 */
export async function scoreUnscoredIdeas(
  input: ScoreUnscoredIdeasInput,
): Promise<ScoreUnscoredIdeasResult> {
  const file = loadBusinessIdeas(input.dataDir);
  const profile = loadProfile(profileFile(input.dataDir));
  const now = input.now ?? ((): Date => new Date());

  const result: ScoreUnscoredIdeasResult = {
    scoredCount: 0,
    errorCount: 0,
    entries: [],
  };

  let touched = false;
  for (let i = 0; i < file.ideas.length; i += 1) {
    const idea = file.ideas[i]!;
    if (idea.score !== undefined) continue;

    const brain = resolveBrainFor({
      idea,
      dataDir: input.dataDir,
      vault: input.vault,
      ...(input.resolveBrain !== undefined && {
        override: input.resolveBrain,
      }),
    });
    const notes =
      idea.app !== "new"
        ? notesContextBlock(input.dataDir, input.vault, idea.app)
        : null;

    let scored: ScoutScoreResult;
    try {
      scored = await scoreIdea({
        idea,
        profile,
        brain,
        client: input.client,
        ...(notes !== null && { notes }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errorCount += 1;
      result.entries.push({ ideaId: idea.id, error: msg });
      continue;
    }

    file.ideas[i] = {
      ...idea,
      score: scored.score,
      scoredAt: now().toISOString(),
      rationale: scored.rationale,
    };
    touched = true;

    recordScoredEvent({
      dataDir: input.dataDir,
      vault: input.vault,
      ideaId: idea.id,
      app: idea.app,
      score: scored.score,
      suggestedPriority: scored.suggestedPriority,
      rationale: scored.rationale,
    });

    result.scoredCount += 1;
    result.entries.push({
      ideaId: idea.id,
      score: scored.score,
      suggestedPriority: scored.suggestedPriority,
    });
  }

  if (touched) {
    saveBusinessIdeas(input.dataDir, file);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internals — exported for unit tests.
// ---------------------------------------------------------------------------

interface ResolveBrainArgs {
  idea: BusinessIdea;
  dataDir: string;
  vault: string;
  override?: (idea: BusinessIdea) => Brain | null;
}

function resolveBrainFor(args: ResolveBrainArgs): Brain | null {
  if (args.override) return args.override(args.idea);
  if (args.idea.app === "new") return null;
  const filePath = brainFile(args.dataDir, args.vault, args.idea.app);
  if (!brainExists(filePath)) return null;
  return loadBrain(filePath);
}

function recordScoredEvent(input: {
  dataDir: string;
  vault: string;
  ideaId: string;
  app: string;
  score: number;
  suggestedPriority: SuggestedPriority;
  rationale: string;
}): void {
  const db = new Database(dbFile(input.dataDir));
  try {
    appendEvent(db, {
      appId: input.app,
      vaultId: input.vault,
      kind: "idea-scored",
      payload: {
        ideaId: input.ideaId,
        score: input.score,
        suggestedPriority: input.suggestedPriority,
        rationale: input.rationale,
      },
    });
  } finally {
    db.close();
  }
}

let cachedPrompt: string | undefined;
function loadScoutPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  const promptPath = path.join(repoRoot(), "prompts", "scout-score.md");
  cachedPrompt = fs.readFileSync(promptPath, "utf8");
  return cachedPrompt;
}

export function buildScoreContext(input: ScoreIdeaInput): string {
  const lines: string[] = [];
  lines.push("## Idea");
  lines.push(`Title: ${input.idea.title}`);
  lines.push(`App: ${input.idea.app}`);
  lines.push(`Brief: ${input.idea.brief}`);
  if (input.idea.tags.length > 0) {
    lines.push(`Tags: ${input.idea.tags.join(", ")}`);
  }
  if (input.idea.body.length > 0) {
    lines.push("");
    lines.push("Body:");
    lines.push(input.idea.body);
  }
  lines.push("");

  lines.push("## User profile");
  lines.push("```json");
  lines.push(JSON.stringify(input.profile, null, 2));
  lines.push("```");
  lines.push("");

  if (input.brain !== null) {
    lines.push("## Target app brain");
    lines.push("```json");
    lines.push(JSON.stringify(input.brain, null, 2));
    lines.push("```");
  } else if (input.idea.app === "new") {
    lines.push("## Target app");
    lines.push("New app — no existing brain to read from.");
  } else {
    lines.push("## Target app brain");
    lines.push(`No brain found for app "${input.idea.app}". Score from idea + profile alone.`);
  }
  lines.push("");

  if (input.notes) {
    lines.push(input.notes);
    lines.push("");
  }

  lines.push("Score this idea per the rubric. Return only a `<score>` block.");
  return lines.join("\n");
}

export function parseScoreResponse(response: ChatResponse): ScoutScoreResult {
  const match = response.text.match(/<score>([\s\S]*?)<\/score>/);
  if (!match || !match[1]) {
    throw new ScoutError(
      `Scout response missing <score> block. First 200 chars: ${response.text.slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (err) {
    throw new ScoutError(
      `Scout <score> block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ScoutError("Scout <score> JSON is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const score = obj["score"];
  const rationale = obj["rationale"];
  const suggestedPriority = obj["suggestedPriority"];
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new ScoutError(
      `Scout score must be an integer in [0, 100]; got ${JSON.stringify(score)}`,
    );
  }
  if (typeof rationale !== "string" || rationale.length === 0) {
    throw new ScoutError("Scout score missing 'rationale' string");
  }
  if (
    typeof suggestedPriority !== "string" ||
    !VALID_PRIORITIES.has(suggestedPriority as SuggestedPriority)
  ) {
    throw new ScoutError(
      `Scout suggestedPriority must be one of low|normal|high|blocking; got ${JSON.stringify(
        suggestedPriority,
      )}`,
    );
  }
  return {
    score,
    rationale,
    suggestedPriority: suggestedPriority as SuggestedPriority,
  };
}

export type { BusinessIdeasFile };

// ---------------------------------------------------------------------------
// Auto-draft hand-off — Scout → Strategist
//
// When an idea scores at or above `scoreThreshold` and hasn't been
// drafted yet, hand it to Strategist as the brief for an improvement
// plan. The plan goes through the normal review flow (`awaiting-review`
// → user approves → daemon fires Developer). Idempotent on `ideaId`:
// if a prior `idea-drafted` event exists for that idea, future calls
// skip it. Reject the resulting plan to clear it from the queue;
// re-running `scout draft` won't re-spam.
// ---------------------------------------------------------------------------

const DEFAULT_SCORE_THRESHOLD = 80;

export interface AutoDraftFromIdeasInput {
  dataDir: string;
  vault: string;
  client: AnthropicClient;
  /**
   * Minimum score for auto-draft. Default 80. Below this, the idea is
   * skipped and surfaced in the result with a `below-threshold` reason.
   */
  scoreThreshold?: number;
}

export interface AutoDraftFromIdeasResult {
  draftedCount: number;
  errorCount: number;
  entries: Array<{
    ideaId: string;
    planId?: string;
    /** Reason why this idea was not drafted (idempotent skip, threshold, etc.). */
    skippedReason?: string;
    error?: string;
  }>;
}

/**
 * Drafts plans for every idea in `Business_Ideas.md` that:
 *   - has `score >= scoreThreshold`
 *   - has no prior `idea-drafted` event (idempotent)
 *   - targets an existing onboarded app (skips `App: new` for now —
 *     a new-app idea needs `yarn jarvis onboard` first; a future PR
 *     can wire that flow)
 *
 * Per-idea Strategist errors are isolated and surfaced in `entries`.
 * Records one `idea-drafted` event per drafted plan with `ideaId`,
 * `planId`, `score`, `actor: "scout"`.
 */
export async function autoDraftFromIdeas(
  input: AutoDraftFromIdeasInput,
): Promise<AutoDraftFromIdeasResult> {
  const threshold = input.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const file = loadBusinessIdeas(input.dataDir);
  const alreadyDrafted = readDraftedFromIdeaIds(dbFile(input.dataDir));

  const result: AutoDraftFromIdeasResult = {
    draftedCount: 0,
    errorCount: 0,
    entries: [],
  };

  for (const idea of file.ideas) {
    if (idea.score === undefined) {
      result.entries.push({
        ideaId: idea.id,
        skippedReason: "unscored",
      });
      continue;
    }
    if (idea.score < threshold) {
      result.entries.push({
        ideaId: idea.id,
        skippedReason: `below threshold (score ${idea.score} < ${threshold})`,
      });
      continue;
    }
    if (alreadyDrafted.has(idea.id)) {
      result.entries.push({
        ideaId: idea.id,
        skippedReason: "already drafted",
      });
      continue;
    }
    if (idea.app === "new") {
      result.entries.push({
        ideaId: idea.id,
        skippedReason: "new-app idea — onboard the app first, then re-run",
      });
      continue;
    }
    if (!brainExists(brainFile(input.dataDir, input.vault, idea.app))) {
      result.entries.push({
        ideaId: idea.id,
        skippedReason: `no brain for app "${idea.app}" in vault "${input.vault}"`,
      });
      continue;
    }

    const brief = composeBriefFromIdea(idea);
    let planId: string | undefined;
    try {
      const draft = await runStrategist({
        client: input.client,
        brief,
        app: idea.app,
        vault: input.vault,
        dataDir: input.dataDir,
        type: "improvement",
        challenge: false,
      });
      planId = draft.planId;
    } catch (err) {
      const msg =
        err instanceof StrategistError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.entries.push({
        ideaId: idea.id,
        error: `strategist error: ${msg}`,
      });
      result.errorCount += 1;
      continue;
    }

    const db = new Database(dbFile(input.dataDir));
    try {
      appendEvent(db, {
        appId: idea.app,
        vaultId: input.vault,
        kind: "idea-drafted",
        payload: {
          ideaId: idea.id,
          planId,
          score: idea.score,
          actor: "scout",
        },
      });
    } finally {
      db.close();
    }

    alreadyDrafted.add(idea.id);
    result.draftedCount += 1;
    result.entries.push({ ideaId: idea.id, planId });
  }

  return result;
}

/** Returns the set of ideaIds that already have an `idea-drafted` event. */
export function readDraftedFromIdeaIds(dbFilePath: string): Set<string> {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE kind = 'idea-drafted'")
      .all() as Array<{ payload: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { ideaId?: string };
        if (typeof p.ideaId === "string" && p.ideaId.length > 0) {
          out.add(p.ideaId);
        }
      } catch {
        // skip malformed
      }
    }
    return out;
  } finally {
    db.close();
  }
}

export function composeBriefFromIdea(idea: BusinessIdea): string {
  const lines: string[] = [];
  lines.push(
    `Idea from Business_Ideas.md (Scout score: ${idea.score ?? "n/a"}/100).`,
  );
  lines.push("");
  lines.push(`Title: ${idea.title}`);
  lines.push(`App: ${idea.app}`);
  if (idea.tags.length > 0) {
    lines.push(`Tags: ${idea.tags.join(", ")}`);
  }
  lines.push(`Brief: ${idea.brief}`);
  if (idea.rationale) {
    lines.push(`Scout's rationale: ${idea.rationale}`);
  }
  if (idea.body.length > 0) {
    lines.push("");
    lines.push("Notes from the user:");
    lines.push(idea.body);
  }
  lines.push("");
  lines.push(
    "Draft an improvement plan that delivers on this idea. Identify the affected code, propose a concrete first step, include rollback steps, and note acceptance criteria for verifying the change landed correctly.",
  );
  return lines.join("\n");
}
