import { parseArgs } from "node:util";
import { computeTelemetry } from "../../agents/analyst-telemetry.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis telemetry [--since <iso>] [--format table|json]`
 *
 * Phase 4 self-telemetry — system-quality metrics derived from the
 * event log. No agent calls. The same metrics feed into the
 * learning-loop drafter, but here they're for the operator to read
 * and to verify the loop's interventions actually improve things
 * over time.
 */

export interface TelemetryCommandDeps {
  /** Test seam — fixed clock for the recorded telemetry-computed event. */
  now?: Date;
}

export async function runTelemetry(
  rawArgs: string[],
  deps: TelemetryCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        since: { type: "string" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`telemetry: ${(err as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(
      `telemetry: invalid --format "${format}" (expected table | json).`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  const report = computeTelemetry({
    dataDir,
    ...(v.since !== undefined && { since: v.since }),
    ...(deps.now !== undefined && { now: deps.now }),
  });

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  console.log(`Telemetry — last ${report.windowDays} day(s) (since ${report.since})`);
  console.log("");

  console.log("Plan transitions:");
  const t = report.planTransitions;
  console.log(`  drafted              ${t.drafted}`);
  console.log(`  approved             ${t.approved}`);
  console.log(`  revised (back-to-draft)  ${t.revised}`);
  console.log(`  rejected             ${t.rejected}`);
  console.log(`  executing            ${t.executing}`);
  console.log(`  done                 ${t.done}`);
  console.log(`  shipped-pending      ${t.shippedPendingImpact}`);
  console.log(`  success              ${t.success}`);
  console.log(`  null-result          ${t.nullResult}`);
  console.log(`  regression           ${t.regression}`);
  console.log(`  cancelled            ${t.cancelled}`);
  console.log("");

  console.log("Override rate (reject + revise) per plan-type:");
  if (report.overrideRates.length === 0) {
    console.log("  (no review decisions recorded in this window)");
  } else {
    for (const r of report.overrideRates) {
      console.log(
        `  ${r.type.padEnd(16)} ${(r.rate * 100).toFixed(0).padStart(3)}%   approved=${r.approved} rejected=${r.rejected} revised=${r.revised} (n=${r.reviewed})`,
      );
    }
  }
  console.log("");

  console.log(`Average revise rounds:   ${report.averageReviseRounds.toFixed(2)}`);
  console.log("");

  console.log("Escalations:");
  console.log(`  recorded:     ${report.escalations.recorded}`);
  console.log(`  acknowledged: ${report.escalations.acknowledged}`);
  console.log(`  outstanding:  ${report.escalations.outstanding}`);
  console.log("");

  console.log("Learning loop:");
  console.log(`  scans completed:    ${report.learningLoop.scansCompleted}`);
  console.log(`  meta plans drafted: ${report.learningLoop.metaPlansDrafted}`);
  return 0;
}
