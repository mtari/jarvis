import { parseArgs } from "node:util";
import { removeAmendmentCheckpoint } from "../../agents/developer.ts";
import { rejectPlan } from "../../orchestrator/plan-lifecycle.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runReject(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        category: { type: "string" },
        note: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`reject: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      'reject: plan id required. Usage: yarn jarvis reject <id> [--category <cat>] [--note "..."]',
    );
    return 1;
  }

  const dataDir = getDataDir();
  const result = rejectPlan(dataDir, dbFile(dataDir), planId, {
    actor: "user",
    ...(parsed.values.category !== undefined && {
      category: parsed.values.category,
    }),
    ...(parsed.values.note !== undefined && { note: parsed.values.note }),
  });

  if (!result.ok) {
    console.error(`reject: ${result.message}`);
    return 1;
  }

  // Drop any amendment checkpoint that was waiting on this plan. The
  // plan is terminal now (rejected has no outgoing transitions), so
  // the saved branch state would otherwise stay on disk forever.
  // No-op when there's no checkpoint — best-effort cleanup.
  removeAmendmentCheckpoint(planId, dataDir);

  console.log(`✓ Rejected plan ${planId}.`);
  return 0;
}
