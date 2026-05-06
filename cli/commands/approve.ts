import { parseArgs } from "node:util";
import { approvePlan } from "../../orchestrator/plan-lifecycle.ts";
import { dbFile, getDataDir } from "../paths.ts";

export async function runApprove(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        "confirm-destructive": { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`approve: ${(err as Error).message}`);
    return 1;
  }

  const planId = parsed.positionals[0];
  if (!planId) {
    console.error(
      "approve: plan id required. Usage: yarn jarvis approve <id>",
    );
    return 1;
  }

  const dataDir = getDataDir();
  const result = approvePlan(dataDir, dbFile(dataDir), planId, {
    actor: "user",
    ...(parsed.values["confirm-destructive"] === true && {
      confirmDestructive: true,
    }),
  });

  if (!result.ok) {
    if (result.reason === "destructive-not-confirmed") {
      console.error(
        `approve: ${result.message} Re-run with --confirm-destructive.`,
      );
    } else {
      console.error(`approve: ${result.message}`);
    }
    return 1;
  }

  console.log(`✓ Approved plan ${planId}.`);
  if (result.parentTransitioned) {
    console.log(
      `  Parent ${result.parentTransitioned.id} transitioned approved → executing.`,
    );
  }
  const brain = result.brainChangesApplied;
  if (brain && brain.hasChanges) {
    console.log("");
    console.log("  Brain updates:");
    for (const a of brain.applied) {
      console.log(`    ✓ ${a.path} (${a.op}) — set`);
    }
    for (const s of brain.skipped) {
      console.log(`    – ${s.path} (${s.op}) — skipped: ${s.reason}`);
    }
    for (const e of brain.errors) {
      console.log(`    ✗ ${e.path} (${e.op}) — error: ${e.reason}`);
    }
    if (brain.skipped.length > 0 || brain.errors.length > 0) {
      console.log(
        "  Some changes weren't applied; review the plan body and edit brain.json by hand if needed.",
      );
    }
  }
  return 0;
}
