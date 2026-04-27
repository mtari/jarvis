import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import {
  redraftPlan,
  StrategistError,
} from "../../agents/strategist.ts";
import { createAnthropicClient } from "../../orchestrator/anthropic-client.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { findPlan, savePlan } from "../../orchestrator/plan-store.ts";
import { transitionPlan } from "../../orchestrator/plan.ts";
import { dbFile, envFile, getDataDir } from "../paths.ts";

export interface ReviseCommandDeps {
  client?: ReturnType<typeof createAnthropicClient>;
}

const MAX_REVISIONS = 3;

export async function runRevise(
  rawArgs: string[],
  deps: ReviseCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        note: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`revise: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      'revise: plan id and feedback required. Usage: yarn jarvis revise <id> "<feedback>"',
    );
    return 1;
  }

  let note = parsed.values.note;
  if (note === undefined && parsed.positionals.length > 1) {
    note = parsed.positionals.slice(1).join(" ");
  }
  if (!note) {
    console.error(
      'revise: feedback required. Usage: yarn jarvis revise <id> "<feedback>" (or --note "<feedback>")',
    );
    return 1;
  }

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planId);
  if (!record) {
    console.error(`revise: plan ${planId} not found.`);
    return 1;
  }

  const fromStatus = record.plan.metadata.status;
  if (fromStatus !== "awaiting-review") {
    console.error(
      `revise: plan ${planId} is in state "${fromStatus}", not "awaiting-review".`,
    );
    return 1;
  }

  // §4 cap: 3 revisions max. The 4th attempt escalates without
  // recording or transitioning — the plan stays in awaiting-review
  // and the user has to take a different action.
  let priorRevisions = 0;
  {
    const readDb = new Database(dbFile(dataDir), { readonly: true });
    try {
      const row = readDb
        .prepare(
          "SELECT COUNT(*) AS c FROM feedback WHERE kind = 'revise' AND target_id = ?",
        )
        .get(planId) as { c: number };
      priorRevisions = row.c;
    } finally {
      readDb.close();
    }
  }
  if (priorRevisions >= MAX_REVISIONS) {
    console.log(
      `⚠ Plan ${planId} has been revised ${priorRevisions} times — at the cap of ${MAX_REVISIONS}.`,
    );
    console.log("  Strategist will not auto-redraft another time. Options:");
    console.log("    - Approve the current draft as-is");
    console.log("    - Reject and start over");
    console.log(`    - Edit ${record.path} manually, then approve`);
    return 0;
  }

  const next = transitionPlan(record.plan, "draft");

  const db = new Database(dbFile(dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: record.app,
        vaultId: record.vault,
        kind: "plan-transition",
        payload: { planId, from: fromStatus, to: "draft", note },
      });
      recordFeedback(db, {
        kind: "revise",
        actor: "user",
        targetType: "plan",
        targetId: planId,
        note,
      });
    })();
  } finally {
    db.close();
  }

  savePlan(record.path, next);

  // Auto-redraft via Strategist. Falls back gracefully when no API key
  // is configured: the plan stays in 'draft' and the user gets a clear
  // recovery path.
  loadEnvFile(envFile(dataDir));
  if (!deps.client && !process.env["ANTHROPIC_API_KEY"]) {
    console.log(
      `✓ Plan ${planId} sent back to draft with feedback (round ${priorRevisions + 1}/${MAX_REVISIONS}).`,
    );
    console.log(
      `⚠ ANTHROPIC_API_KEY not set — auto-redraft skipped. Set it in ${envFile(dataDir)} or edit ${record.path} manually.`,
    );
    return 0;
  }

  const baseClient = deps.client ?? createAnthropicClient();
  const recorder = buildAgentCallRecorder(baseClient, dbFile(dataDir), {
    app: record.app,
    vault: record.vault,
    agent: "strategist",
    planId,
  });
  console.log(
    `✓ Plan ${planId} sent back to draft (round ${priorRevisions + 1}/${MAX_REVISIONS}). Strategist redrafting…`,
  );
  try {
    const result = await redraftPlan({
      client: recorder.client,
      planId,
      app: record.app,
      vault: record.vault,
      dataDir,
    });
    recorder.flush();
    console.log(`✓ Plan ${result.planId} redrafted; now awaiting-review.`);
    return 0;
  } catch (err) {
    recorder.flush();
    if (err instanceof StrategistError) {
      console.error(`revise: redraft failed — ${err.message}`);
      console.error(
        `  Plan stays in 'draft' at ${record.path}. Set Status to 'awaiting-review' there and re-run revise to retry, or edit content directly.`,
      );
      return 1;
    }
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? "?";
      console.error(
        `revise: Anthropic API error during redraft (status ${status}): ${err.message}`,
      );
      if (err.status === 401 || err.status === 403) {
        console.error(`revise: check ANTHROPIC_API_KEY in ${envFile(dataDir)}.`);
      }
      return 1;
    }
    throw err;
  }
}
