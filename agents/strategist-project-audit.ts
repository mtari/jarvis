import Database from "better-sqlite3";
import { runStrategist, StrategistError } from "./strategist.ts";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { listPlans } from "../orchestrator/plan-store.ts";
import { loadBrain, type Brain } from "../orchestrator/brain.ts";
import { notesContextBlock } from "../orchestrator/notes.ts";
import { dbFile, brainFile } from "../cli/paths.ts";

/**
 * Daily project audit (§5, §6). On schedule, for each non-jarvis onboarded
 * app:
 *   1. app-paused gate: skip if brain.projectStatus is paused or maintenance.
 *   2. already-ran-recently gate: skip if project-audit-completed event fired
 *      in the past 24h for this app. Bypassed by --force.
 *   3. backlog-full gate: skip if the app already has ≥ 3 eligible improvement
 *      plans (awaiting-review | approved, subtype ≠ meta). Never bypassed.
 *   4. no-context gate: skip if no plan-transition and no signal events in the
 *      past 7 days for this app. Bypassed by --force.
 *   5. Compose brief from brain snapshot + recent events + notes.
 *   6. Call Strategist; record project-audit-completed event.
 */

const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONTEXT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TARGET_DEPTH = 3;

const BACKLOG_STATUSES: ReadonlySet<string> = new Set([
  "awaiting-review",
  "approved",
]);

export type ProjectAuditSkipReason =
  | "app-paused"
  | "already-ran-recently"
  | "backlog-full"
  | "no-context"
  | "no-signal";

export interface ProjectAuditDraft {
  planId: string;
  planPath: string;
}

export interface ProjectAuditResult {
  ran: boolean;
  skipReason?: ProjectAuditSkipReason;
  drafted: ProjectAuditDraft[];
  errors: string[];
  brainLoaded: boolean;
  transitionsCount: number;
  signalsCount: number;
  mode: "live" | "dry-run";
}

export interface RunProjectAuditInput {
  dataDir: string;
  app: string;
  vault: string;
  client: AnthropicClient;
  now?: Date;
  force?: boolean;
  dryRun?: boolean;
}

export async function runProjectAudit(
  input: RunProjectAuditInput,
): Promise<ProjectAuditResult> {
  const now = input.now ?? new Date();
  const mode: "live" | "dry-run" = input.dryRun ? "dry-run" : "live";

  const baseResult: ProjectAuditResult = {
    ran: false,
    drafted: [],
    errors: [],
    brainLoaded: false,
    transitionsCount: 0,
    signalsCount: 0,
    mode,
  };

  // Gate 1: app-paused
  let brain;
  try {
    brain = loadBrain(brainFile(input.dataDir, input.vault, input.app));
    baseResult.brainLoaded = true;
  } catch {
    return { ...baseResult, skipReason: "no-context" };
  }

  if (
    !input.force &&
    (brain.projectStatus === "paused" || brain.projectStatus === "maintenance")
  ) {
    return { ...baseResult, skipReason: "app-paused" };
  }

  const idempotencySince = new Date(
    now.getTime() - DEFAULT_IDEMPOTENCY_WINDOW_MS,
  ).toISOString();
  const contextSince = new Date(
    now.getTime() - DEFAULT_CONTEXT_WINDOW_MS,
  ).toISOString();

  // Gate 2: already-ran-recently
  if (!input.force) {
    if (hasRecentAuditCompletion(input.dataDir, input.app, idempotencySince)) {
      return { ...baseResult, skipReason: "already-ran-recently" };
    }
  }

  // Gate 3: backlog-full (never bypassed)
  const backlogDepth = countAppBacklogDepth(input.dataDir, input.app);
  if (backlogDepth >= DEFAULT_TARGET_DEPTH) {
    return { ...baseResult, skipReason: "backlog-full" };
  }

  // Fetch context counts
  const transitionsCount = countEventKind(
    input.dataDir,
    input.app,
    "plan-transition",
    contextSince,
  );
  const signalsCount = countEventKind(
    input.dataDir,
    input.app,
    "signal",
    contextSince,
  );
  baseResult.transitionsCount = transitionsCount;
  baseResult.signalsCount = signalsCount;

  // Gate 4: no-context
  if (!input.force) {
    if (transitionsCount === 0 && signalsCount === 0) {
      return { ...baseResult, skipReason: "no-context" };
    }
  }

  // Compose brief
  const brief = composeBrief({
    brain,
    dataDir: input.dataDir,
    vault: input.vault,
    app: input.app,
    transitionsCount,
    signalsCount,
    contextSince,
  });

  // Gate 5: no-signal failsafe
  if (brief.length === 0) {
    return { ...baseResult, skipReason: "no-signal" };
  }

  baseResult.ran = true;

  if (input.dryRun) {
    recordAuditCompletion(input.dataDir, input.app, input.vault, {
      now,
      drafted: [],
      mode: "dry-run",
      transitionsCount,
      signalsCount,
    });
    return { ...baseResult, mode: "dry-run" };
  }

  try {
    const draft = await runStrategist({
      client: input.client,
      brief,
      app: input.app,
      vault: input.vault,
      dataDir: input.dataDir,
      type: "improvement",
      challenge: false,
    });
    baseResult.drafted.push({ planId: draft.planId, planPath: draft.planPath });
  } catch (err) {
    const msg =
      err instanceof StrategistError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    baseResult.errors.push(`strategist error: ${msg}`);
  }

  recordAuditCompletion(input.dataDir, input.app, input.vault, {
    now,
    drafted: baseResult.drafted,
    mode: "live",
    transitionsCount,
    signalsCount,
  });

  return baseResult;
}

