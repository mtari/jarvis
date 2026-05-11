import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  runAgent,
  type RunAgentResult,
  type RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { notesContextBlock } from "../orchestrator/notes.ts";
import { findPlan, savePlan, type PlanRecord } from "../orchestrator/plan-store.ts";
import type { Plan } from "../orchestrator/plan.ts";
import {
  parsePlan,
  transitionPlan,
  type PlanStatus,
} from "../orchestrator/plan.ts";
import {
  checkpointsDir,
  dbFile,
  planDir,
  repoRoot as defaultRepoRoot,
} from "../cli/paths.ts";
import { dumpFailedDraft } from "./strategist.ts";

/**
 * Records an `agent-call` event for one runAgent result. Uses the same payload
 * shape as the API path so `yarn jarvis cost` aggregates both modes. The
 * `mode` field is always "subscription" here since we're going through the
 * SDK runtime; pre-pivot rows from the API path keep their original `mode`.
 */
function recordAgentCall(
  dataDir: string,
  app: string,
  vault: string,
  planId: string,
  result: RunAgentResult,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "agent-call",
      payload: {
        agent: "developer",
        planId,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: result.durationMs,
        stopReason: result.stopReason,
        numTurns: result.numTurns,
        totalCostUsd: result.totalCostUsd,
        permissionDenials: result.permissionDenials,
        subtype: result.subtype,
        mode: "subscription",
      },
    });
  } finally {
    db.close();
  }
}

export class DeveloperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeveloperError";
  }
}

// Draft-impl and execute both count Read/Glob/Grep/Edit/Bash as one SDK
// turn each. Execute touches the most tools (typecheck + test + commit +
// push + PR usually push the turn count past 50) so 90 gives a safe
// ceiling. Draft-impl stays at 60 since it has no shell side-effects.
// Bumped from 60 → 90 after Phase C wire-up hit error_max_turns at
// turn 61/60 mid-execute and had to be salvaged by hand.
const DEFAULT_MAX_TURNS_DRAFT_IMPL = 60;
const DEFAULT_MAX_TURNS_EXECUTE = 90;

// ---------- Mode A: draft implementation plan ----------

export interface DraftImplPlanInput {
  parentPlanId: string;
  app: string;
  vault: string;
  dataDir: string;
  repoRoot?: string;
  maxTurns?: number;
  /** Test injection for the SDK transport. */
  transport?: RunAgentTransport;
  model?: string;
}

export interface DraftImplPlanResult {
  planId: string;
  planPath: string;
  numTurns: number;
}

