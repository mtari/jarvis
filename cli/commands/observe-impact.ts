import { parseArgs } from "node:util";
import { observeImpact } from "../../agents/analyst.ts";
import brokenLinksCollector from "../../tools/scanners/broken-links.ts";
import contentFreshnessCollector from "../../tools/scanners/content-freshness.ts";
import yarnAuditCollector from "../../tools/scanners/yarn-audit.ts";
import type { SignalCollector } from "../../tools/scanners/types.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis observe-impact <plan-id> [--vault <name>]`
 *
 * Phase 2 post-merge observation. For a plan in `shipped-pending-impact`,
 * re-runs the analyst collectors against the app and decides whether the
 * fix held: the plan transitions to `success` if the original triggering
 * signal is gone, or `null-result` if it's still present.
 *
 * Records an `impact-observed` event with the verdict regardless. Does
 * not auto-fire from the daemon (yet) — this is the manual primitive
 * that future scheduling logic builds on.
 */

export interface ObserveImpactDeps {
  collectors?: ReadonlyArray<SignalCollector>;
}

const DEFAULT_COLLECTORS: ReadonlyArray<SignalCollector> = [
  yarnAuditCollector,
  brokenLinksCollector,
  contentFreshnessCollector,
];

export async function runObserveImpact(
  rawArgs: string[],
  deps: ObserveImpactDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        vault: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`observe-impact: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      "observe-impact: plan-id required. Usage: yarn jarvis observe-impact <plan-id> [--vault <name>]",
    );
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `observe-impact: unexpected extra arguments: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  const collectors = deps.collectors ?? DEFAULT_COLLECTORS;

  let result;
  try {
    result = await observeImpact({
      dataDir,
      planId,
      ...(parsed.values.vault !== undefined && { vault: parsed.values.vault }),
      collectors,
    });
  } catch (err) {
    console.error(
      `observe-impact: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  switch (result.verdict) {
    case "success":
      console.log(
        `✓ ${result.planId} (${result.app}): success — original signal cleared. Plan transitioned to "success".`,
      );
      break;
    case "null-result":
      console.log(
        `– ${result.planId} (${result.app}): null-result — original signal still present (\`${result.signalDedupKey}\`). Plan transitioned to "null-result".`,
      );
      break;
    case "wrong-status":
      console.log(
        `${result.planId} (${result.app}): ${result.message}`,
      );
      break;
    case "no-baseline":
      console.log(
        `${result.planId} (${result.app}): ${result.message}`,
      );
      break;
  }
  return 0;
}
