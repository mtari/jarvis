import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  cacheHitRate,
  costForCall,
  formatUsd,
  hasExplicitPricing,
} from "../../orchestrator/cost.ts";
import { dbFile, getDataDir } from "../paths.ts";

/**
 * Default daily call cap. Per §18, agents run under the user's Claude Code
 * subscription, so the scarce resource is rate-limit headroom shared with
 * the user's interactive Claude Code use — not dollars. The cap is per-UTC
 * day; resets at 00:00 UTC.
 */
const DEFAULT_CAP_CALLS_PER_DAY = 150;
const DEFAULT_WARN_RATIO = 0.8;

interface AgentCallEvent {
  id: number;
  app_id: string;
  vault_id: string;
  created_at: string;
  payload: string;
}

interface AgentCallPayload {
  agent: string;
  planId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  durationMs?: number;
  stopReason?: string | null;
  /**
   * Set to 'subscription' for events emitted post-pivot (Claude Code
   * subscription via the SDK). Older events written before the pivot
   * default to 'api' for back-compat. See §18.
   */
  mode?: "api" | "subscription";
}

interface AgentCallParsed extends AgentCallPayload {
  appId: string;
  createdAt: string;
}

export interface RunCostDeps {
  /** Override the wall clock — used by tests to pin a deterministic month/day window. */
  now?: Date;
}