// ---------------------------------------------------------------------------
// Backlog-depth measurement
// ---------------------------------------------------------------------------

function countAppBacklogDepth(dataDir: string, app: string): number {
  const records = listPlans(dataDir);
  let depth = 0;
  for (const r of records) {
    if (r.app !== app) continue;
    if (r.plan.metadata.type !== "improvement") continue;
    if (r.plan.metadata.subtype === "meta") continue;
    if (!BACKLOG_STATUSES.has(r.plan.metadata.status)) continue;
    depth += 1;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Event queries
// ---------------------------------------------------------------------------

function hasRecentAuditCompletion(
  dataDir: string,
  app: string,
  sinceIso: string,
): boolean {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM events WHERE kind = 'project-audit-completed'
         AND app_id = ? AND created_at >= ? LIMIT 1`,
      )
      .get(app, sinceIso);
    return row !== undefined;
  } finally {
    db.close();
  }
}

function countEventKind(
  dataDir: string,
  app: string,
  kind: string,
  sinceIso: string,
): number {
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM events WHERE kind = ? AND app_id = ? AND created_at >= ?`,
      )
      .get(kind, app, sinceIso) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Completion recording
// ---------------------------------------------------------------------------

interface RecordAuditArgs {
  now: Date;
  drafted: ProjectAuditDraft[];
  mode: "live" | "dry-run";
  transitionsCount: number;
  signalsCount: number;
}

function recordAuditCompletion(
  dataDir: string,
  app: string,
  vault: string,
  args: RecordAuditArgs,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "project-audit-completed",
      payload: {
        app,
        vault,
        drafted: args.drafted.map((d) => d.planId),
        mode: args.mode,
        transitionsCount: args.transitionsCount,
        signalsCount: args.signalsCount,
      },
      createdAt: args.now.toISOString(),
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Brief composition
// ---------------------------------------------------------------------------

interface ComposeBriefInput {
  brain: Brain;
  dataDir: string;
  vault: string;
  app: string;
  transitionsCount: number;
  signalsCount: number;
  contextSince: string;
}

function composeBrief(args: ComposeBriefInput): string {
  const lines: string[] = [];

  lines.push(
    `Daily project audit for the \`${args.app}\` app (${args.brain.projectName}).`,
  );
  lines.push("");
  lines.push(
    "You are drafting ONE improvement plan for this app based on the context below. Constraints:",
  );
  lines.push(
    "- Subtype must be one of: new-feature, rework, refactor, security-fix, dep-update, bugfix. NOT `meta` — meta plans flow through the learning loop, not this audit.",
  );
  lines.push(
    "- Tie the success metric to a measurable outcome for this specific project.",
  );
  lines.push(
    "- Pick the highest-leverage gap given the signals available.",
  );
  lines.push("");

  lines.push("## Project snapshot");
  lines.push(`- Name: ${args.brain.projectName}`);
  lines.push(`- Type: ${args.brain.projectType}`);
  lines.push(`- Status: ${args.brain.projectStatus}`);
  lines.push(`- Priority: ${args.brain.projectPriority}`);
  if (args.brain.stack) {
    lines.push(`- Stack: ${JSON.stringify(args.brain.stack)}`);
  }
  if (args.brain.scope) {
    lines.push(`- Scope: ${JSON.stringify(args.brain.scope)}`);
  }
  lines.push("");

  lines.push(`## Recent activity (since ${args.contextSince})`);
  lines.push(`- Plan transitions: ${args.transitionsCount}`);
  lines.push(`- Signals recorded: ${args.signalsCount}`);
  lines.push("");

  const notes = notesContextBlock(args.dataDir, args.vault, args.app);
  if (notes !== null) {
    lines.push(notes);
  }

  return lines.join("\n");
}