export async function draftImplementationPlan(
  input: DraftImplPlanInput,
): Promise<DraftImplPlanResult> {
  const repo = input.repoRoot ?? defaultRepoRoot();
  const parent = findPlan(input.dataDir, input.parentPlanId);
  if (!parent) {
    throw new DeveloperError(`parent plan ${input.parentPlanId} not found`);
  }
  if (parent.plan.metadata.status !== "approved") {
    throw new DeveloperError(
      `parent plan ${input.parentPlanId} is in state "${parent.plan.metadata.status}", not "approved"`,
    );
  }

  const planId = `${input.parentPlanId}-impl`;
  const planFolder = planDir(input.dataDir, input.vault, input.app);
  const planPath = path.join(planFolder, `${planId}.md`);
  if (fs.existsSync(planPath)) {
    throw new DeveloperError(
      `implementation plan already exists at ${planPath}`,
    );
  }

  const systemPrompt = loadDeveloperPrompt("developer-impl-plan.md");
  const parentMarkdown = fs.readFileSync(parent.path, "utf8");
  const userPrompt = [
    `Parent improvement plan id: ${input.parentPlanId}`,
    "Parent plan content:",
    "",
    parentMarkdown,
  ].join("\n");

  const result = await runAgent({
    systemPrompt,
    userPrompt,
    cwd: repo,
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS_DRAFT_IMPL,
    toolPreset: { kind: "readonly" }, // Read/Glob/Grep — no Bash, no Write
    ...(input.model !== undefined && { model: input.model }),
    ...(input.transport !== undefined && { transport: input.transport }),
  });

  // Record agent-call telemetry regardless of outcome.
  recordAgentCall(input.dataDir, input.app, input.vault, planId, result);

  if (result.subtype !== "success") {
    throw new DeveloperError(
      `Developer draft-impl failed: ${result.subtype}` +
        (result.errors.length > 0 ? ` — ${result.errors.join("; ")}` : ""),
    );
  }

  const planMatch = result.text.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch || !planMatch[1]) {
    throw new DeveloperError("Developer's final response had no <plan> block");
  }
  let plan: Plan;
  try {
    plan = parsePlan(planMatch[1].trim());
  } catch (err) {
    const dumpPath = dumpFailedDraft(input.dataDir, planMatch[1].trim());
    throw new DeveloperError(
      `implementation plan failed schema validation: ${err instanceof Error ? err.message : String(err)}` +
        (dumpPath ? `\n  Raw draft saved at ${dumpPath}` : ""),
    );
  }
  if (plan.metadata.type !== "implementation") {
    throw new DeveloperError(
      `expected Type: implementation, got "${plan.metadata.type}"`,
    );
  }
  if (plan.metadata.parentPlan !== input.parentPlanId) {
    throw new DeveloperError(
      `ParentPlan must equal "${input.parentPlanId}", got "${plan.metadata.parentPlan}"`,
    );
  }
  if (plan.metadata.status !== "draft") {
    throw new DeveloperError(
      `Developer's draft must have Status: draft, got "${plan.metadata.status}"`,
    );
  }
  plan = transitionPlan(plan, "awaiting-review");

  fs.mkdirSync(planFolder, { recursive: true });

  const db = new Database(dbFile(input.dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: input.app,
        vaultId: input.vault,
        kind: "plan-drafted",
        payload: {
          planId,
          parentPlanId: input.parentPlanId,
          author: "developer",
          numTurns: result.numTurns,
        },
      });
    })();
  } finally {
    db.close();
  }
  savePlan(planPath, plan);

  return {
    planId,
    planPath,
    numTurns: result.numTurns,
  };
}

// ---------- Mode B: execute ----------

export interface ExecutePlanInput {
  planId: string;
  app: string;
  vault: string;
  dataDir: string;
  repoRoot?: string;
  maxTurns?: number;
  /** Test injection for the SDK transport. */
  transport?: RunAgentTransport;
  model?: string;
  /**
   * When true, treat this fire as an amendment resume: read the
   * checkpoint, build a resume-mode user prompt that explains the
   * dirty-tree expectation, and on DONE record `amendment-applied`
   * + delete the checkpoint. Caller (plan-executor) determines this
   * via `isAmendmentResume()`.
   */
  resume?: boolean;
}

export interface ExecutePlanResult {
  finalText: string;
  branch?: string;
  prUrl?: string;
  done: boolean;
  blocked: boolean;
  /**
   * True when Developer surfaced a §12 amendment proposal mid-execution.
   * Mutually exclusive with `done` and `blocked`.
   */
  amended: boolean;
  amendmentReason?: string;
  amendmentProposal?: string;
  numTurns: number;
  toolCallCount: number;
  subtype: RunAgentResult["subtype"];
}

