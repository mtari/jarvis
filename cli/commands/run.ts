import Anthropic from "@anthropic-ai/sdk";
import {
  draftImplementationPlan,
  DeveloperError,
  executePlan,
} from "../../agents/developer.ts";
import { createAnthropicClient } from "../../orchestrator/anthropic-client.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import type { Plan } from "../../orchestrator/plan.ts";
import { envFile, getDataDir } from "../paths.ts";

export interface RunCommandDeps {
  client?: ReturnType<typeof createAnthropicClient>;
}

type DeveloperMode = "draft-impl" | "execute";

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

export async function runRun(
  rawArgs: string[],
  deps: RunCommandDeps = {},
): Promise<number> {
  const [agent, planId, ...rest] = rawArgs;
  if (!agent) {
    console.error(
      "run: agent name required. Usage: yarn jarvis run <agent> <plan-id>",
    );
    return 1;
  }
  if (agent !== "developer") {
    console.error(
      `run: agent "${agent}" not implemented in Phase 0. Only "developer" is wired.`,
    );
    return 1;
  }
  if (!planId) {
    console.error(
      "run developer: plan id required. Usage: yarn jarvis run developer <plan-id>",
    );
    return 1;
  }
  if (rest.length > 0) {
    console.error(
      `run developer: unexpected extra arguments: ${rest.join(" ")}`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  const record = findPlan(dataDir, planId);
  if (!record) {
    console.error(`run developer: plan ${planId} not found.`);
    return 1;
  }
  const mode = detectDeveloperMode(record.plan);
  if (mode === null) {
    console.error(
      `run developer: plan ${planId} is not in a runnable state ` +
        `(type=${record.plan.metadata.type}, status=${record.plan.metadata.status}).`,
    );
    return 1;
  }

  loadEnvFile(envFile(dataDir));
  if (!deps.client && !process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      `run developer: ANTHROPIC_API_KEY is not set. Edit ${envFile(dataDir)} and try again.`,
    );
    return 1;
  }
  const client = deps.client ?? createAnthropicClient();

  try {
    if (mode === "draft-impl") {
      const result = await draftImplementationPlan({
        client,
        parentPlanId: planId,
        app: record.app,
        vault: record.vault,
        dataDir,
      });
      console.log(`✓ Drafted implementation plan ${result.planId}`);
      console.log(`  Path: ${result.planPath}`);
      console.log(`  Iterations: ${result.iterations}`);
      console.log(
        `  Review: yarn jarvis plans --pending-review (then approve / revise / reject)`,
      );
      return 0;
    }

    const result = await executePlan({
      client,
      planId,
      app: record.app,
      vault: record.vault,
      dataDir,
    });

    console.log(result.finalText);
    console.log("");
    if (result.done) {
      console.log(`✓ Executed plan ${planId}`);
      console.log(`  Iterations: ${result.iterations}`);
      console.log(`  Tool calls: ${result.toolCallCount}`);
      if (result.branch) console.log(`  Branch: ${result.branch}`);
      if (result.prUrl) console.log(`  PR URL: ${result.prUrl}`);
      return 0;
    }
    if (result.blocked) {
      console.error(`✗ Developer blocked on plan ${planId}`);
      console.error(`  Iterations: ${result.iterations}`);
      console.error(`  Tool calls: ${result.toolCallCount}`);
      console.error(`  Inspect with: yarn jarvis plans --status blocked`);
      return 1;
    }
    console.error(
      `run developer: plan ${planId} ended without DONE or BLOCKED. State left at "executing"; inspect manually.`,
    );
    return 1;
  } catch (err) {
    if (err instanceof DeveloperError) {
      console.error(`run developer: ${err.message}`);
      return 1;
    }
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? "?";
      console.error(
        `run developer: Anthropic API error (status ${status}): ${err.message}`,
      );
      if (err.status === 401 || err.status === 403) {
        console.error(
          `run developer: check ANTHROPIC_API_KEY in ${envFile(dataDir)}.`,
        );
      }
      return 1;
    }
    throw err;
  }
}
