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
  type UmamiEventCount,
  type UmamiStats,
} from "../umami.ts";

/**
 * Umami metrics collector — Tier 3 (7-day baseline + per-event tracking).
 *
 * On each tick:
 *   1. Read `brain.connections.umami` from the collector context. If
 *      missing or status !== "connected", emit nothing.
 *   2. Read `UMAMI_API_URL` + `UMAMI_API_TOKEN` from process.env. If
 *      either is missing, emit one low-severity signal.
 *   3. Read `websiteId` from the umami connection. If missing, emit
 *      one low-severity signal.
 *   4. Call the Umami stats endpoint for the last 24h (current window).
 *   5. Call the Umami stats endpoint for the last 7 days (week window).
 *      If this call fails, fall back to Tier 2 prior-24h comparison.
 *      If both fail, fall back to Tier 1 snapshot.
 *   6. Compute per-metric % deltas vs 7-day daily average; classify
 *      severity against per-app thresholds.
 *   7. Emit `umami-metrics` signal.
 *   8. If `connections.umami.trackedEvents` is non-empty and week stats
 *      succeeded, call the events endpoint for current + week windows,
 *      emit one `umami-events` signal per tracked event.
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
const EVENTS_KIND = "umami-events";

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
      "Pulls last-24h Umami snapshot and compares to 7-day rolling average; emits graded signals (low/medium/high/critical) based on per-app visitor-drop thresholds. Also emits per-event signals when trackedEvents is configured.",
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

      // Attempt 7-day window fetch. Failure degrades gracefully.
      const weekWindow = { startAt: endAt - 7 * DAY_MS, endAt };
      let weekStats: UmamiStats | null = null;
      let weekFetchError: string | null = null;
      try {
        weekStats = await client.getStats(websiteId, weekWindow);
      } catch (err) {
        weekFetchError =
          err instanceof UmamiApiError
            ? `${err.message} (status=${err.status}, transient=${err.transient})`
            : err instanceof Error
              ? err.message
              : String(err);
      }

      // If week-window failed, fall back to Tier 2 prior-24h comparison.
      let priorStats: UmamiStats | null = null;
      let priorFetchError: string | null = null;
      if (weekStats === null) {
        const priorWindow = { startAt: startAt - DAY_MS, endAt: startAt };
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
      }

      const signals: Signal[] = [];

      if (weekStats !== null) {
        // Tier 3: 7-day rolling baseline.
        const baseline = {
          visitors: weekStats.visitors / 7,
          pageviews: weekStats.pageviews / 7,
          visits: weekStats.visits / 7,
        };
        const thresholds = readUmamiThresholds(ctx.alertThresholds);
        const visitorsPct = pctDelta(stats.visitors, baseline.visitors);
        const pageviewsPct = pctDelta(stats.pageviews, baseline.pageviews);
        const visitsPct = pctDelta(stats.visits, baseline.visits);

        const severity = classifySeverity({
          visitors: stats.visitors,
          priorVisitors: baseline.visitors,
          visitorsPct,
          thresholds,
        });

        const deltaStr = formatDelta(visitorsPct);
        const pvDeltaStr = formatDelta(pageviewsPct);
        const summary =
          `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews (${pvDeltaStr} vs 7d avg), ` +
          `${stats.visitors} visitors (${deltaStr} vs 7d avg ${baseline.visitors.toFixed(1)}/day), ` +
          `${stats.visits} visits, ${stats.bounces} bounces`;

        const dedupKey =
          severity === "low"
            ? `umami-metrics:${websiteId}:${dateStamp(now)}`
            : `umami-metrics:${websiteId}:${dateStamp(now)}:${severity}`;

        signals.push({
          kind: KIND,
          severity,
          summary,
          details: {
            app: ctx.app,
            websiteId,
            window: { startAt, endAt },
            stats,
            weekWindow,
            weekStats,
            baseline,
            deltas: { visitorsPct, pageviewsPct, visitsPct },
            severity,
          },
          dedupKey,
        });

        // Per-event block — only when trackedEvents is configured.
        if (conn.trackedEvents && conn.trackedEvents.length > 0) {
          let currentEvents: UmamiEventCount[] = [];
          let weekEvents: UmamiEventCount[] = [];
          let eventsError: string | null = null;
          try {
            [currentEvents, weekEvents] = await Promise.all([
              client.getEvents(websiteId, { startAt, endAt }),
              client.getEvents(websiteId, weekWindow),
            ]);
          } catch (err) {
            eventsError =
              err instanceof UmamiApiError
                ? `${err.message} (status=${err.status}, transient=${err.transient})`
                : err instanceof Error
                  ? err.message
                  : String(err);
          }

          if (eventsError !== null) {
            signals.push({
              kind: EVENTS_KIND,
              severity: "low",
              summary: `umami-events: events API call failed for ${ctx.app} — ${eventsError}`,
              details: { app: ctx.app, websiteId, eventsError },
              dedupKey: `umami-events:api-error:${ctx.app}:${dateStamp(now)}`,
            });
          } else {
            for (const eventName of conn.trackedEvents) {
              const current =
                currentEvents.find((e) => e.eventName === eventName)?.total ?? 0;
              const weekTotal =
                weekEvents.find((e) => e.eventName === eventName)?.total ?? 0;
              const dailyBaseline = weekTotal / 7;
              const pct = pctDelta(current, dailyBaseline);
              const eventThresholds = readUmamiEventThresholds(
                ctx.alertThresholds,
                eventName,
              );
              const evtSeverity = classifyEventSeverity({
                current,
                dailyBaseline,
                pct,
                thresholds: eventThresholds,
              });
              signals.push({
                kind: EVENTS_KIND,
                severity: evtSeverity,
                summary: `${eventName} on ${ctx.app}: ${current} events (${formatDelta(pct)} vs 7d avg ${dailyBaseline.toFixed(1)}/day)`,
                details: {
                  app: ctx.app,
                  websiteId,
                  eventName,
                  current,
                  dailyBaseline,
                  window: { startAt, endAt },
                  weekWindow,
                },
                dedupKey:
                  evtSeverity === "low"
                    ? `umami-events:${websiteId}:${eventName}:${dateStamp(now)}`
                    : `umami-events:${websiteId}:${eventName}:${dateStamp(now)}:${evtSeverity}`,
              });
            }
          }
        }
      } else if (priorStats !== null) {
        // Tier 2 fallback: week-window failed, compare to prior 24h.
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
          `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews (${pvDeltaStr} vs prior 24h (7d fetch failed)), ` +
          `${stats.visitors} visitors (${deltaStr}), ${stats.visits} visits, ${stats.bounces} bounces`;

        const priorWindow = { startAt: startAt - DAY_MS, endAt: startAt };
        const dedupKey =
          severity === "low"
            ? `umami-metrics:${websiteId}:${dateStamp(now)}`
            : `umami-metrics:${websiteId}:${dateStamp(now)}:${severity}`;

        signals.push({
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
            weekFetchError,
            deltas: { visitorsPct, pageviewsPct, visitsPct },
            severity,
          },
          dedupKey,
        });
      } else {
        // Tier 1 fallback: both week and prior failed.
        const summary =
          `Last 24h on ${ctx.app}: ${stats.pageviews} pageviews, ` +
          `${stats.visitors} visitors, ${stats.visits} visits, ${stats.bounces} bounces` +
          ` (prior-window fetch failed: ${priorFetchError ?? weekFetchError})`;
        signals.push({
          kind: KIND,
          severity: "low",
          summary,
          details: {
            app: ctx.app,
            websiteId,
            window: { startAt, endAt },
            stats,
            weekFetchError,
            priorFetchError,
          },
          dedupKey: `umami-metrics:${websiteId}:${dateStamp(now)}`,
        });
      }

      return signals;
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

interface UmamiEventThresholds {
  criticalBaselineFloor: number;
  highDropPct: number;
  highBaselineFloor: number;
  mediumDropPct: number;
  mediumBaselineFloor: number;
}

const DEFAULT_EVENT_THRESHOLDS: UmamiEventThresholds = {
  criticalBaselineFloor: 5,
  highDropPct: 50,
  highBaselineFloor: 5,
  mediumDropPct: 30,
  mediumBaselineFloor: 2,
};

function readUmamiEventThresholds(
  alertThresholds: Record<string, unknown> | undefined,
  eventName: string,
): UmamiEventThresholds {
  const umamiRaw = alertThresholds?.["umami"];
  if (!umamiRaw || typeof umamiRaw !== "object") return { ...DEFAULT_EVENT_THRESHOLDS };
  const umamiObj = umamiRaw as Record<string, unknown>;
  const eventsRaw = umamiObj["events"];
  if (!eventsRaw || typeof eventsRaw !== "object") return { ...DEFAULT_EVENT_THRESHOLDS };
  const eventsObj = eventsRaw as Record<string, unknown>;

  // Per-event overrides take precedence over .default
  const perEventRaw = eventsObj[eventName];
  const defaultRaw = eventsObj["default"];

  const merged: Record<string, unknown> = {};
  if (defaultRaw && typeof defaultRaw === "object") {
    Object.assign(merged, defaultRaw as Record<string, unknown>);
  }
  if (perEventRaw && typeof perEventRaw === "object") {
    Object.assign(merged, perEventRaw as Record<string, unknown>);
  }

  const pick = (key: keyof UmamiEventThresholds): number => {
    const v = merged[key];
    return typeof v === "number" ? v : DEFAULT_EVENT_THRESHOLDS[key];
  };
  return {
    criticalBaselineFloor: pick("criticalBaselineFloor"),
    highDropPct: pick("highDropPct"),
    highBaselineFloor: pick("highBaselineFloor"),
    mediumDropPct: pick("mediumDropPct"),
    mediumBaselineFloor: pick("mediumBaselineFloor"),
  };
}

function classifyEventSeverity(params: {
  current: number;
  dailyBaseline: number;
  pct: number | null;
  thresholds: UmamiEventThresholds;
}): SignalSeverity {
  const { current, dailyBaseline, pct, thresholds } = params;
  if (dailyBaseline >= thresholds.criticalBaselineFloor && current === 0) {
    return "critical";
  }
  if (
    pct !== null &&
    pct <= -thresholds.highDropPct &&
    dailyBaseline >= thresholds.highBaselineFloor
  ) {
    return "high";
  }
  if (
    pct !== null &&
    pct <= -thresholds.mediumDropPct &&
    dailyBaseline >= thresholds.mediumBaselineFloor
  ) {
    return "medium";
  }
  return "low";
}
