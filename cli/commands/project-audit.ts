import { parseArgs } from "node:util";
import {
  runProjectAudit,
  type ProjectAuditResult,
} from "../../agents/strategist-project-audit.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { listOnboardedApps, type OnboardedApp } from "../../orchestrator/brain.ts";
import { getDataDir } from "../paths.ts";

/**
 * `yarn jarvis project-audit --app <name> | --all [--dry-run] [--force]`
 *
 * Manual trigger for the per-app project audit. Normally the daemon runs
 * this hourly (each app's own 24h idempotency window enforces once-per-day);
 * this command is for operators who want to test the gates, compose briefs
 * without drafting (--dry-run), or override the already-ran + no-context
 * gates (--force).
 */

const USAGE = `usage: yarn jarvis project-audit --app <name> | --all [--dry-run] [--force] [--no-research]

  --app <name>   Run audit for one app by name
  --all          Run audit for all onboarded apps except jarvis
  --dry-run      Compose brief and record event but skip Strategist call
  --force        Bypass app-paused, already-ran-recently, and no-context gates
  --no-research  Skip external research (fast / offline)
`;

export interface ProjectAuditCommandDeps {
  buildClient?: () => AnthropicClient;
  now?: Date;
  listApps?: (dataDir: string) => OnboardedApp[];
}

export async function runProjectAuditCommand(
  rawArgs: string[],
  deps: ProjectAuditCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        all: { type: "boolean" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        "no-research": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`project-audit: ${(err as Error).message}\n`);
    return 1;
  }

  const v = parsed.values;
  const dryRun = v["dry-run"] === true;
  const force = v.force === true;
  const disableResearch = v["no-research"] === true;

  if (!v.app && !v.all) {
    process.stderr.write(USAGE);
    return 1;
  }

  if (v.app && v.all) {
    process.stderr.write(
      "project-audit: --app and --all are mutually exclusive.\n",
    );
    return 1;
  }

  const dataDir = getDataDir();
  const getAllApps = deps.listApps ?? listOnboardedApps;
  const client = deps.buildClient ? deps.buildClient() : createSdkClient();

  if (v.app) {
    const appName = v.app;
    const apps = getAllApps(dataDir);
    const found = apps.find((a) => a.app === appName);
    if (!found) {
      process.stderr.write(
        `project-audit: app not found: "${appName}". Run 'yarn jarvis onboard' first.\n`,
      );
      return 1;
    }
    const result = await runProjectAudit({
      dataDir,
      app: found.app,
      vault: found.vault,
      client,
      dryRun,
      force,
      disableResearch,
      ...(deps.now !== undefined && { now: deps.now }),
    });
    printResult(found.app, result);
    return 0;
  }

  // --all
  const apps = getAllApps(dataDir).filter((a) => a.app !== "jarvis");
  for (const { app, vault } of apps) {
    let result: ProjectAuditResult;
    try {
      result = await runProjectAudit({
        dataDir,
        app,
        vault,
        client,
        dryRun,
        force,
        disableResearch,
        ...(deps.now !== undefined && { now: deps.now }),
      });
    } catch (err) {
      process.stderr.write(
        `project-audit: ${app}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    printResult(app, result);
  }
  return 0;
}

function printResult(app: string, result: ProjectAuditResult): void {
  if (!result.ran) {
    console.log(
      `[${app}] skipped: ${result.skipReason ?? "unknown"}`,
    );
    return;
  }
  if (result.drafted.length === 0) {
    console.log(`[${app}] ran — mode: ${result.mode}, drafted: (none)`);
  } else {
    console.log(
      `[${app}] ran — mode: ${result.mode}, drafted: ${result.drafted.map((d) => d.planId).join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stderr.write(`[${app}] error: ${e}\n`);
    }
  }
}
