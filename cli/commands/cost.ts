import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  cacheHitRate,
  costForCall,
  formatUsd,
  hasExplicitPricing,
} from "../../orchestrator/cost.ts";
import { dbFile, getDataDir } from "../paths.ts";

const DEFAULT_CAP_USD = 50;
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
}

interface AgentCallParsed extends AgentCallPayload {
  appId: string;
  createdAt: string;
}

export async function runCost(rawArgs: string[]): Promise<number> {
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
  const cap = parsePositiveNumber(v.cap, DEFAULT_CAP_USD);
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
  const calls = readMonthCalls(dbFile(dataDir));

  if (format === "json") {
    console.log(JSON.stringify(buildJsonReport(calls, cap, warnRatio, byDay), null, 2));
    return 0;
  }

  console.log(formatTableReport(calls, cap, warnRatio, byDay));
  return 0;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function readMonthCalls(dbPath: string): AgentCallParsed[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const now = new Date();
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
  return [...map.values()].sort((a, b) => b.totalUsd - a.totalUsd);
}

interface DayRow {
  date: string;
  calls: number;
  totalUsd: number;
}

/**
 * Buckets calls by UTC calendar day (YYYY-MM-DD) derived from the ISO
 * `createdAt` field, sums cost per bucket, and returns rows sorted ascending
 * by date. Days with no spend are omitted.
 */
function groupByCostDay(calls: AgentCallParsed[]): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const c of calls) {
    const date = c.createdAt.slice(0, 10); // "YYYY-MM-DD" from ISO string
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
): Record<string, unknown> {
  const total = calls.reduce((acc, c) => acc + costForCall(c), 0);
  const report: Record<string, unknown> = {
    month: new Date().toISOString().slice(0, 7),
    totalCalls: calls.length,
    totalUsd: round2(total),
    capUsd: cap,
    capUtilization: cap > 0 ? round3(total / cap) : 0,
    warnAtRatio: warnRatio,
    overWarnThreshold: cap > 0 && total / cap >= warnRatio,
    cacheHitRate: round3(cacheHitRate(calls)),
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
): string {
  if (calls.length === 0) {
    return "No agent calls recorded this month yet.";
  }
  const lines: string[] = [];
  const monthLabel = formatMonth(new Date());
  const total = calls.reduce((acc, c) => acc + costForCall(c), 0);
  const cacheRate = cacheHitRate(calls);
  const utilization = cap > 0 ? total / cap : 0;
  const overWarn = cap > 0 && utilization >= warnRatio;

  lines.push(`Jarvis cost — ${monthLabel}`);
  lines.push("");
  const utilPct = (utilization * 100).toFixed(1);
  const flag = overWarn ? "⚠" : "✓";
  lines.push(
    `${flag} Total: ${formatUsd(total)} / ${formatUsd(cap)} cap (${utilPct}%)`,
  );
  lines.push(`  Cache hit rate: ${(cacheRate * 100).toFixed(1)}%`);
  lines.push(`  Calls: ${calls.length}`);

  lines.push("");
  lines.push("By agent:");
  for (const row of aggregateBy(calls, (c) => c.agent)) {
    lines.push(formatAggRow(row, total));
  }

  const byPlan = aggregateBy(calls, (c) => c.planId ?? "<no-plan>");
  if (byPlan.length > 0) {
    lines.push("");
    lines.push("By plan (top 10):");
    for (const row of byPlan.slice(0, 10)) {
      lines.push(formatAggRow(row, total));
    }
  }

  lines.push("");
  lines.push("By model:");
  const unknownModels: string[] = [];
  for (const row of aggregateBy(calls, (c) => c.model)) {
    lines.push(formatAggRow(row, total));
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

function formatAggRow(row: AggregateRow, total: number): string {
  const sharePct =
    total > 0 ? ` (${((row.totalUsd / total) * 100).toFixed(1)}%)` : "";
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
