import fs from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { readAutoDraftedDedupKeys } from "../../agents/analyst.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import { listEvents, type EventRow } from "../../orchestrator/event-log.ts";
import { listPlans, type PlanRecord } from "../../orchestrator/plan-store.ts";
import {
  isSuppressed,
  listSuppressions,
} from "../../orchestrator/suppressions.ts";
import type { SignalSeverity } from "../../tools/scanners/types.ts";
import { dbFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis triage [--format markdown|json] [--window-days N]`
 *
 * Phase 2 exit deliverable: the Monday-morning portfolio summary.
 * Aggregates everything the analyst stack collects and surfaces the
 * pieces that should influence what plan gets drafted next:
 *
 *   1. Critical/high signals from the last N days that aren't already
 *      auto-drafted or suppressed — the immediate "you should fix X" list
 *   2. Plans awaiting review — what's blocking your queue
 *   3. Stuck plans — awaiting-review > 7 days, executing > 1 day
 *   4. Quiet apps — no events in the window (might need attention,
 *      might not — context for the user)
 *   5. Suppressions about to expire — re-decide before they auto-clear
 *   6. Counts by severity / status / suppressions
 *
 * Markdown output is the default — designed to be pasted into Slack or
 * an inbox. `--format json` is for downstream tooling.
 *
 * No LLM scoring yet. Scout (the agent that scores ideas + recommends
 * the next plan) lands separately. Until then, this is pure aggregation
 * — opinionated only in what it surfaces, not in ranking ideas.
 */

const DEFAULT_WINDOW_DAYS = 7;
const STUCK_REVIEW_DAYS = 7;
const STUCK_EXECUTING_DAYS = 1;
const EXPIRY_SOON_DAYS = 7;
const QUIET_APP_DAYS = 14;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

interface SignalInfo {
  id: number;
  createdAt: string;
  vault: string;
  app: string;
  kind: string;
  severity: SignalSeverity;
  summary: string;
  dedupKey?: string;
}

interface PlanInfo {
  id: string;
  vault: string;
  app: string;
  title: string;
  status: string;
  priority: string;
  ageDays: number;
}

interface AppActivity {
  vault: string;
  app: string;
  lastEventAt: string | null;
  daysSinceLastEvent: number | null;
}

interface ExpiringSuppression {
  patternId: string;
  expiresAt: string;
  daysUntilExpiry: number;
}

export interface TriageReport {
  generatedAt: string;
  windowDays: number;
  criticalSignals: SignalInfo[];
  pendingReviews: PlanInfo[];
  stuckPlans: PlanInfo[];
  quietApps: AppActivity[];
  expiringSuppressions: ExpiringSuppression[];
  counts: {
    signalsBySeverity: Record<SignalSeverity, number>;
    plansByStatus: Record<string, number>;
    activeSuppressions: number;
  };
}

export interface RunTriageDeps {
  /** Override the data dir (test seam). */
  dataDir?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export async function runTriage(
  rawArgs: string[],
  deps: RunTriageDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        format: { type: "string" },
        "window-days": { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`triage: ${(err as Error).message}`);
    return 1;
  }

  const format = parsed.values.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    console.error(
      `triage: invalid --format "${format}" (expected markdown or json)`,
    );
    return 1;
  }

  let windowDays = DEFAULT_WINDOW_DAYS;
  if (parsed.values["window-days"] !== undefined) {
    const n = Number.parseInt(parsed.values["window-days"], 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(
        `triage: invalid --window-days "${parsed.values["window-days"]}" (expected positive integer)`,
      );
      return 1;
    }
    windowDays = n;
  }

  const dataDir = deps.dataDir ?? getDataDir();
  const now = deps.now ?? new Date();
  const report = buildTriageReport({ dataDir, now, windowDays });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdown(report));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Aggregation — exported for tests.
// ---------------------------------------------------------------------------

export function buildTriageReport(input: {
  dataDir: string;
  now: Date;
  windowDays: number;
}): TriageReport {
  const { dataDir, now, windowDays } = input;
  const dbPath = dbFile(dataDir);
  const sinceIso = new Date(
    now.getTime() - windowDays * MS_PER_DAY,
  ).toISOString();

  const autoDrafted = readAutoDraftedDedupKeys(dbPath);

  const db = new Database(dbPath, { readonly: true });
  let signalEvents: EventRow[];
  try {
    signalEvents = listEvents(db, { kind: "signal" });
  } finally {
    db.close();
  }

  const counts = {
    signalsBySeverity: { low: 0, medium: 0, high: 0, critical: 0 } as Record<
      SignalSeverity,
      number
    >,
    plansByStatus: {} as Record<string, number>,
    activeSuppressions: 0,
  };

  const criticalSignals: SignalInfo[] = [];
  for (const r of signalEvents) {
    if (r.created_at < sinceIso) continue;
    let payload: {
      kind?: string;
      severity?: SignalSeverity;
      summary?: string;
      dedupKey?: string;
    };
    try {
      payload = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (!payload.severity || !payload.kind || !payload.summary) continue;
    counts.signalsBySeverity[payload.severity] =
      (counts.signalsBySeverity[payload.severity] ?? 0) + 1;
    if (payload.severity !== "high" && payload.severity !== "critical") continue;
    if (payload.dedupKey && autoDrafted.has(payload.dedupKey)) continue;
    if (payload.dedupKey && isSuppressed(dbPath, payload.dedupKey, now)) continue;
    criticalSignals.push({
      id: r.id,
      createdAt: r.created_at,
      vault: r.vault_id,
      app: r.app_id,
      kind: payload.kind,
      severity: payload.severity,
      summary: payload.summary,
      ...(payload.dedupKey !== undefined && { dedupKey: payload.dedupKey }),
    });
  }

  // Plans
  const plans = listPlans(dataDir);
  const pendingReviews: PlanInfo[] = [];
  const stuckPlans: PlanInfo[] = [];
  for (const r of plans) {
    counts.plansByStatus[r.plan.metadata.status] =
      (counts.plansByStatus[r.plan.metadata.status] ?? 0) + 1;
    const ageDays = planAgeDays(r, now);
    const info: PlanInfo = {
      id: r.id,
      vault: r.vault,
      app: r.app,
      title: r.plan.metadata.title,
      status: r.plan.metadata.status,
      priority: r.plan.metadata.priority,
      ageDays,
    };
    if (r.plan.metadata.status === "awaiting-review") {
      pendingReviews.push(info);
      if (ageDays >= STUCK_REVIEW_DAYS) stuckPlans.push(info);
    }
    if (
      r.plan.metadata.status === "executing" &&
      ageDays >= STUCK_EXECUTING_DAYS
    ) {
      stuckPlans.push(info);
    }
  }
  pendingReviews.sort(byPriorityThenAge);
  stuckPlans.sort((a, b) => b.ageDays - a.ageDays);

  // Quiet apps
  const apps = listOnboardedApps(dataDir);
  const lastEventByApp = new Map<string, string>();
  // walk all events (not just signals) so plan-related events count too
  const dbAll = new Database(dbPath, { readonly: true });
  let allEvents: EventRow[];
  try {
    allEvents = dbAll
      .prepare("SELECT app_id, vault_id, created_at FROM events")
      .all() as EventRow[];
  } finally {
    dbAll.close();
  }
  for (const e of allEvents) {
    const key = `${e.vault_id}/${e.app_id}`;
    const prev = lastEventByApp.get(key);
    if (prev === undefined || e.created_at > prev) {
      lastEventByApp.set(key, e.created_at);
    }
  }
  const quietApps: AppActivity[] = [];
  for (const a of apps) {
    const key = `${a.vault}/${a.app}`;
    const last = lastEventByApp.get(key) ?? null;
    const days = last
      ? Math.floor((now.getTime() - new Date(last).getTime()) / MS_PER_DAY)
      : null;
    if (days === null || days >= QUIET_APP_DAYS) {
      quietApps.push({
        vault: a.vault,
        app: a.app,
        lastEventAt: last,
        daysSinceLastEvent: days,
      });
    }
  }

  // Suppressions
  const allSuppressions = listSuppressions(dbPath, { includeCleared: false }, now);
  counts.activeSuppressions = allSuppressions.length;
  const expirySoonCutoff = new Date(
    now.getTime() + EXPIRY_SOON_DAYS * MS_PER_DAY,
  ).toISOString();
  const expiringSuppressions: ExpiringSuppression[] = [];
  for (const s of allSuppressions) {
    if (s.expiresAt === null) continue;
    if (s.expiresAt <= expirySoonCutoff) {
      const days = Math.ceil(
        (new Date(s.expiresAt).getTime() - now.getTime()) / MS_PER_DAY,
      );
      expiringSuppressions.push({
        patternId: s.patternId,
        expiresAt: s.expiresAt,
        daysUntilExpiry: days,
      });
    }
  }
  expiringSuppressions.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return {
    generatedAt: now.toISOString(),
    windowDays,
    criticalSignals,
    pendingReviews,
    stuckPlans,
    quietApps,
    expiringSuppressions,
    counts,
  };
}

function planAgeDays(r: PlanRecord, now: Date): number {
  try {
    const stat = fs.statSync(r.path);
    return Math.floor((now.getTime() - stat.mtimeMs) / MS_PER_DAY);
  } catch {
    return 0;
  }
}

const PRIORITY_RANK: Record<string, number> = {
  blocking: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function byPriorityThenAge(a: PlanInfo, b: PlanInfo): number {
  const pa = PRIORITY_RANK[a.priority] ?? 99;
  const pb = PRIORITY_RANK[b.priority] ?? 99;
  if (pa !== pb) return pa - pb;
  return b.ageDays - a.ageDays;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function formatMarkdown(report: TriageReport): string {
  const lines: string[] = [];
  lines.push(
    `# Triage — ${report.generatedAt.slice(0, 10)} (last ${report.windowDays}d)`,
  );
  lines.push("");

  lines.push("## Summary");
  const sev = report.counts.signalsBySeverity;
  lines.push(
    `- Signals (window): low=${sev.low}, medium=${sev.medium}, high=${sev.high}, critical=${sev.critical}`,
  );
  const planLine = Object.entries(report.counts.plansByStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  lines.push(`- Plans by status: ${planLine || "(none)"}`);
  lines.push(`- Active suppressions: ${report.counts.activeSuppressions}`);
  lines.push("");

  lines.push(
    `## Critical signals not yet drafted (${report.criticalSignals.length})`,
  );
  if (report.criticalSignals.length === 0) {
    lines.push("_None._");
  } else {
    for (const s of report.criticalSignals) {
      lines.push(
        `- **[${s.severity.toUpperCase()}]** ${s.app}/${s.kind} — ${s.summary}`,
      );
    }
  }
  lines.push("");

  lines.push(`## Plans awaiting review (${report.pendingReviews.length})`);
  if (report.pendingReviews.length === 0) {
    lines.push("_Inbox is empty._");
  } else {
    for (const p of report.pendingReviews) {
      lines.push(
        `- \`${p.id}\` ${p.app} [${p.priority}] — ${p.title} (${p.ageDays}d old)`,
      );
    }
  }
  lines.push("");

  lines.push(`## Stuck plans (${report.stuckPlans.length})`);
  if (report.stuckPlans.length === 0) {
    lines.push("_None._");
  } else {
    for (const p of report.stuckPlans) {
      lines.push(
        `- \`${p.id}\` ${p.app} [${p.status}] — ${p.title} (${p.ageDays}d)`,
      );
    }
  }
  lines.push("");

  lines.push(`## Quiet apps (${report.quietApps.length})`);
  if (report.quietApps.length === 0) {
    lines.push("_All apps active._");
  } else {
    for (const a of report.quietApps) {
      const tag = a.daysSinceLastEvent === null
        ? "no events ever"
        : `${a.daysSinceLastEvent}d since last event`;
      lines.push(`- ${a.vault}/${a.app} (${tag})`);
    }
  }
  lines.push("");

  lines.push(
    `## Suppressions expiring in ≤${EXPIRY_SOON_DAYS}d (${report.expiringSuppressions.length})`,
  );
  if (report.expiringSuppressions.length === 0) {
    lines.push("_None._");
  } else {
    for (const e of report.expiringSuppressions) {
      lines.push(
        `- \`${e.patternId}\` — expires in ${e.daysUntilExpiry}d (${e.expiresAt})`,
      );
    }
  }

  return lines.join("\n");
}