export async function executePlan(
  input: ExecutePlanInput,
): Promise<ExecutePlanResult> {
  const repo = input.repoRoot ?? defaultRepoRoot();
  const record = findPlan(input.dataDir, input.planId);
  if (!record) {
    throw new DeveloperError(`plan ${input.planId} not found`);
  }
  if (record.plan.metadata.status !== "approved") {
    throw new DeveloperError(
      `plan ${input.planId} is in state "${record.plan.metadata.status}", not "approved"`,
    );
  }

  // Transition approved → executing
  recordTransition(record, "executing", input.dataDir);

  // Build context (include parent plan if implementation type)
  const planMarkdown = fs.readFileSync(record.path, "utf8");

  // Resume mode short-circuits the standard prompt with checkpoint context.
  let userPrompt: string;
  let resumeCheckpoint: AmendmentCheckpoint | null = null;
  if (input.resume === true) {
    resumeCheckpoint = readAmendmentCheckpoint(input.planId, input.dataDir);
    if (resumeCheckpoint === null) {
      throw new DeveloperError(
        `plan ${input.planId} is flagged as amendment-resume but the checkpoint is missing`,
      );
    }
    let parentMarkdown: string | undefined;
    let parentPlanId: string | undefined;
    if (
      record.plan.metadata.type === "implementation" &&
      record.plan.metadata.parentPlan
    ) {
      const parent = findPlan(input.dataDir, record.plan.metadata.parentPlan);
      if (parent) {
        parentMarkdown = fs.readFileSync(parent.path, "utf8");
        parentPlanId = record.plan.metadata.parentPlan;
      }
    }
    userPrompt = buildResumePrompt({
      planId: input.planId,
      planMarkdown,
      checkpoint: resumeCheckpoint,
      ...(parentMarkdown !== undefined && { parentMarkdown }),
      ...(parentPlanId !== undefined && { parentPlanId }),
    });
  } else {
    const contextLines: string[] = [
      `Plan id: ${input.planId}`,
      "Plan content:",
      "",
      planMarkdown,
    ];
    if (
      record.plan.metadata.type === "implementation" &&
      record.plan.metadata.parentPlan
    ) {
      const parent = findPlan(input.dataDir, record.plan.metadata.parentPlan);
      if (parent) {
        contextLines.push("");
        contextLines.push(
          `Parent improvement plan id: ${record.plan.metadata.parentPlan}`,
        );
        contextLines.push("Parent plan content:");
        contextLines.push("");
        contextLines.push(fs.readFileSync(parent.path, "utf8"));
      }
    }
    const notes = notesContextBlock(input.dataDir, record.vault, record.app);
    if (notes !== null) {
      contextLines.push("");
      contextLines.push(notes);
    }
    userPrompt = contextLines.join("\n");
  }

  const developerPromptText = loadDeveloperPrompt("developer-execute.md");

  // Use the claude_code preset's system prompt and append our workflow rules.
  // The preset gives Claude Code's coding instincts (file-edit conventions,
  // commit-message style, etc.); developer-execute.md layers on the Jarvis
  // workflow contract (clean-tree gate, BLOCKED protocol, DONE format).
  const result = await runAgent({
    systemPrompt: "", // ignored when presetSystemPrompt: true
    presetSystemPrompt: true,
    appendSystemPrompt: developerPromptText,
    userPrompt,
    cwd: repo,
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS_EXECUTE,
    toolPreset: { kind: "claude_code" },
    ...(input.model !== undefined && { model: input.model }),
    ...(input.transport !== undefined && { transport: input.transport }),
  });

  // Record telemetry before any further plan-state changes — keeps the
  // event log accurate even if downstream transitions throw.
  recordAgentCall(input.dataDir, input.app, input.vault, input.planId, result);

  const text = result.text;
  const amendment = parseAmendmentResponse(text);
  // Precedence: AMEND > BLOCKED > DONE. Developer's prompt enforces this
  // ordering; even if both AMEND and BLOCKED could apply, we treat the
  // amendment as authoritative.
  const blocked =
    amendment === null &&
    (/^BLOCKED\b/m.test(text) || result.subtype === "error_max_turns");
  const done =
    amendment === null &&
    !blocked &&
    /^DONE\b/m.test(text) &&
    result.subtype === "success";
  const branchMatch = text.match(/^Branch:\s*(.+)$/m);
  const prMatch = text.match(/^PR URL:\s*(.+)$/m);

  // Reload record after the executing-transition wrote the file
  const updatedRecord = findPlan(input.dataDir, input.planId);
  let finalStatus: PlanStatus | null = null;
  if (updatedRecord) {
    if (amendment) {
      // Append the amendment to the plan body, capture a checkpoint of
      // the working-tree state, transition executing → awaiting-review,
      // and record an `amendment-proposed` event so the inbox can tag it.
      appendAmendmentToPlan(updatedRecord, amendment);
      let checkpoint: AmendmentCheckpoint | undefined;
      try {
        checkpoint = writeAmendmentCheckpoint({
          dataDir: input.dataDir,
          repoRoot: repo,
          planId: input.planId,
          amendment,
        });
      } catch (err) {
        // Checkpoint capture is best-effort — slice 3's resume can still
        // operate from the amended plan body even without git state.
        // Surface the failure but don't abort the amendment.
        const msg = err instanceof Error ? err.message : String(err);
        const db = new Database(dbFile(input.dataDir));
        try {
          appendEvent(db, {
            appId: input.app,
            vaultId: input.vault,
            kind: "amendment-checkpoint-error",
            payload: { planId: input.planId, error: msg },
          });
        } finally {
          db.close();
        }
      }
      // Reload again — appendAmendmentToPlan mutated the file
      const postAmendRecord = findPlan(input.dataDir, input.planId);
      if (postAmendRecord) {
        recordTransition(postAmendRecord, "awaiting-review", input.dataDir);
      }
      const db = new Database(dbFile(input.dataDir));
      try {
        appendEvent(db, {
          appId: input.app,
          vaultId: input.vault,
          kind: "amendment-proposed",
          payload: {
            planId: input.planId,
            reason: amendment.reason,
            proposal: amendment.proposal,
            ...(checkpoint !== undefined && {
              branch: checkpoint.branch,
              sha: checkpoint.sha,
              modifiedFileCount: checkpoint.modifiedFiles.length,
            }),
            actor: "developer",
          },
        });
      } finally {
        db.close();
      }
      finalStatus = "awaiting-review";
    } else if (done) {
      recordTransition(updatedRecord, "done", input.dataDir);
      finalStatus = "done";
      // If this run was a resume, record the matching amendment-applied
      // event so future runs of `isAmendmentResume` return false, and
      // remove the checkpoint so the next fire of this plan id (after
      // a hypothetical re-approval) is treated as a fresh execution.
      if (input.resume === true) {
        const db = new Database(dbFile(input.dataDir));
        try {
          appendEvent(db, {
            appId: input.app,
            vaultId: input.vault,
            kind: "amendment-applied",
            payload: {
              planId: input.planId,
              actor: "developer",
              ...(resumeCheckpoint !== null && {
                resumedBranch: resumeCheckpoint.branch,
                resumedSha: resumeCheckpoint.sha,
              }),
            },
          });
        } finally {
          db.close();
        }
        removeAmendmentCheckpoint(input.planId, input.dataDir);
      }
    } else if (blocked) {
      recordTransition(updatedRecord, "blocked", input.dataDir);
      finalStatus = "blocked";
    }
    // Otherwise leave at "executing" — caller can inspect and decide.
  }

  // §4: when an implementation plan finishes (done or blocked), mirror
  // that on the parent improvement plan. Parent stays put if it's not
  // currently "executing" (e.g., user paused / cancelled it manually).
  // Amendments deliberately do NOT mirror — the parent stays `executing`
  // while the user reviews the impl-plan amendment, then resumes
  // automatically when the impl plan returns to `executing`.
  if (
    (finalStatus === "done" || finalStatus === "blocked") &&
    updatedRecord?.plan.metadata.type === "implementation" &&
    updatedRecord.plan.metadata.parentPlan
  ) {
    const parent = findPlan(
      input.dataDir,
      updatedRecord.plan.metadata.parentPlan,
    );
    if (parent && parent.plan.metadata.status === "executing") {
      recordTransition(parent, finalStatus, input.dataDir);
    }
  }

  const out: ExecutePlanResult = {
    finalText: text,
    done,
    blocked,
    amended: amendment !== null,
    numTurns: result.numTurns,
    toolCallCount: 0, // SDK doesn't expose tool-call count separately; numTurns is the proxy
    subtype: result.subtype,
    ...(amendment !== null && { amendmentReason: amendment.reason }),
    ...(amendment !== null && { amendmentProposal: amendment.proposal }),
  };
  if (branchMatch && branchMatch[1]) {
    out.branch = branchMatch[1].trim();
  }
  if (prMatch && prMatch[1]) {
    const candidate = prMatch[1].trim();
    if (candidate && !/^(none|n\/a|not[- ]opened)/i.test(candidate)) {
      out.prUrl = candidate;
    }
  }
  return out;
}