export async function runCost(
  rawArgs: string[],
  deps: RunCostDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        cap: { type: "string" },
        "warn-at": { type: "string" },
        format: { type: "string" },
        "by-day": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`cost: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  const cap = parsePositiveNumber(v.cap, DEFAULT_CAP_CALLS_PER_DAY);
  if (cap === null) {
    console.error(`cost: invalid --cap "${v.cap}"`);
    return 1;
  }
  const warnRatio = parsePositiveNumber(v["warn-at"], DEFAULT_WARN_RATIO);
  if (warnRatio === null || warnRatio > 1) {
    console.error(
      `cost: invalid --warn-at "${v["warn-at"]}" (expected a fraction 0..1, e.g., 0.8 for 80%)`,
    );
    return 1;
  }
  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(`cost: invalid --format "${format}" (expected table or json)`);
    return 1;
  }
  const byDay = v["by-day"] === true;

  const dataDir = getDataDir();
  const now = deps.now ?? new Date();
  const calls = readMonthCalls(dbFile(dataDir), now);

  if (format === "json") {
    console.log(
      JSON.stringify(buildJsonReport(calls, cap, warnRatio, byDay, now), null, 2),
    );
    return 0;
  }

  console.log(formatTableReport(calls, cap, warnRatio, byDay, now));
  return 0;
}

function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Returns the count of `agent-call` events for the current UTC day from the
 * given DB. Used by the plan-executor to enforce the daily cap and by the
 * cost command's headline. Pre-pivot events are counted equally with
 * post-pivot ones — both consume rate-limit headroom.
 */
export function readTodayCallCount(dbPath: string): number {
  const dayStart = startOfTodayIso();
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent-call' AND created_at >= ?",
      )
      .get(dayStart) as { n: number };
    return row.n ?? 0;
  } finally {
    db.close();
  }
}

function startOfTodayIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  ).toISOString();
}

function readMonthCalls(dbPath: string, now: Date): AgentCallParsed[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const rows = db
      .prepare(
        "SELECT * FROM events WHERE kind = 'agent-call' AND created_at >= ? ORDER BY id",
      )
      .all(monthStart) as AgentCallEvent[];
    const out: AgentCallParsed[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as AgentCallPayload;
        out.push({
          ...payload,
          appId: row.app_id,
          createdAt: row.created_at,
        });
      } catch {
        // skip malformed payload
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function callsTodayFromMonth(
  calls: AgentCallParsed[],
  now: Date,
): AgentCallParsed[] {
  const start = startOfTodayIso(now);
  return calls.filter((c) => c.createdAt >= start);
}

function countLegacyApiCalls(calls: AgentCallParsed[]): number {
  return calls.filter((c) => (c.mode ?? "api") === "api").length;
}

interface AggregateRow {
  key: string;
  calls: number;
  totalUsd: number;
}

function aggregateBy(
  calls: AgentCallParsed[],
  pick: (c: AgentCallParsed) => string,
): AggregateRow[] {
  const map = new Map<string, AggregateRow>();
  for (const c of calls) {
    const key = pick(c);
    const cost = costForCall(c);
    const existing = map.get(key);
    if (existing) {
      existing.calls += 1;
      existing.totalUsd += cost;
    } else {
      map.set(key, { key, calls: 1, totalUsd: cost });
    }
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls);
}

interface DayRow {
  date: string;
  calls: number;
  totalUsd: number;
}

/**
 * Buckets calls by UTC calendar day (YYYY-MM-DD), counts calls per bucket,
 * sums the (informational) USD per bucket, and returns rows sorted ascending
 * by date. Days with no calls are omitted.
 */
function groupByCostDay(calls: AgentCallParsed[]): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const c of calls) {
    const date = c.createdAt.slice(0, 10);
    const cost = costForCall(c);
    const existing = map.get(date);
    if (existing) {
      existing.calls += 1;
      existing.totalUsd += cost;
    } else {
      map.set(date, { date, calls: 1, totalUsd: cost });
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildJsonReport(
  calls: AgentCallParsed[],
  cap: number,
  warnRatio: number,
  byDay: boolean,
  now: Date,
): Record<string, unknown> {
  const today = callsTodayFromMonth(calls, now);
  const totalUsd = calls.reduce((acc, c) => acc + costForCall(c), 0);
  const todayCount = today.length;
  const utilization = cap > 0 ? todayCount / cap : 0;

  const report: Record<string, unknown> = {
    month: now.toISOString().slice(0, 7),
    today: now.toISOString().slice(0, 10),
    callsToday: todayCount,
    callsMonth: calls.length,
    capCallsPerDay: cap,
    capUtilization: round3(utilization),
    warnAtRatio: warnRatio,
    overWarnThreshold: cap > 0 && utilization >= warnRatio,
    cacheHitRate: round3(cacheHitRate(calls)),
    totalUsdInformational: round2(totalUsd),
    legacyApiCalls: countLegacyApiCalls(calls),
    byAgent: aggregateBy(calls, (c) => c.agent).map(toJsonRow),
    byPlan: aggregateBy(calls, (c) => c.planId ?? "<no-plan>").map(toJsonRow),
    byModel: aggregateBy(calls, (c) => c.model).map(toJsonRow),
  };
  if (byDay) {
    report["byDay"] = groupByCostDay(calls).map((r) => ({
      date: r.date,
      calls: r.calls,
      totalUsd: round2(r.totalUsd),
    }));
  }
  return report;
}

function toJsonRow(row: AggregateRow): {
  key: string;
  calls: number;
  totalUsd: number;
} {
  return { key: row.key, calls: row.calls, totalUsd: round2(row.totalUsd) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatTableReport(
  calls: AgentCallParsed[],
  cap: number,
  warnRatio: number,
  byDay: boolean,
  now: Date,
): string {
  if (calls.length === 0) {
    return "No agent calls recorded this month yet.";
  }
  const lines: string[] = [];
  const monthLabel = formatMonth(now);
  const today = callsTodayFromMonth(calls, now);
  const todayCount = today.length;
  const utilization = cap > 0 ? todayCount / cap : 0;
  const overWarn = cap > 0 && utilization >= warnRatio;
  const totalUsd = calls.reduce((acc, c) => acc + costForCall(c), 0);
  const legacyCount = countLegacyApiCalls(calls);

  lines.push(`Jarvis activity — ${monthLabel}`);
  lines.push("");
  const utilPct = (utilization * 100).toFixed(1);
  const flag = overWarn ? "⚠" : "✓";
  lines.push(
    `${flag} Today: ${todayCount} / ${cap} calls (${utilPct}%)`,
  );
  lines.push(`  Month-to-date: ${calls.length} calls`);
  lines.push(
    `  Cache hit rate: ${(cacheHitRate(calls) * 100).toFixed(1)}%`,
  );
  lines.push(
    `  Would-have-been API cost (informational): ${formatUsd(totalUsd)}`,
  );
  if (legacyCount > 0) {
    lines.push(
      `  ${legacyCount} of ${calls.length} events predate the §18 pivot and reflect actual API spend.`,
    );
  }

  lines.push("");
  lines.push("By agent:");
  for (const row of aggregateBy(calls, (c) => c.agent)) {
    lines.push(formatAggRow(row, calls.length));
  }

  const byPlan = aggregateBy(calls, (c) => c.planId ?? "<no-plan>");
  if (byPlan.length > 0) {
    lines.push("");
    lines.push("By plan (top 10):");
    for (const row of byPlan.slice(0, 10)) {
      lines.push(formatAggRow(row, calls.length));
    }
  }

  lines.push("");
  lines.push("By model:");
  const unknownModels: string[] = [];
  for (const row of aggregateBy(calls, (c) => c.model)) {
    lines.push(formatAggRow(row, calls.length));
    if (!hasExplicitPricing(row.key)) unknownModels.push(row.key);
  }
  if (unknownModels.length > 0) {
    lines.push("");
    lines.push(
      `⚠ Pricing fell back to default (Sonnet 4.6) for unknown models: ${unknownModels.join(", ")}`,
    );
  }

  if (byDay) {
    lines.push("");
    lines.push("By day:");
    for (const row of groupByCostDay(calls)) {
      lines.push(formatDayRow(row));
    }
  }

  return lines.join("\n");
}

function formatAggRow(row: AggregateRow, totalCalls: number): string {
  const sharePct =
    totalCalls > 0
      ? ` (${((row.calls / totalCalls) * 100).toFixed(1)}%)`
      : "";
  return `  ${row.key.padEnd(36)}  ${row.calls.toString().padStart(4)} calls  ${formatUsd(row.totalUsd).padStart(8)}${sharePct}`;
}

function formatDayRow(row: DayRow): string {
  return `  ${row.date}  ${row.calls.toString().padStart(4)} calls  ${formatUsd(row.totalUsd).padStart(8)}`;
}

function formatMonth(d: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
