import { parseArgs } from "node:util";
import { scoreUnscoredIdeas } from "../../agents/scout.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis scout score [--vault <name>]`
 *
 * Scores every idea in `Business_Ideas.md` that doesn't already have a
 * Score field. Writes the score, scoredAt, and rationale back into the
 * file, and records one `idea-scored` event per idea.
 *
 * Re-scoring requires the user to delete the Score line from the file
 * first — keeps token costs predictable for repeated runs.
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
  if (subcommand !== "score") {
    if (subcommand === undefined) {
      console.error(
        "scout: missing subcommand. Usage: yarn jarvis scout score [--vault <name>]",
      );
    } else {
      console.error(
        `scout: unknown subcommand "${subcommand}". Available: score`,
      );
    }
    return 1;
  }

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
