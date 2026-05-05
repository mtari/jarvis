import type { KnownBlock } from "@slack/types";
import type {
  AutoDraftFromIdeasResult,
  ScoreUnscoredIdeasResult,
} from "../../agents/scout.ts";
import { listPlans } from "../../orchestrator/plan-store.ts";
import { listPendingSetupTasks } from "../../orchestrator/setup-tasks.ts";
import {
  buildTriageReport,
  formatMarkdown,
} from "../../cli/commands/triage.ts";
import { readPendingAmendmentPlanIds } from "../../cli/commands/inbox.ts";
import { dbFile } from "../../cli/paths.ts";
import { buildTriageReportBlocks } from "./blocks/triage-report.ts";

/**
 * Pure-ish helpers backing the `/jarvis` slash subcommands. Bolt-side
 * handlers in `handlers.ts` parse the command, invoke these, and
 * deliver the result. Keeping the rendering / data-gathering logic
 * here means tests don't need a Bolt mock.
 */

// ---------------------------------------------------------------------------
// /jarvis inbox — pending plan reviews + setup tasks, ephemeral
// ---------------------------------------------------------------------------

export interface InboxSummaryDeps {
  dataDir: string;
}

/**
 * Returns the text body for an `/jarvis inbox` ephemeral response. The
 * shape mirrors `yarn jarvis inbox` so the muscle memory carries.
 *
 * Sections:
 *   - Pending amendment reviews (when any) — tagged separately
 *   - Pending plan reviews — fresh awaiting-review plans
 *   - Pending setup tasks — count + first three titles
 *
 * Empty inbox returns a short "Inbox is empty." line so the user
 * sees something rather than silence.
 */
export function buildInboxSummaryText(deps: InboxSummaryDeps): string {
  const plans = listPlans(deps.dataDir).filter(
    (p) => p.plan.metadata.status === "awaiting-review",
  );
  const amendmentIds = readPendingAmendmentPlanIds(dbFile(deps.dataDir));
  const amendments = plans.filter((p) => amendmentIds.has(p.id));
  const reviews = plans.filter((p) => !amendmentIds.has(p.id));
  const setupTasks = listPendingSetupTasks(deps.dataDir);

  if (
    amendments.length === 0 &&
    reviews.length === 0 &&
    setupTasks.length === 0
  ) {
    return "Inbox is empty.";
  }

  const lines: string[] = [];

  if (amendments.length > 0) {
    lines.push(`*Pending amendment reviews (${amendments.length}):*`);
    for (const p of amendments) {
      const subtype = p.plan.metadata.subtype
        ? `/${p.plan.metadata.subtype}`
        : "";
      lines.push(
        `• \`${p.id}\`  [${p.plan.metadata.type}${subtype}]  *[AMEND]*  [${p.plan.metadata.priority}]  ${p.plan.metadata.title}`,
      );
    }
  }

  if (reviews.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`*Pending plan reviews (${reviews.length}):*`);
    for (const p of reviews) {
      const subtype = p.plan.metadata.subtype
        ? `/${p.plan.metadata.subtype}`
        : "";
      lines.push(
        `• \`${p.id}\`  [${p.plan.metadata.type}${subtype}]  [${p.plan.metadata.priority}]  ${p.plan.metadata.title}`,
      );
    }
  }

  if (setupTasks.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`*Pending setup tasks (${setupTasks.length}):*`);
    for (const task of setupTasks.slice(0, 3)) {
      lines.push(`• \`${task.id}\` — ${task.title}`);
    }
    if (setupTasks.length > 3) {
      lines.push(`_…and ${setupTasks.length - 3} more._`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /jarvis triage — on-demand triage report, posted to channel
// ---------------------------------------------------------------------------

export interface OnDemandTriageDeps {
  dataDir: string;
  /** Override "now" for deterministic tests. Production uses real wall clock. */
  now?: Date;
  /** Triage signal window. Default 7 days (matches the daemon job). */
  windowDays?: number;
}

export interface OnDemandTriageResult {
  /** Block Kit ready to post. */
  blocks: KnownBlock[];
  /** Fallback text for clients that don't render Block Kit. */
  text: string;
  /** YYYY-MM-DD that the report was generated for. */
  date: string;
}

/**
 * Builds an on-demand triage report. Same `buildTriageReport` the
 * daemon and CLI use; the Block Kit wrapper marks the file path as
 * "(on-demand)" so the user knows the daemon's weekly file write
 * is separate.
 */
export function buildOnDemandTriageBlocks(
  deps: OnDemandTriageDeps,
): OnDemandTriageResult {
  const now = deps.now ?? new Date();
  const windowDays = deps.windowDays ?? 7;
  const report = buildTriageReport({
    dataDir: deps.dataDir,
    now,
    windowDays,
  });

  // Re-render through the existing markdown formatter — same layout
  // the daemon writes to disk, just with the file-path slot tagged
  // (on-demand) so users know this run wasn't archived.
  const markdown = formatMarkdown(report);
  const date = report.generatedAt.slice(0, 10);

  const blocks = buildTriageReportBlocks({
    markdown,
    date,
    filePath: "(on-demand — not written to disk)",
  });
  const text = `Triage — ${date} (on-demand)`;
  return { blocks, text, date };
}

// ---------------------------------------------------------------------------
// /jarvis scout score|draft — Scout slash commands
// ---------------------------------------------------------------------------

/**
 * Reads `--vault <name>` and `--threshold N` flags out of a flat
 * argument list. Unknown / malformed flags are silently dropped to
 * keep the slash UX forgiving — the underlying ops have safe defaults.
 */
export function parseScoutFlags(args: ReadonlyArray<string>): {
  vault: string;
  threshold?: number;
} {
  let vault = "personal";
  let threshold: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--vault" && typeof value === "string" && value.length > 0) {
      vault = value;
      i += 1;
    } else if (
      flag === "--threshold" &&
      typeof value === "string" &&
      value.length > 0
    ) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 100) threshold = n;
      i += 1;
    }
  }
  return threshold !== undefined ? { vault, threshold } : { vault };
}

