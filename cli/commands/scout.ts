import { parseArgs } from "node:util";
import { autoDraftFromIdeas, scoreUnscoredIdeas } from "../../agents/scout.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis scout score [--vault <name>]`
 *   Scores every idea in `Business_Ideas.md` that doesn't already have
 *   a Score field. Writes the score, scoredAt, and rationale back into
 *   the file, and records one `idea-scored` event per idea.
 *
 *   Re-scoring requires the user to delete the Score line from the
 *   file first — keeps token costs predictable for repeated runs.
 *
 * `yarn jarvis scout draft [--threshold N] [--vault <name>]`
 *   Auto-drafts a Strategist plan for every idea scoring at or above
 *   the threshold (default 80) that isn't already drafted. Records an
 *   `idea-drafted` event per plan; idempotent on idea id.
 */

export interface ScoutDeps {
  /** Override the LLM client (test seam). */
  buildClient?: () => AnthropicClient;
}

export async function runScout(
  rawArgs: string[],
  deps: ScoutDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === "score") return runScoutScore(rest, deps);
  if (subcommand === "draft") return runScoutDraft(rest, deps);
  if (subcommand === undefined) {
    console.error(
      "scout: missing subcommand. Usage: yarn jarvis scout <score|draft> [--vault <name>]",
    );
  } else {
    console.error(
      `scout: unknown subcommand "${subcommand}". Available: score, draft`,
    );
  }
  return 1;
}

async function runScoutScore(
  rest: string[],
  deps: ScoutDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        vault: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`scout score: ${(err as Error).message}`);
    return 1;
  }

  const vault = parsed.values.vault ?? "personal";
  const dataDir = getDataDir();
  const client = deps.buildClient ? deps.buildClient() : createSdkClient();

  const result = await scoreUnscoredIdeas({
    dataDir,
    client,
    vault,
  });

  if (result.scoredCount === 0 && result.errorCount === 0) {
    console.log(
      "scout: no unscored ideas (delete a Score line from Business_Ideas.md to re-score).",
    );
    return 0;
  }

  for (const e of result.entries) {
    if (e.error) {
      console.log(`  ✗ ${e.ideaId} — ${e.error}`);
    } else {
      console.log(
        `  ✓ ${e.ideaId} — score ${e.score} (suggested: ${e.suggestedPriority})`,
      );
    }
  }
  console.log("");
  console.log(
    `Scored ${result.scoredCount}, ${result.errorCount} error(s).`,
  );
  return result.errorCount > 0 ? 1 : 0;
}

async function runScoutDraft(
  rest: string[],
  deps: ScoutDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        vault: { type: "string" },
        threshold: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`scout draft: ${(err as Error).message}`);
    return 1;
  }

  let scoreThreshold: number | undefined;
  if (parsed.values.threshold !== undefined) {
    const n = Number.parseInt(parsed.values.threshold, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      console.error(
        `scout draft: invalid --threshold "${parsed.values.threshold}" (expected integer in [0, 100])`,
      );
      return 1;
    }
    scoreThreshold = n;
  }

  const vault = parsed.values.vault ?? "personal";
  const dataDir = getDataDir();
  const client = deps.buildClient ? deps.buildClient() : createSdkClient();

  const result = await autoDraftFromIdeas({
    dataDir,
    vault,
    client,
    ...(scoreThreshold !== undefined && { scoreThreshold }),
  });

  if (result.entries.length === 0) {
    console.log("scout draft: no ideas in Business_Ideas.md.");
    return 0;
  }

  for (const e of result.entries) {
    if (e.planId) {
      console.log(`  ✓ ${e.ideaId} → drafted ${e.planId}`);
    } else if (e.error) {
      console.log(`  ✗ ${e.ideaId} — ${e.error}`);
    } else {
      console.log(`  – ${e.ideaId} skipped (${e.skippedReason})`);
    }
  }
  console.log("");
  console.log(
    `Drafted ${result.draftedCount}, ${result.errorCount} error(s).`,
  );
  return result.errorCount > 0 ? 1 : 0;
}