function recordTransition(
  record: PlanRecord,
  to: PlanStatus,
  dataDir: string,
): void {
  const next = transitionPlan(record.plan, to);
  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: {
          planId: record.id,
          from: record.plan.metadata.status,
          to,
          actor: "developer",
        },
      });
    })();
  } finally {
    db.close();
  }
  savePlan(record.path, next);
}

// ---------- prompt loading ----------

const promptCache: Record<string, string> = {};
function loadDeveloperPrompt(filename: string): string {
  if (promptCache[filename]) return promptCache[filename]!;
  const promptPath = path.join(defaultRepoRoot(), "prompts", filename);
  promptCache[filename] = fs.readFileSync(promptPath, "utf8");
  return promptCache[filename]!;
}

// ---------- Mode detection (shared by CLI runRun + daemon plan-executor) ----------

export type DeveloperMode = "draft-impl" | "execute";

/**
 * Returns the Developer mode for a plan, or null if Developer doesn't apply.
 * Matches §4: improvement + ImplementationReview required (or auto-resolved-
 * to-required on new-feature/rework subtypes) → draft impl plan.
 * implementation type or improvement with skip → execute. Anything else →
 * null (e.g., business plans, marketing plans, or plans not in approved
 * state).
 */
export function detectDeveloperMode(plan: Plan): DeveloperMode | null {
  if (plan.metadata.status !== "approved") return null;
  if (plan.metadata.type === "implementation") return "execute";
  if (plan.metadata.type !== "improvement") return null;

  const subtype = plan.metadata.subtype;
  const review = plan.metadata.implementationReview ?? "auto";
  if (review === "required") return "draft-impl";
  if (review === "skip") return "execute";
  // auto
  if (subtype === "new-feature" || subtype === "rework") return "draft-impl";
  return "execute";
}