/**
 * Formats a `ScoreUnscoredIdeasResult` as the ephemeral response body
 * for `/jarvis scout score`. Mirrors the CLI output: one bullet per
 * idea (✓ scored / ✗ error), then a summary footer.
 */
export function formatScoreResults(result: ScoreUnscoredIdeasResult): string {
  if (result.scoredCount === 0 && result.errorCount === 0) {
    return "No unscored ideas. Delete a `Score:` line from `Business_Ideas.md` to re-score.";
  }
  const lines: string[] = [];
  for (const e of result.entries) {
    if (e.error) {
      lines.push(`• ✗ \`${e.ideaId}\` — ${e.error}`);
    } else {
      lines.push(
        `• ✓ \`${e.ideaId}\` — score *${e.score}* (suggested: ${e.suggestedPriority})`,
      );
    }
  }
  lines.push("");
  lines.push(
    `Scored ${result.scoredCount}, ${result.errorCount} error(s).`,
  );
  return lines.join("\n");
}

/**
 * Formats an `AutoDraftFromIdeasResult` as the ephemeral response body
 * for `/jarvis scout draft`. Mirrors the CLI output: one bullet per
 * idea (✓ drafted / – skipped / ✗ error), then a summary footer.
 */
export function formatDraftResults(result: AutoDraftFromIdeasResult): string {
  if (result.entries.length === 0) {
    return "No ideas in `Business_Ideas.md`.";
  }
  const lines: string[] = [];
  for (const e of result.entries) {
    if (e.planId) {
      lines.push(`• ✓ \`${e.ideaId}\` → drafted \`${e.planId}\``);
    } else if (e.error) {
      lines.push(`• ✗ \`${e.ideaId}\` — ${e.error}`);
    } else {
      lines.push(`• – \`${e.ideaId}\` skipped (${e.skippedReason ?? "no reason"})`);
    }
  }
  lines.push("");
  lines.push(
    `Drafted ${result.draftedCount}, ${result.errorCount} error(s).`,
  );
  return lines.join("\n");
}
