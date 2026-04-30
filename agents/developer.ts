import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  runAgent,
  type RunAgentResult,
  type RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { findPlan, savePlan, type PlanRecord } from "../orchestrator/plan-store.ts";
import type { Plan } from "../orchestrator/plan.ts";
import {
  parsePlan,
  transitionPlan,
  type PlanStatus,
} from "../orchestrator/plan.ts";
import { dbFile, planDir, repoRoot as defaultRepoRoot } from "../cli/paths.ts";
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

const DEFAULT_MAX_TURNS_DRAFT_IMPL = 30;
const DEFAULT_MAX_TURNS_EXECUTE = 60;

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
}

export interface ExecutePlanResult {
  finalText: string;
  branch?: string;
  prUrl?: string;
  done: boolean;
  blocked: boolean;
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

  const developerPromptText = loadDeveloperPrompt("developer-execute.md");

  // Use the claude_code preset's system prompt and append our workflow rules.
  // The preset gives Claude Code's coding instincts (file-edit conventions,
  // commit-message style, etc.); developer-execute.md layers on the Jarvis
  // workflow contract (clean-tree gate, BLOCKED protocol, DONE format).
  const result = await runAgent({
    systemPrompt: "", // ignored when presetSystemPrompt: true
    presetSystemPrompt: true,
    appendSystemPrompt: developerPromptText,
    userPrompt: contextLines.join("\n"),
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
  const blocked =
    /^BLOCKED\b/m.test(text) || result.subtype === "error_max_turns";
  const done = !blocked && /^DONE\b/m.test(text) && result.subtype === "success";
  const branchMatch = text.match(/^Branch:\s*(.+)$/m);
  const prMatch = text.match(/^PR URL:\s*(.+)$/m);

  // Reload record after the executing-transition wrote the file
  const updatedRecord = findPlan(input.dataDir, input.planId);
  let finalStatus: PlanStatus | null = null;
  if (updatedRecord) {
    if (done) {
      recordTransition(updatedRecord, "done", input.dataDir);
      finalStatus = "done";
    } else if (blocked) {
      recordTransition(updatedRecord, "blocked", input.dataDir);
      finalStatus = "blocked";
    }
    // Otherwise leave at "executing" — caller can inspect and decide.
  }

  // §4: when an implementation plan finishes (done or blocked), mirror that
  // on the parent improvement plan. Parent stays put if it's not currently
  // "executing" (e.g., user paused or cancelled it manually).
  if (
    finalStatus !== null &&
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
    numTurns: result.numTurns,
    toolCallCount: 0, // SDK doesn't expose tool-call count separately; numTurns is the proxy
    subtype: result.subtype,
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
