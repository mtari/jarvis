import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { listEvents, type EventRow } from "../../orchestrator/event-log.ts";
import type { SignalSeverity } from "../../tools/scanners/types.ts";
import { dbFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis signals [filters]`
 *
 * Lists signal events recorded by the analyst sweep. Most recent first.
 * Filters narrow the set after pulling from the events table — fine for
 * the volumes we expect (a few hundred signals over a couple of weeks).
 *
 * Available filters:
 *   --app <name>          one specific app
 *   --vault <name>        one vault (defaults to all vaults)
 *   --kind <name>         collector kind (e.g. yarn-audit, broken-links)
 *   --severity <level>    low | medium | high | critical
 *   --since <iso>         only signals recorded at or after this datetime
 *   --limit <N>           cap output (default 50)
 *   --format table|json   output format (default table)
 */

const SEVERITY_LEVELS: ReadonlySet<SignalSeverity> = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

const DEFAULT_LIMIT = 50;

interface SignalPayload {
  kind: string;
  severity: SignalSeverity;
  summary: string;
  details?: Record<string, unknown>;
  dedupKey?: string;
}

interface SignalView {
  id: number;
  createdAt: string;
  vault: string;
  app: string;
  kind: string;
  severity: SignalSeverity;
  summary: string;
  dedupKey?: string;
}

/**
 * Test seam: production reads from the live data dir; tests can pass a
 * `dbFilePath` to skip the getDataDir() lookup entirely.
 */
export interface RunSignalsDeps {
  dbFilePath?: string;
}

export async function runSignals(
  rawArgs: string[],
  deps: RunSignalsDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
        kind: { type: "string" },
        severity: { type: "string" },
        since: { type: "string" },
        limit: { type: "string" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`signals: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;

  if (v.severity !== undefined && !SEVERITY_LEVELS.has(v.severity as SignalSeverity)) {
    console.error(
      `signals: invalid --severity "${v.severity}" (expected low|medium|high|critical)`,
    );
    return 1;
  }

  let sinceIso: string | undefined;
  if (v.since !== undefined) {
    const parsedDate = new Date(v.since);
    if (Number.isNaN(parsedDate.getTime())) {
      console.error(
        `signals: invalid --since "${v.since}" (expected ISO datetime, e.g. 2026-04-01T00:00:00Z)`,
      );
      return 1;
    }
    sinceIso = parsedDate.toISOString();
  }

  let limit = DEFAULT_LIMIT;
  if (v.limit !== undefined) {
    const n = Number.parseInt(v.limit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`signals: invalid --limit "${v.limit}" (expected positive integer)`);
      return 1;
    }
    limit = n;
  }

  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(`signals: invalid --format "${format}" (expected table or json)`);
    return 1;
  }

  const dbPath = deps.dbFilePath ?? dbFile(getDataDir());
  const db = new Database(dbPath, { readonly: true });
  let rows: EventRow[];
  try {
    // Pull more than `limit` because we still apply payload-level filters
    // (kind, severity, since) in-memory below — pulling exactly `limit`
    // would short us if half the recent rows fail those filters.
    rows = listEvents(db, {
      kind: "signal",
      ...(v.app !== undefined && { appId: v.app }),
    });
  } finally {
    db.close();
  }

  const views: SignalView[] = [];
  for (const r of rows) {
    if (v.vault !== undefined && r.vault_id !== v.vault) continue;
    if (sinceIso !== undefined && r.created_at < sinceIso) continue;
    let payload: SignalPayload;
    try {
      payload = JSON.parse(r.payload) as SignalPayload;
    } catch {
      continue; // malformed event row — skip
    }
    if (v.kind !== undefined && payload.kind !== v.kind) continue;
    if (v.severity !== undefined && payload.severity !== v.severity) continue;
    views.push({
      id: r.id,
      createdAt: r.created_at,
      vault: r.vault_id,
      app: r.app_id,
      kind: payload.kind,
      severity: payload.severity,
      summary: payload.summary,
      ...(payload.dedupKey !== undefined && { dedupKey: payload.dedupKey }),
    });
    if (views.length >= limit) break;
  }

  if (views.length === 0) {
    console.log("No signals match the filters.");
    return 0;
  }

  if (format === "json") {
    console.log(JSON.stringify(views, null, 2));
  } else {
    console.log(formatTable(views));
  }
  return 0;
}

function formatTable(views: ReadonlyArray<SignalView>): string {
  const rows = views.map((v) => ({
    time: shortTime(v.createdAt),
    app: v.app,
    kind: v.kind,
    severity: v.severity.toUpperCase(),
    summary: truncate(v.summary, 80),
  }));

  const headers = ["time", "app", "kind", "severity", "summary"] as const;
  const labels = {
    time: "TIME",
    app: "APP",
    kind: "KIND",
    severity: "SEVERITY",
    summary: "SUMMARY",
  } as const;

  const widths = headers.map((h) =>
    Math.max(labels[h].length, ...rows.map((r) => r[h].length)),
  );

  const formatRow = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  const lines: string[] = [];
  lines.push(formatRow(headers.map((h) => labels[h])));
  lines.push(formatRow(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    lines.push(formatRow(headers.map((h) => r[h])));
  }
  return lines.join("\n");
}

/** "2026-04-30T15:30:00Z" → "04-30 15:30" — terse for terminal display. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
