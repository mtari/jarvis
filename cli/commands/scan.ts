import { parseArgs } from "node:util";
import { runAnalystScan } from "../../agents/analyst.ts";
import { loadBrain } from "../../orchestrator/brain.ts";
import brokenLinksCollector from "../../tools/scanners/broken-links.ts";
import contentFreshnessCollector from "../../tools/scanners/content-freshness.ts";
import yarnAuditCollector from "../../tools/scanners/yarn-audit.ts";
import type {
  SignalCollector,
  Signal,
} from "../../tools/scanners/types.ts";
import { brainFile, getDataDir } from "../paths.ts";
import path from "node:path";

/**
 * Test seam: the production collector list is hard-coded; tests inject an
 * alternative via the `collectors` option. Keeping it minimal until we
 * wire more scanners (lighthouse, axe, broken-links, content-freshness).
 */
export interface ScanCommandDeps {
  collectors?: ReadonlyArray<SignalCollector>;
}

const DEFAULT_COLLECTORS: ReadonlyArray<SignalCollector> = [
  yarnAuditCollector,
  brokenLinksCollector,
  contentFreshnessCollector,
];

export async function runScan(
  rawArgs: string[],
  deps: ScanCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`scan: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  if (!v.app) {
    console.error("scan: --app is required. Usage: yarn jarvis scan --app <name>");
    return 1;
  }
  const vault = v.vault ?? "personal";

  const dataDir = getDataDir();
  let brain;
  try {
    brain = loadBrain(brainFile(dataDir, vault, v.app));
  } catch (err) {
    console.error(
      `scan: could not load brain for app "${v.app}" in vault "${vault}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (!brain.repo) {
    console.error(
      `scan: app "${v.app}" has no brain.repo configured. Re-onboard with --repo to enable scanning.`,
    );
    return 1;
  }

  const cwd = brain.repo.monorepoPath
    ? path.join(brain.repo.rootPath, brain.repo.monorepoPath)
    : brain.repo.rootPath;

  const collectors = deps.collectors ?? DEFAULT_COLLECTORS;
  console.log(
    `Scanning ${v.app} (${cwd}) with ${collectors.length} collector(s)…`,
  );

  const result = await runAnalystScan({
    dataDir,
    app: v.app,
    vault,
    ctx: { cwd, app: v.app },
    collectors,
  });

  console.log("");
  for (const c of result.byCollector) {
    const status = c.error
      ? `✗ ${c.error}`
      : `${c.signalCount} signal(s) in ${c.durationMs}ms`;
    console.log(`  ${c.kind.padEnd(20)}  ${status}`);
  }

  if (result.signals.length > 0) {
    console.log("");
    console.log(`Signals (${result.signals.length}):`);
    for (const s of result.signals) {
      console.log(`  [${s.severity.toUpperCase()}] ${s.summary}`);
    }
  } else {
    console.log("");
    console.log("No signals.");
  }

  return summariseExitCode(result.signals);
}

/**
 * Exit non-zero if any signal is high or critical so `yarn jarvis scan`
 * is usable in CI / pre-commit hooks. Low + medium signals are
 * informational and don't fail the run.
 */
function summariseExitCode(signals: ReadonlyArray<Signal>): number {
  const blocking = signals.some(
    (s) => s.severity === "high" || s.severity === "critical",
  );
  return blocking ? 1 : 0;
}