// ---------------------------------------------------------------------------
// §12 amendment flow — Developer surfaces "this plan is wrong, propose change"
//
// The system prompt instructs Developer to halt and reply with an `AMEND`
// block when one of the §12 triggers fires. executePlan() detects that
// block, captures a checkpoint of the current branch state, appends the
// amendment proposal to the plan body, and transitions the plan from
// `executing` to `awaiting-review`. The user reviews the amended plan
// through the normal approve/revise/reject CLI surfaces; resume from
// the checkpoint lands in slice 3.
// ---------------------------------------------------------------------------

export interface ParsedAmendment {
  reason: string;
  proposal: string;
}

/**
 * Parses the `AMEND` block out of Developer's response. Returns null if
 * the response isn't an amendment. Format expected:
 *
 *     AMEND
 *     Reason: <one-line reason>
 *
 *     <proposal markdown — multi-line, runs to EOF>
 *
 * The `AMEND` line must be on its own line (line-anchored). The Reason
 * line follows directly. The proposal starts after the first blank line
 * and runs to the end of the response.
 */
export function parseAmendmentResponse(text: string): ParsedAmendment | null {
  const lines = text.split(/\r?\n/);
  const markerIdx = lines.findIndex((l) => l.trim() === "AMEND");
  if (markerIdx === -1) return null;

  // Walk forward to find Reason: line (skipping the AMEND marker)
  let reasonIdx = -1;
  for (let i = markerIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("Reason:")) {
      reasonIdx = i;
      break;
    }
    return null; // first non-blank line wasn't Reason — malformed
  }
  if (reasonIdx === -1) return null;

  const reason = lines[reasonIdx]!.replace(/^Reason:\s*/, "").trim();
  if (reason.length === 0) return null;

  // Proposal = everything after the next blank line; collapse leading
  // blanks but preserve internal structure.
  let proposalStart = reasonIdx + 1;
  while (
    proposalStart < lines.length &&
    lines[proposalStart]!.trim() === ""
  ) {
    proposalStart += 1;
  }
  const proposal = lines
    .slice(proposalStart)
    .join("\n")
    .replace(/\s+$/, "");
  if (proposal.length === 0) return null;

  return { reason, proposal };
}

