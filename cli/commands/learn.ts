import { parseArgs } from "node:util";
import {
  draftMetaPlansFromScan,
  runLearnScan,
  DEFAULT_DRAFT_THRESHOLD,
} from "../../agents/analyst-learn.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { dbFile, envFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis learn <subcommand>` — Phase 4 surface.
 *
 *   scan  — pure read. Walks the feedback store + plan transitions
 *           and prints a report. Records a learn-scan-completed event.
 *   draft — runs scan, picks findings above the threshold, asks
 *           Strategist to draft a meta plan per finding. Idempotent
 *           against the last 14 days via learn-meta-drafted events.
 *
 * The daemon-tick wiring (run weekly + on-demand) is the next slice.
 */

export interface LearnCommandDeps {
  /** Test seam — fixed clock for recorded events. */
  now?: Date;
  /** Test seam — overrides the LLM client used for draft. */
  buildClient?: () => AnthropicClient;
}

export async function runLearn(
  rawArgs: string[],
  deps: LearnCommandDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "scan":
      return runLearnScanCli(rest, deps);
    case "draft":
      return runLearnDraftCli(rest, deps);
    case undefined:
      console.error(
        "learn: missing subcommand. Usage: yarn jarvis learn <scan|draft> [...]",
      );
      return 1;
    default:
      console.error(
        `learn: unknown subcommand "${subcommand}". Available: scan, draft.`,
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

async function runLearnDraftCli(
  rest: string[],
  deps: LearnCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        threshold: { type: "string" },
        "max-drafts": { type: "string" },
        since: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`learn draft: ${(err as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  let threshold: number | undefined;
  if (v.threshold !== undefined) {
    const n = Number.parseInt(v.threshold, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`learn draft: invalid --threshold "${v.threshold}".`);
      return 1;
    }
    threshold = n;
  }
  let maxDrafts: number | undefined;
  if (v["max-drafts"] !== undefined) {
    const n = Number.parseInt(v["max-drafts"], 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`learn draft: invalid --max-drafts "${v["max-drafts"]}".`);
      return 1;
    }
    maxDrafts = n;
  }

  const dataDir = getDataDir();
  loadEnvFile(envFile(dataDir));
  const baseClient: AnthropicClient = deps.buildClient
    ? deps.buildClient()
    : createSdkClient();
  const recorder = buildAgentCallRecorder(baseClient, dbFile(dataDir), {
    app: "jarvis",
    vault: "personal",
    agent: "strategist",
    mode: "subscription",
  });

  // Run scan first so the operator sees the same input the drafter
  // sees. Pass the scan to draftMetaPlansFromScan to avoid scanning twice.
  const report = runLearnScan({
    dataDir,
    ...(v.since !== undefined && { since: v.since }),
  });
  console.log(
    `Scanned ${report.scannedFeedbackRows} feedback rows. Threshold: ${threshold ?? DEFAULT_DRAFT_THRESHOLD}.`,
  );

  let result;
  try {
    result = await draftMetaPlansFromScan({
      dataDir,
      client: recorder.client,
      report,
      ...(threshold !== undefined && { threshold }),
      ...(maxDrafts !== undefined && { maxDrafts }),
      ...(deps.now !== undefined && { now: deps.now }),
    });
    recorder.flush();
  } catch (err) {
    recorder.flush();
    console.error(
      `learn draft: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (
    result.drafted.length === 0 &&
    result.skipped.length === 0 &&
    result.errors.length === 0
  ) {
    console.log("No findings above threshold — nothing to draft.");
    return 0;
  }
  if (result.drafted.length > 0) {
    console.log("");
    console.log(`Drafted ${result.drafted.length} meta plan(s):`);
    for (const d of result.drafted) {
      console.log(`  ✓ ${d.planId}`);
      console.log(`    ${d.planPath}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log("");
    console.log(`Skipped ${result.skipped.length}:`);
    for (const s of result.skipped) {
      console.log(`  – ${describeFinding(s.finding)} — ${s.reason}`);
    }
  }
  if (result.errors.length > 0) {
    console.log("");
    console.log(`Errored ${result.errors.length}:`);
    for (const e of result.errors) {
      console.log(`  ✗ ${describeFinding(e.finding)} — ${e.reason}`);
    }
  }
  if (result.drafted.length > 0) {
    console.log("");
    console.log(
      `  Review with: yarn jarvis plans --pending-review --app jarvis`,
    );
  }
  return result.errors.length > 0 ? 1 : 0;
}

function describeFinding(
  f:
    | { kind: "rejection-theme" | "revise-theme"; token: string; count: number }
    | { kind: "low-approval"; type: string; subtype: string | null; total: number },
): string {
  if (f.kind === "low-approval") {
    return `low-approval ${f.type}${f.subtype ? `/${f.subtype}` : ""} (n=${f.total})`;
  }
  return `${f.kind} "${f.token}" (n=${f.count})`;
}
