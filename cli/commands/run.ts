import {
  detectDeveloperMode,
  draftImplementationPlan,
  DeveloperError,
  executePlan,
} from "../../agents/developer.ts";
import { RateLimitedError } from "../../orchestrator/agent-sdk-runtime.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import type { RunAgentTransport } from "../../orchestrator/agent-sdk-runtime.ts";
import { envFile, getDataDir } from "../paths.ts";

export { detectDeveloperMode };

export interface RunCommandDeps {
  /** Test injection — overrides the SDK transport for both draft-impl + execute. */
  transport?: RunAgentTransport;
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

  try {
    if (mode === "draft-impl") {
      const result = await draftImplementationPlan({
        parentPlanId: planId,
        app: record.app,
        vault: record.vault,
        dataDir,
        ...(deps.transport !== undefined && { transport: deps.transport }),
      });
      console.log(`✓ Drafted implementation plan ${result.planId}`);
      console.log(`  Path: ${result.planPath}`);
      console.log(`  Turns: ${result.numTurns}`);
      console.log(
        `  Review: yarn jarvis plans --pending-review (then approve / revise / reject)`,
      );
      return 0;
    }

    const result = await executePlan({
      planId,
      app: record.app,
      vault: record.vault,
      dataDir,
      ...(deps.transport !== undefined && { transport: deps.transport }),
    });

    console.log(result.finalText);
    console.log("");
    if (result.done) {
      console.log(`✓ Executed plan ${planId}`);
      console.log(`  Turns: ${result.numTurns}`);
      if (result.branch) console.log(`  Branch: ${result.branch}`);
      if (result.prUrl) console.log(`  PR URL: ${result.prUrl}`);
      return 0;
    }
    if (result.blocked) {
      console.error(`✗ Developer blocked on plan ${planId}`);
      console.error(`  Turns: ${result.numTurns}`);
      console.error(`  Subtype: ${result.subtype}`);
      console.error(`  Inspect with: yarn jarvis plans --status blocked`);
      return 1;
    }
    console.error(
      `run developer: plan ${planId} ended without DONE or BLOCKED. State left at "executing"; inspect manually.`,
    );
    return 1;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      const reset = err.resetsAt
        ? ` Resets at ${err.resetsAt.toISOString()}.`
        : "";
      console.error(
        `run developer: rate limit hit on Claude Code subscription (${err.rateLimitType ?? "unknown"}).${reset}`,
      );
      return 1;
    }
    if (err instanceof DeveloperError) {
      console.error(`run developer: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
