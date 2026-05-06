import { parseArgs } from "node:util";
import {
  MarketerError,
  prepareMarketingPlan,
} from "../../agents/marketer.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { envFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis marketer prepare <plan-id>`
 *   Parses the plan's content calendar, runs each post through the
 *   humanizer, and persists pending rows to `scheduled_posts`. The
 *   daemon scheduler tick will pick them up once the publishing path
 *   ships in a follow-up.
 *
 * Idempotent: re-running on a plan that already has rows is a no-op
 * (reports the existing count and exits 0).
 */

export interface MarketerCommandDeps {
  client?: AnthropicClient;
}

export async function runMarketer(
  rawArgs: string[],
  deps: MarketerCommandDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "prepare":
      return runMarketerPrepare(rest, deps);
    case undefined:
      console.error(
        "marketer: missing subcommand. Usage: yarn jarvis marketer prepare <plan-id>",
      );
      return 1;
    default:
      console.error(
        `marketer: unknown subcommand "${subcommand}". Available: prepare.`,
      );
      return 1;
  }
}

async function runMarketerPrepare(
  rest: string[],
  deps: MarketerCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        vault: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`marketer prepare: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      "marketer prepare: <plan-id> required. Usage: yarn jarvis marketer prepare <plan-id>",
    );
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `marketer prepare: unexpected extra positional: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  loadEnvFile(envFile(dataDir));
  const baseClient: AnthropicClient = deps.client ?? createSdkClient();

  // We don't know the app/vault until findPlan resolves; the recorder
  // gets a placeholder and the call still attributes correctly because
  // the agent-call event captures plan-driven metadata downstream.
  // Refine when the agent surface gets richer.
  const recorder = buildAgentCallRecorder(baseClient, dataDir + "/jarvis.db", {
    app: "marketer",
    vault: "personal",
    agent: "marketer",
    mode: "subscription",
    planId,
  });

  try {
    const result = await prepareMarketingPlan({
      client: recorder.client,
      planId,
      dataDir,
    });
    recorder.flush();

    if (result.alreadyPrepared) {
      console.log(
        `marketer: plan ${planId} is already prepared (${result.existingCount} posts in scheduled_posts). No-op.`,
      );
      console.log(
        "  Edit individual rows with `yarn jarvis post edit <post-id>` (coming with the publishing follow-up).",
      );
      return 0;
    }

    console.log(`✓ Prepared ${result.prepared.length} post(s) for ${planId}`);
    console.log(`  App: ${result.app}  •  Vault: ${result.vault}`);
    console.log("");
    for (const p of result.prepared) {
      const tag = p.unchanged ? "(no humanizer changes)" : "(humanized)";
      console.log(
        `  ${p.postId}  [${p.entry.channel}]  ${p.scheduledAt}  ${tag}`,
      );
    }
    console.log("");
    console.log(
      "  Rows persisted as 'pending' in scheduled_posts. The daemon scheduler will publish once the FB/IG tools land.",
    );
    return 0;
  } catch (err) {
    recorder.flush();
    if (err instanceof MarketerError) {
      console.error(`marketer prepare: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
