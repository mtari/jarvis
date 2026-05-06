import { parseArgs } from "node:util";
import { runLearnScan } from "../../agents/analyst-learn.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis learn <subcommand>`
 *
 * Phase 4 v1 ships a single subcommand:
 *   scan — one-shot pass over the feedback store + plan transitions.
 *          Surfaces recurring rejection / revise themes + low-approval
 *          plan categories. Prints a report; does NOT auto-draft meta
 *          plans (that lands in a follow-up).
 *
 * The daemon-tick wiring (run learn weekly + on-demand) is the next
 * slice — for now operators run this manually to inspect the signal.
 */

export interface LearnCommandDeps {
  /** Test seam — fixed clock for the recorded event. */
  now?: Date;
}

export async function runLearn(
  rawArgs: string[],
  deps: LearnCommandDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "scan":
      return runLearnScanCli(rest, deps);
    case undefined:
      console.error(
        "learn: missing subcommand. Usage: yarn jarvis learn <scan> [...]",
      );
      return 1;
    default:
      console.error(
        `learn: unknown subcommand "${subcommand}". Available: scan.`,
      );
      return 1;
  }
}

async function runLearnScanCli(
  rest: string[],
  deps: LearnCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        since: { type: "string" },
        limit: { type: "string" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`learn scan: ${(err as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(
      `learn scan: invalid --format "${format}" (expected table | json).`,
    );
    return 1;
  }
  let limit: number | undefined;
  if (v.limit !== undefined) {
    const n = Number.parseInt(v.limit, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`learn scan: invalid --limit "${v.limit}".`);
      return 1;
    }
    limit = n;
  }

  const dataDir = getDataDir();
  const report = runLearnScan({
    dataDir,
    ...(v.since !== undefined && { since: v.since }),
    ...(limit !== undefined && { limit }),
    ...(deps.now !== undefined && { now: deps.now }),
  });

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  console.log("Learn scan");
  console.log(`  Window:    since ${report.since}`);
  console.log(`  Feedback:  ${report.scannedFeedbackRows} rows`);
  console.log(`  Plans:     ${report.scannedPlans} on disk`);
  console.log("");

  if (report.rejectionThemes.length === 0) {
    console.log("Rejection themes: none above threshold.");
  } else {
    console.log("Rejection themes (recurring tokens in reject notes):");
    for (const t of report.rejectionThemes.slice(0, 8)) {
      console.log(
        `  ${t.token}  (${t.count}× — e.g. ${t.examplePlanIds.slice(0, 3).join(", ")})`,
      );
    }
  }
  console.log("");

  if (report.reviseThemes.length === 0) {
    console.log("Revise themes: none above threshold.");
  } else {
    console.log("Revise themes (recurring tokens in revise notes):");
    for (const t of report.reviseThemes.slice(0, 8)) {
      console.log(
        `  ${t.token}  (${t.count}× — e.g. ${t.examplePlanIds.slice(0, 3).join(", ")})`,
      );
    }
  }
  console.log("");

  if (report.lowApprovalRates.length === 0) {
    console.log("Low approval rates: none below threshold.");
  } else {
    console.log("Low approval rates (worst first):");
    for (const lar of report.lowApprovalRates.slice(0, 8)) {
      const subtypeStr = lar.subtype ? `/${lar.subtype}` : "";
      console.log(
        `  ${lar.type}${subtypeStr}  ${lar.approved}/${lar.total}  (${Math.round(lar.rate * 100)}%)`,
      );
    }
  }
  console.log("");

  if (report.recommendations.length === 0) {
    console.log(
      "No recommendations — feedback signal is quiet. Run again when more plans cycle.",
    );
  } else {
    console.log("Recommendations:");
    for (const r of report.recommendations) {
      console.log(`  - ${r}`);
    }
  }
  return 0;
}