export interface AmendmentCheckpoint {
  planId: string;
  branch: string;
  sha: string;
  modifiedFiles: Array<{ status: string; path: string }>;
  amendmentReason: string;
  amendmentProposal: string;
  timestamp: string;
}

/**
 * Captures the working-tree state Developer left behind into a JSON
 * checkpoint at `<dataDir>/logs/checkpoints/<planId>.json`. Slice 3
 * (resume) reads this back to restart Developer on the same branch
 * after the user approves the amendment.
 */
export function writeAmendmentCheckpoint(input: {
  dataDir: string;
  repoRoot: string;
  planId: string;
  amendment: ParsedAmendment;
  now?: Date;
}): AmendmentCheckpoint {
  const branch = execSync("git branch --show-current", {
    cwd: input.repoRoot,
    encoding: "utf8",
  }).trim();
  const sha = execSync("git rev-parse HEAD", {
    cwd: input.repoRoot,
    encoding: "utf8",
  }).trim();
  const statusRaw = execSync("git status --porcelain", {
    cwd: input.repoRoot,
    encoding: "utf8",
  });
  const modifiedFiles: AmendmentCheckpoint["modifiedFiles"] = [];
  for (const line of statusRaw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    // Porcelain v1: first 2 cols are status code, then space, then path
    const status = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    if (file.length > 0) modifiedFiles.push({ status, path: file });
  }

  const checkpoint: AmendmentCheckpoint = {
    planId: input.planId,
    branch,
    sha,
    modifiedFiles,
    amendmentReason: input.amendment.reason,
    amendmentProposal: input.amendment.proposal,
    timestamp: (input.now ?? new Date()).toISOString(),
  };

  const dir = checkpointsDir(input.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${input.planId}.json`),
    JSON.stringify(checkpoint, null, 2),
    "utf8",
  );
  return checkpoint;
}

/**
 * Appends an `## Amendment proposal` section to the plan markdown so
 * the user reviewing the plan in `yarn jarvis approve` sees the
 * amendment context inline with the original plan.
 *
 * Multiple amendments stack — each new amendment gets a fresh section
 * with its own timestamp.
 */
export function appendAmendmentToPlan(
  record: PlanRecord,
  amendment: ParsedAmendment,
  now: Date = new Date(),
): void {
  const dateStr = now.toISOString().slice(0, 10);
  const text = fs.readFileSync(record.path, "utf8");
  const trimmed = text.replace(/\s+$/, "");
  const section = [
    "",
    "",
    `## Amendment proposal (mid-execution, ${dateStr})`,
    "",
    `**Reason:** ${amendment.reason}`,
    "",
    amendment.proposal,
    "",
  ].join("\n");
  fs.writeFileSync(record.path, trimmed + section, "utf8");
}

/**
 * True iff there's an `amendment-proposed` event for `planId` with no
 * later `amendment-applied` event. Used by the plan-executor to decide
 * whether a freshly-`approved` plan is a fresh fire or an amendment
 * resume.
 */
export function isAmendmentResume(
  planId: string,
  dataDir: string,
): boolean {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const proposed = db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'amendment-proposed' AND json_extract(payload, '$.planId') = ?",
      )
      .get(planId) as { c: number };
    if (proposed.c === 0) return false;
    const applied = db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'amendment-applied' AND json_extract(payload, '$.planId') = ?",
      )
      .get(planId) as { c: number };
    return proposed.c > applied.c;
  } finally {
    db.close();
  }
}

