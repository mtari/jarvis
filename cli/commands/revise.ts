import { parseArgs } from "node:util";
import {
  redraftPlan,
  StrategistError,
} from "../../agents/strategist.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { revisePlan, REVISE_CAP } from "../../orchestrator/plan-lifecycle.ts";
import { dbFile, envFile, getDataDir } from "../paths.ts";

export interface ReviseCommandDeps {
  client?: AnthropicClient;
}

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
  const result = revisePlan(dataDir, dbFile(dataDir), planId, note, {
    actor: "user",
  });

  if (!result.ok) {
    if (result.reason === "at-cap") {
      console.log(
        `⚠ Plan ${planId} has been revised ${result.priorRevisions} times — at the cap of ${result.cap}.`,
      );
      console.log("  Strategist will not auto-redraft another time. Options:");
      console.log("    - Approve the current draft as-is");
      console.log("    - Reject and start over");
      console.log(`    - Edit ${result.record.path} manually, then approve`);
      return 0;
    }
    console.error(`revise: ${result.message}`);
    return 1;
  }

  // Auto-redraft via Strategist.
  loadEnvFile(envFile(dataDir));
  const baseClient: AnthropicClient = deps.client ?? createSdkClient();
  const recorder = buildAgentCallRecorder(baseClient, dbFile(dataDir), {
    app: result.record.app,
    vault: result.record.vault,
    agent: "strategist",
    planId,
    mode: "subscription",
  });
  console.log(
    `✓ Plan ${planId} sent back to draft (round ${result.priorRevisions + 1}/${REVISE_CAP}). Strategist redrafting…`,
  );
  try {
    const redraft = await redraftPlan({
      client: recorder.client,
      planId,
      app: result.record.app,
      vault: result.record.vault,
      dataDir,
    });
    recorder.flush();
    console.log(`✓ Plan ${redraft.planId} redrafted; now awaiting-review.`);
    return 0;
  } catch (err) {
    recorder.flush();
    if (err instanceof StrategistError) {
      console.error(`revise: redraft failed — ${err.message}`);
      console.error(
        `  Plan stays in 'draft' at ${result.record.path}. Set Status to 'awaiting-review' there and re-run revise to retry, or edit content directly.`,
      );
      return 1;
    }
    throw err;
  }
}
