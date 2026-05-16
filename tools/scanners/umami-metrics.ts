import type {
  CollectorContext,
  Signal,
  SignalCollector,
  SignalSeverity,
} from "./types.ts";
import {
  createUmamiClient,
  readUmamiConnection,
  UmamiApiError,
  type UmamiClient,
  type UmamiStats,
} from "../umami.ts";

/**
 * Umami metrics collector — Tier 2 (anomaly detection + graded signals).
 *
 * On each tick:
 *   1. Read `brain.connections.umami` from the collector context. If
 *      missing or status !== "connected", emit nothing.
 *   2. Read `UMAMI_API_URL` + `UMAMI_API_TOKEN` from process.env. If
 *      either is missing, emit one low-severity signal.
 *   3. Read `websiteId` from the umami connection. If missing, emit
 *      one low-severity signal.
 *   4. Call the Umami stats endpoint for the last 24h (current window).
 *   5. Call the Umami stats endpoint for the prior 24h window. If this
 *      call fails, fall back to Tier 1 behaviour (single low signal).
 *   6. Compute per-metric % deltas, classify severity against per-app
 *      thresholds from `brain.alertThresholds.umami`.
 *   7. Emit one signal with the computed severity. High/critical signals
 *      carry the severity in their dedupKey so a recurring drop doesn't
 *      collapse with a recovery signal on the same day.
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
      "Pulls last-24h Umami snapshot and compares to prior 24h; emits graded signals (low/medium/high/critical) based on per-app visitor-drop thresholds.",
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
      const client = factory(apiUrl, apiToken);
      try {
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

      // Attempt prior-window fetch. Failure degrades gracefully to Tier 1.
      const priorWindow = { startAt: startAt - DAY_MS, endAt: startAt };
      let priorStats: UmamiStats | null = null;
      let priorFetchError: string | null = null;
      try {
        priorStats = await client.getStats(websiteId, priorWindow);
      } catch (err) {
        priorFetchError =
          err instanceof UmamiApiError
            ? `${err.message} (status=${err.status}, transient=${err.transient})`
            : err instanceof Error
              ? err.message
              : String(err);
      }

      // Tier 1 fallback when prior-window fetch failed.
      if (priorStats === null) {
        const summary =
          `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews, ` +
          `${stats.visitors} visitors, ${stats.visits} visits, ${stats.bounces} bounces` +
          ` (prior-window fetch failed: ${priorFetchError})`;
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
              priorFetchError,
            },
            dedupKey: `umami-metrics:${websiteId}:${dateStamp(now)}`,
          },
        ];
      }

      // Tier 2: compute deltas and classify severity.
      const thresholds = readUmamiThresholds(ctx.alertThresholds);
      const visitorsPct = pctDelta(stats.visitors, priorStats.visitors);
      const pageviewsPct = pctDelta(stats.pageviews, priorStats.pageviews);
      const visitsPct = pctDelta(stats.visits, priorStats.visits);

      const severity = classifySeverity({
        visitors: stats.visitors,
        priorVisitors: priorStats.visitors,
        visitorsPct,
        thresholds,
      });

      const deltaStr = formatDelta(visitorsPct);
      const pvDeltaStr = formatDelta(pageviewsPct);
      const summary =
        `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews (${pvDeltaStr} vs prior 24h), ` +
        `${stats.visitors} visitors (${deltaStr}), ${stats.visits} visits, ${stats.bounces} bounces`;

      // High/critical signals append severity to dedupKey so a sustained drop
      // doesn't collapse with a recovery signal on the same day.
      const dedupKey =
        severity === "low"
          ? `umami-metrics:${websiteId}:${dateStamp(now)}`
          : `umami-metrics:${websiteId}:${dateStamp(now)}:${severity}`;

      return [
        {
          kind: KIND,
          severity,
          summary,
          details: {
            app: ctx.app,
            websiteId,
            window: { startAt, endAt },
            stats,
            priorWindow,
            priorStats,
            deltas: { visitorsPct, pageviewsPct, visitsPct },
            severity,
          },
          dedupKey,
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

interface UmamiThresholds {
  visitorsZeroFloor: number;
  visitorsHighDropPct: number;
  visitorsHighDropFloor: number;
  visitorsMediumDropPct: number;
  visitorsMediumDropFloor: number;
}

const DEFAULT_THRESHOLDS: UmamiThresholds = {
  visitorsZeroFloor: 100,
  visitorsHighDropPct: 50,
  visitorsHighDropFloor: 50,
  visitorsMediumDropPct: 30,
  visitorsMediumDropFloor: 20,
};

function readUmamiThresholds(
  alertThresholds: Record<string, unknown> | undefined,
): UmamiThresholds {
  const raw = alertThresholds?.["umami"];
  if (!raw || typeof raw !== "object") return { ...DEFAULT_THRESHOLDS };
  const obj = raw as Record<string, unknown>;
  const pick = (key: keyof UmamiThresholds): number => {
    const v = obj[key];
    return typeof v === "number" ? v : DEFAULT_THRESHOLDS[key];
  };
  return {
    visitorsZeroFloor: pick("visitorsZeroFloor"),
    visitorsHighDropPct: pick("visitorsHighDropPct"),
    visitorsHighDropFloor: pick("visitorsHighDropFloor"),
    visitorsMediumDropPct: pick("visitorsMediumDropPct"),
    visitorsMediumDropFloor: pick("visitorsMediumDropFloor"),
  };
}

/** Returns null when prior=0 and current≠0 (no comparable baseline). */
function pctDelta(current: number, prior: number): number | null {
  if (prior === 0 && current !== 0) return null;
  if (prior === 0) return 0;
  return ((current - prior) / prior) * 100;
}

function classifySeverity(params: {
  visitors: number;
  priorVisitors: number;
  visitorsPct: number | null;
  thresholds: UmamiThresholds;
}): SignalSeverity {
  const { visitors, priorVisitors, visitorsPct, thresholds } = params;
  if (
    priorVisitors >= thresholds.visitorsZeroFloor &&
    visitors === 0
  ) {
    return "critical";
  }
  if (
    visitorsPct !== null &&
    visitorsPct <= -thresholds.visitorsHighDropPct &&
    priorVisitors >= thresholds.visitorsHighDropFloor
  ) {
    return "high";
  }
  if (
    visitorsPct !== null &&
    visitorsPct <= -thresholds.visitorsMediumDropPct &&
    priorVisitors >= thresholds.visitorsMediumDropFloor
  ) {
    return "medium";
  }
  return "low";
}

function formatDelta(pct: number | null): string {
  if (pct === null) return "Δ N/A (no prior baseline)";
  if (pct === 0) return "Δ 0%";
  const sign = pct > 0 ? "+" : "−";
  return `Δ ${sign}${Math.abs(Math.round(pct))}%`;
}
