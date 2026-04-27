import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  createStdinPrompter,
  isStrategistPlanType,
  runStrategist,
  StrategistError,
  type Prompter,
  type StrategistPlanType,
} from "../../agents/strategist.ts";
import { createAnthropicClient } from "../../orchestrator/anthropic-client.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import {
  improvementSubtypeSchema,
  marketingSubtypeSchema,
} from "../../orchestrator/plan.ts";
import { envFile, getDataDir } from "../paths.ts";

export interface PlanCommandDeps {
  client?: ReturnType<typeof createAnthropicClient>;
  prompter?: Prompter;
}

export async function runPlan(
  rawArgs: string[],
  deps: PlanCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        type: { type: "string" },
        subtype: { type: "string" },
        vault: { type: "string" },
        "no-challenge": { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`plan: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  if (!v.app) {
    console.error(
      'plan: --app is required. Usage: yarn jarvis plan --app <name> "<brief>"',
    );
    return 1;
  }
  if (parsed.positionals.length === 0) {
    console.error(
      'plan: brief required. Usage: yarn jarvis plan --app <name> "<brief>"',
    );
    return 1;
  }
  const brief = parsed.positionals.join(" ").trim();
  if (!brief) {
    console.error("plan: brief cannot be empty.");
    return 1;
  }

  // Validate --type
  let planType: StrategistPlanType = "improvement";
  if (v.type !== undefined) {
    if (!isStrategistPlanType(v.type)) {
      console.error(
        `plan: invalid --type "${v.type}". Strategist drafts: improvement | business | marketing.`,
      );
      return 1;
    }
    planType = v.type;
  }

  // Validate --subtype against the chosen type
  if (v.subtype !== undefined) {
    if (planType === "improvement") {
      if (!improvementSubtypeSchema.safeParse(v.subtype).success) {
        console.error(
          `plan: invalid --subtype "${v.subtype}" for improvement plans.`,
        );
        return 1;
      }
    } else if (planType === "marketing") {
      if (!marketingSubtypeSchema.safeParse(v.subtype).success) {
        console.error(
          `plan: invalid --subtype "${v.subtype}" for marketing plans (use campaign or single-post).`,
        );
        return 1;
      }
    } else if (planType === "business") {
      console.error(
        `plan: --subtype is not used for business plans; remove it.`,
      );
      return 1;
    }
  }

  const dataDir = getDataDir();
  loadEnvFile(envFile(dataDir));

  if (!deps.client && !process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      `plan: ANTHROPIC_API_KEY is not set. Edit ${envFile(dataDir)} and try again.`,
    );
    return 1;
  }

  const client = deps.client ?? createAnthropicClient();
  const prompter =
    deps.prompter ?? (v["no-challenge"] ? undefined : createStdinPrompter());

  try {
    const result = await runStrategist({
      client,
      brief,
      app: v.app,
      vault: v.vault ?? "personal",
      dataDir,
      type: planType,
      ...(v.subtype !== undefined && { subtype: v.subtype }),
      challenge: !v["no-challenge"],
      ...(prompter !== undefined && { prompter }),
    });

    console.log(`✓ Drafted plan ${result.planId}`);
    console.log(`  Path: ${result.planPath}`);
    console.log(`  Clarification rounds: ${result.rounds}`);
    console.log(
      `  Review: yarn jarvis plans --pending-review (then approve / revise / reject)`,
    );
    return 0;
  } catch (err) {
    if (err instanceof StrategistError) {
      console.error(`plan: ${err.message}`);
      return 1;
    }
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? "?";
      console.error(`plan: Anthropic API error (status ${status}): ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        console.error(`plan: check ANTHROPIC_API_KEY in ${envFile(dataDir)}.`);
      }
      return 1;
    }
    throw err;
  }
}
