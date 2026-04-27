import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnthropicClient } from "../orchestrator/anthropic-client.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { findPlan, savePlan, type PlanRecord } from "../orchestrator/plan-store.ts";
import type { Plan } from "../orchestrator/plan.ts";
import {
  parsePlan,
  transitionPlan,
  type PlanStatus,
} from "../orchestrator/plan.ts";
import { runAgentLoop, type AgentToolCall } from "../orchestrator/tool-loop.ts";
import { dbFile, planDir, repoRoot as defaultRepoRoot } from "../cli/paths.ts";
import { createDeveloperTools } from "../tools/developer-tools.ts";

export class DeveloperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeveloperError";
  }
}

// ---------- Mode A: draft implementation plan ----------

export interface DraftImplPlanInput {
  client: AnthropicClient;
  parentPlanId: string;
  app: string;
  vault: string;
  dataDir: string;
  repoRoot?: string;
  maxIterations?: number;
  onToolCall?: (call: AgentToolCall) => void;
}

export interface DraftImplPlanResult {
  planId: string;
  planPath: string;
  iterations: number;
}

export async function draftImplementationPlan(
  input: DraftImplPlanInput,
): Promise<DraftImplPlanResult> {
  const repo = input.repoRoot ?? defaultRepoRoot();
  const parent = findPlan(input.dataDir, input.parentPlanId);
  if (!parent) {
    throw new DeveloperError(
      `parent plan ${input.parentPlanId} not found`,
    );
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

  const tools = createDeveloperTools({ repoRoot: repo });
  const readOnly = {
    read_file: tools.read_file,
    list_dir: tools.list_dir,
  };

  const systemPrompt = loadDeveloperPrompt("developer-impl-plan.md");
  const parentMarkdown = fs.readFileSync(parent.path, "utf8");
  const userContext = [
    `Parent improvement plan id: ${input.parentPlanId}`,
    "Parent plan content:",
    "",
    parentMarkdown,
  ].join("\n");

  const result = await runAgentLoop({
    client: input.client,
    system: systemPrompt,
    cacheSystem: true,
    initialMessages: [{ role: "user", content: userContext }],
    tools: readOnly,
    ...(input.maxIterations !== undefined && {
      maxIterations: input.maxIterations,
    }),
    ...(input.onToolCall !== undefined && { onToolCall: input.onToolCall }),
  });

  const planMatch = result.finalText.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch || !planMatch[1]) {
    throw new DeveloperError(
      "Developer's final response had no <plan> block",
    );
  }
  let plan: Plan;
  try {
    plan = parsePlan(planMatch[1].trim());
  } catch (err) {
    throw new DeveloperError(
      `implementation plan failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
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
          iterations: result.iterations,
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
    iterations: result.iterations,
  };
}

// ---------- Mode B: execute ----------

export interface ExecutePlanInput {
  client: AnthropicClient;
  planId: string;
  app: string;
  vault: string;
  dataDir: string;
  repoRoot?: string;
  maxIterations?: number;
  onToolCall?: (call: AgentToolCall) => void;
}

export interface ExecutePlanResult {
  finalText: string;
  branch?: string;
  prUrl?: string;
  done: boolean;
  blocked: boolean;
  iterations: number;
  toolCallCount: number;
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

  const tools = createDeveloperTools({ repoRoot: repo });
  const systemPrompt = loadDeveloperPrompt("developer-execute.md");

  const loopResult = await runAgentLoop({
    client: input.client,
    system: systemPrompt,
    cacheSystem: true,
    initialMessages: [{ role: "user", content: contextLines.join("\n") }],
    tools,
    ...(input.maxIterations !== undefined && {
      maxIterations: input.maxIterations,
    }),
    ...(input.onToolCall !== undefined && { onToolCall: input.onToolCall }),
  });

  const text = loopResult.finalText;
  const blocked = /^BLOCKED\b/m.test(text);
  const done = !blocked && /^DONE\b/m.test(text);
  const branchMatch = text.match(/^Branch:\s*(.+)$/m);
  const prMatch = text.match(/^PR URL:\s*(.+)$/m);

  // Reload record after the executing-transition wrote the file
  const updatedRecord = findPlan(input.dataDir, input.planId);
  if (updatedRecord) {
    if (done) {
      recordTransition(updatedRecord, "done", input.dataDir);
    } else if (blocked) {
      recordTransition(updatedRecord, "blocked", input.dataDir);
    }
    // Otherwise leave at "executing" — caller can inspect and decide.
  }

  const out: ExecutePlanResult = {
    finalText: text,
    done,
    blocked,
    iterations: loopResult.iterations,
    toolCallCount: loopResult.toolCalls.length,
  };
  if (branchMatch && branchMatch[1]) {
    out.branch = branchMatch[1].trim();
  }
  if (prMatch && prMatch[1]) {
    const candidate = prMatch[1].trim();
    if (
      candidate &&
      !/^(none|n\/a|not[- ]opened)/i.test(candidate)
    ) {
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