/**
 * Reads the most recent amendment checkpoint for `planId`. Returns
 * null when no checkpoint file exists or the JSON is malformed.
 */
export function readAmendmentCheckpoint(
  planId: string,
  dataDir: string,
): AmendmentCheckpoint | null {
  const filePath = path.join(checkpointsDir(dataDir), `${planId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as AmendmentCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Removes the checkpoint file for `planId`. No-op when the file is
 * absent. Called after a successful resume so the next execution
 * isn't mis-detected as another resume.
 */
export function removeAmendmentCheckpoint(
  planId: string,
  dataDir: string,
): void {
  const filePath = path.join(checkpointsDir(dataDir), `${planId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // missing or unreadable — best-effort cleanup
  }
}

/**
 * Composes the user prompt for an amendment-resume execution. Includes:
 *   - Previous branch + sha + modified files (so Developer knows the
 *     working state)
 *   - The amendment reason + accepted proposal
 *   - The full plan markdown (which now contains the amendment section)
 *   - An explicit override telling Developer the clean-tree gate
 *     does not apply this run
 */
export function buildResumePrompt(input: {
  planId: string;
  planMarkdown: string;
  parentMarkdown?: string;
  parentPlanId?: string;
  checkpoint: AmendmentCheckpoint;
}): string {
  const lines: string[] = [];
  lines.push(`Plan id: ${input.planId}`);
  lines.push("Resume mode: amendment");
  lines.push("");
  lines.push(
    "This is an amendment resume. The previous execution stopped to surface an amendment, the user approved it, and you're now continuing from where you left off.",
  );
  lines.push("");
  lines.push("Previous run state:");
  lines.push(`  Branch: ${input.checkpoint.branch}`);
  lines.push(`  HEAD: ${input.checkpoint.sha}`);
  if (input.checkpoint.modifiedFiles.length === 0) {
    lines.push("  Modified files: (none — tree was clean at amendment time)");
  } else {
    lines.push("  Modified files in tree:");
    for (const f of input.checkpoint.modifiedFiles) {
      lines.push(`  - ${f.status} ${f.path}`);
    }
  }
  lines.push("");
  lines.push("Why the previous run paused:");
  lines.push(`  ${input.checkpoint.amendmentReason}`);
  lines.push("");
  lines.push("The user-approved amendment proposal:");
  for (const line of input.checkpoint.amendmentProposal.split("\n")) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(
    "The plan markdown below now includes an `## Amendment proposal` section reflecting the accepted change. Treat the amended plan as authoritative.",
  );
  lines.push("");
  lines.push("Plan content:");
  lines.push("");
  lines.push(input.planMarkdown);
  if (input.parentMarkdown && input.parentPlanId) {
    lines.push("");
    lines.push(`Parent improvement plan id: ${input.parentPlanId}`);
    lines.push("Parent plan content:");
    lines.push("");
    lines.push(input.parentMarkdown);
  }
  lines.push("");
  lines.push(
    "Continue execution from the current branch. **The clean-tree gate at step 2 of your workflow does not apply on resume — the dirty tree is expected.** Pick up where you left off, deliver against the (now-amended) acceptance criteria, then commit / push / open the PR per the cash-in gate.",
  );
  return lines.join("\n");
}
