import { parseArgs } from "node:util";
import {
  runFridayAudit,
  type FridayAuditResult,
} from "../../agents/strategist-friday-audit.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis friday-audit [--dry-run] [--force] [--format table|json]`
 *
 * Manual trigger for the Friday self-audit. Normally the daemon runs
 * this hourly; this command is for operators who want to test the
 * gates, see the bundled brief without drafting (--dry-run), or
 * override the day-of-week + throughput gates (--force).
 */

export interface FridayAuditCommandDeps {
  /** Test seam — override the SDK client. */
  buildClient?: () => AnthropicClient;
  /** Test seam — fixed clock. */
  now?: Date;
}

export async function runFridayAuditCommand(
  rawArgs: string[],
  deps: FridayAuditCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`friday-audit: ${(err as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(
      `friday-audit: invalid --format "${format}" (expected table | json).`,
    );
    return 1;
  }

  const client = deps.buildClient ? deps.buildClient() : createSdkClient();
  let result: FridayAuditResult;
  try {
    result = await runFridayAudit({
      dataDir: getDataDir(),
      client,
      ...(v["dry-run"] === true && { dryRun: true }),
      ...(v.force === true && { force: true }),
      ...(deps.now !== undefined && { now: deps.now }),
    });
  } catch (err) {
    console.error(
      `friday-audit: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  if (!result.ran) {
    console.log(`Friday audit skipped: ${result.skipReason}`);
    console.log(`  backlog depth (jarvis): ${result.backlogDepth}`);
    console.log(`  project shipments (last 7d): ${result.projectShipments}`);
    return 0;
  }

  console.log("Friday audit ran.");
  console.log(`  backlog depth (jarvis, before): ${result.backlogDepth}`);
  console.log(`  project shipments (last 7d): ${result.projectShipments}`);
  if (result.drafted.length === 0) {
    console.log("  Drafted: (none — dry-run or no slots)");
  } else {
    console.log(`  Drafted ${result.drafted.length} plan(s):`);
    for (const d of result.drafted) {
      console.log(`    - ${d.planId}  (${d.planPath})`);
    }
  }
  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of result.errors) console.log(`    - ${e}`);
  }
  return 0;
}
