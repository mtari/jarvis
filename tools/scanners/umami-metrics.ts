import type {
  CollectorContext,
  Signal,
  SignalCollector,
} from "./types.ts";
import {
  createUmamiClient,
  readUmamiConnection,
  UmamiApiError,
  type UmamiClient,
  type UmamiStats,
} from "../umami.ts";

/**
 * Umami metrics collector — Tier 1 (raw daily snapshot, no alerting).
 *
 * On each tick:
 *   1. Read `brain.connections.umami` from the collector context. If
 *      missing or status !== "connected", emit nothing — this app
 *      doesn't have Umami wired.
 *   2. Read `UMAMI_API_URL` + `UMAMI_API_TOKEN` from process.env. If
 *      either is missing, emit one low-severity signal naming the
 *      missing var so the operator sees the config gap.
 *   3. Read `websiteId` from the umami connection. If missing, emit
 *      one low-severity signal naming the affected app.
 *   4. Call the Umami stats endpoint for the last 24h.
 *   5. Emit one low-severity signal summarising pageviews / visitors
 *      with day-over-day deltas. `dedupKey` collapses multiple ticks
 *      per day to one logical observation.
 *
 * Tier 2 adds severity escalation on anomalies (week-over-week dips,
 * compound thresholds) and ties into Analyst's auto-draft path. Tier 1
 * keeps everything at `low` so signals are recorded but don't trigger
 * Strategist drafting. See plan 2026-05-16-umami-metrics-collector-tier-1.
 */

export interface UmamiMetricsCollectorOptions {
  /** Override the client factory (test seam). Default: createUmamiClient reading env. */
  clientFactory?: (apiUrl: string, apiToken: string) => UmamiClient;
  /** Override the env reader (test seam). Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Override "now" for deterministic windows in tests. Default: new Date(). */
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KIND = "umami-metrics";

export function createUmamiMetricsCollector(
  opts: UmamiMetricsCollectorOptions = {},
): SignalCollector {
  const env = opts.env ?? process.env;
  const factory =
    opts.clientFactory ??
    ((apiUrl, apiToken) => createUmamiClient({ apiUrl, apiToken }));
  const nowFn = opts.now ?? (() => new Date());

  return {
    kind: KIND,
    description:
      "Pulls last-24h Umami snapshot (pageviews, visitors, visits, bounces) per app and records a low-severity observation.",
    async collect(ctx: CollectorContext): Promise<Signal[]> {
      const connections = ctx.connections;
      if (!connections) return [];
      const conn = readUmamiConnection(connections);
      if (!conn || conn.status !== "connected") return [];

      const apiUrl = env["UMAMI_API_URL"];
      const apiToken = env["UMAMI_API_TOKEN"];
      if (!apiUrl || !apiToken) {
        const missing = [
          !apiUrl ? "UMAMI_API_URL" : null,
          !apiToken ? "UMAMI_API_TOKEN" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return [
          {
            kind: KIND,
            severity: "low",
            summary: `umami-metrics: env vars unset (${missing}) — collector skipped for ${ctx.app}`,
            details: { app: ctx.app, missing },
            dedupKey: `umami-metrics:env-missing:${ctx.app}`,
          },
        ];
      }

      const websiteId = conn.websiteId;
      if (!websiteId || websiteId.trim().length === 0) {
        return [
          {
            kind: KIND,
            severity: "low",
            summary: `umami-metrics: websiteId missing in brain.connections.umami for ${ctx.app}`,
            details: { app: ctx.app, scriptUrl: conn.scriptUrl },
            dedupKey: `umami-metrics:websiteId-missing:${ctx.app}`,
          },
        ];
      }

      const now = nowFn();
      const endAt = now.getTime();
      const startAt = endAt - DAY_MS;

      let stats: UmamiStats;
      try {
        const client = factory(apiUrl, apiToken);
        stats = await client.getStats(websiteId, { startAt, endAt });
      } catch (err) {
        const msg =
          err instanceof UmamiApiError
            ? `${err.message} (status=${err.status}, transient=${err.transient})`
            : err instanceof Error
              ? err.message
              : String(err);
        return [
          {
            kind: KIND,
            severity: "low",
            summary: `umami-metrics: API call failed for ${ctx.app} — ${msg}`,
            details: { app: ctx.app, websiteId, error: msg },
            dedupKey: `umami-metrics:api-error:${ctx.app}:${dateStamp(now)}`,
          },
        ];
      }

      const summary =
        `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews, ` +
        `${stats.visitors} visitors, ${stats.visits} visits, ${stats.bounces} bounces`;

      return [
        {
          kind: KIND,
          severity: "low",
          summary,
          details: {
            app: ctx.app,
            websiteId,
            window: { startAt, endAt },
            stats,
          },
          dedupKey: `umami-metrics:${websiteId}:${dateStamp(now)}`,
        },
      ];
    },
  };
}

/** Default instance — daemon + scan CLI consume this directly. */
const umamiMetricsCollector = createUmamiMetricsCollector();
export default umamiMetricsCollector;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateStamp(d: Date): string {
  // YYYY-MM-DD in UTC. Matches the dedup grain (one signal per day per site).
  return d.toISOString().slice(0, 10);
}
