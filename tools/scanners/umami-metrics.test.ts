import { describe, expect, it, vi } from "vitest";
import type { UmamiClient, UmamiEventCount, UmamiStats } from "../umami.ts";
import { UmamiApiError } from "../umami.ts";
import { createUmamiMetricsCollector } from "./umami-metrics.ts";

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const SAMPLE_STATS: UmamiStats = {
  pageviews: 1234,
  visitors: 567,
  visits: 800,
  bounces: 234,
  totaltime: 45678,
};

// WEEK_SAMPLE_STATS: 7× SAMPLE_STATS so 7d avg = SAMPLE_STATS → 0% delta
const WEEK_SAMPLE_STATS: UmamiStats = {
  pageviews: SAMPLE_STATS.pageviews * 7,
  visitors: SAMPLE_STATS.visitors * 7,
  visits: SAMPLE_STATS.visits * 7,
  bounces: SAMPLE_STATS.bounces * 7,
  totaltime: SAMPLE_STATS.totaltime * 7,
};

const CONNECTED_UMAMI = {
  status: "connected" as const,
  scriptUrl: "https://umami-self-seven.vercel.app/script.js",
  websiteId: "uuid-erdei",
};

const CONNECTED_UMAMI_WITH_EVENTS = {
  ...CONNECTED_UMAMI,
  trackedEvents: ["newsletter_signup"],
};

// ---------------------------------------------------------------------------
// Mock client factories
// ---------------------------------------------------------------------------

function makeClient(stats: UmamiStats): UmamiClient {
  return {
    async getStats() { return stats; },
    async getEvents() { return []; },
  };
}

function makeFailingClient(err: unknown): UmamiClient {
  return {
    async getStats() { throw err; },
    async getEvents() { return []; },
  };
}

/** Call 1 = getStats(current), call 2 = getStats(week), events always → []. */
function makeTwoCallClient(
  firstStats: UmamiStats,
  secondStats: UmamiStats,
): UmamiClient {
  let call = 0;
  return {
    async getStats() {
      return ++call === 1 ? firstStats : secondStats;
    },
    async getEvents() { return []; },
  };
}

/** Call 1 = getStats(current) → ok, call 2 = getStats(week) → err, call 3 = getStats(prior) → thirdResult. */
function makeThreeCallGetStatsClient(
  first: UmamiStats,
  secondOrErr: UmamiStats | Error,
  thirdOrErr: UmamiStats | Error,
): UmamiClient {
  let call = 0;
  return {
    async getStats() {
      ++call;
      if (call === 1) return first;
      const result = call === 2 ? secondOrErr : thirdOrErr;
      if (result instanceof Error) throw result;
      return result;
    },
    async getEvents() { return []; },
  };
}

/** Stub client with configurable getStats and getEvents sequences. */
function makeFullClient(opts: {
  statsSequence: Array<UmamiStats | Error>;
  eventsSequence: Array<UmamiEventCount[] | Error>;
}): UmamiClient {
  let statsCall = 0;
  let eventsCall = 0;
  return {
    async getStats() {
      const result = opts.statsSequence[statsCall++];
      if (!result) throw new Error("unexpected getStats call");
      if (result instanceof Error) throw result;
      return result;
    },
    async getEvents() {
      const result = opts.eventsSequence[eventsCall++];
      if (!result) return [];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Basic connectivity / env tests
// ---------------------------------------------------------------------------

describe("umami-metrics collector", () => {
  it("returns no signals when ctx.connections is undefined", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeClient(SAMPLE_STATS),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({ cwd: "/x", app: "demo" });
    expect(signals).toEqual([]);
  });

  it("returns no signals when umami connection is absent", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeClient(SAMPLE_STATS),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: { facebook: { status: "connected" } },
    });
    expect(signals).toEqual([]);
  });

  it("returns no signals when umami status is not 'connected'", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeClient(SAMPLE_STATS),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: {
        umami: { status: "missing", scriptUrl: "https://x/script.js" },
      },
    });
    expect(signals).toEqual([]);
  });

  it("emits one low signal when env vars are missing", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeClient(SAMPLE_STATS),
      env: { UMAMI_API_URL: "" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("UMAMI_API_URL");
    expect(s.summary).toContain("UMAMI_API_TOKEN");
    expect(s.dedupKey).toBe("umami-metrics:env-missing:demo");
  });

  it("emits one low signal when websiteId is missing", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeClient(SAMPLE_STATS),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: {
        umami: {
          status: "connected",
          scriptUrl: "https://x/script.js",
          // websiteId omitted
        },
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.summary).toContain("websiteId missing");
    expect(signals[0]?.dedupKey).toBe("umami-metrics:websiteId-missing:demo");
  });

  // ---------------------------------------------------------------------------
  // Happy path — 7-day baseline
  // ---------------------------------------------------------------------------

  it("happy path — emits one low signal with 7d avg annotation", async () => {
    const factory = vi.fn(() => makeTwoCallClient(SAMPLE_STATS, WEEK_SAMPLE_STATS));
    const c = createUmamiMetricsCollector({
      clientFactory: factory,
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });

    expect(factory).toHaveBeenCalledWith("https://u", "t");
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.kind).toBe("umami-metrics");
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("1234 pageviews");
    expect(s.summary).toContain("567 visitors");
    expect(s.summary).toContain("800 visits");
    expect(s.summary).toContain("234 bounces");
    expect(s.summary).toContain("Δ 0%");
    expect(s.summary).toContain("vs 7d avg");
    // Low severity — no severity suffix in dedupKey
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
    expect(s.details).toMatchObject({
      app: "erdei-fahazak",
      websiteId: "uuid-erdei",
      stats: SAMPLE_STATS,
    });
    const details = s.details as { window: { startAt: number; endAt: number } };
    expect(details.window.endAt).toBe(FIXED_NOW.getTime());
    expect(details.window.startAt).toBe(FIXED_NOW.getTime() - DAY_MS);
  });

  it("7d baseline math: current=600 visitors, weekStats=7000 → baseline=1000, -40% → medium", async () => {
    const current: UmamiStats = { pageviews: 600, visitors: 600, visits: 600, bounces: 60, totaltime: 1000 };
    const week: UmamiStats = { pageviews: 7000, visitors: 7000, visits: 7000, bounces: 700, totaltime: 10000 };
    // baseline = 1000/day, current 600 visitors → -40% drop, floor=50 met → medium
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("medium");
    expect(signals[0]?.summary).toContain("vs 7d avg");
  });

  it("7d baseline math: 0% delta when current matches 7d average", async () => {
    const current: UmamiStats = { pageviews: 1234, visitors: 1000, visits: 1000, bounces: 100, totaltime: 1000 };
    const week: UmamiStats = { pageviews: 8638, visitors: 7000, visits: 7000, bounces: 700, totaltime: 7000 };
    // baseline.visitors = 1000/day, current = 1000 → 0% → low
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
    expect(signals[0]?.summary).toContain("Δ 0%");
  });

  it("handles zero metrics without leaking NaN or Infinity to summary", async () => {
    const zero: UmamiStats = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(zero, zero),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals[0]?.summary).toContain("0 pageviews");
    expect(signals[0]?.summary).not.toContain("NaN");
    expect(signals[0]?.summary).not.toContain("Infinity");
  });

  it("API error path — emits one low signal with error message, no throw", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFailingClient(
          new UmamiApiError("Umami 503 Service Unavailable", {
            status: 503,
            transient: true,
          }),
        ),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
    expect(signals[0]?.summary).toContain("API call failed");
    expect(signals[0]?.summary).toContain("503");
    expect(signals[0]?.summary).toContain("transient=true");
    expect(signals[0]?.dedupKey).toMatch(/^umami-metrics:api-error:demo:2026-05-16$/);
  });

  it("non-UmamiApiError throwables also yield a single low signal", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeFailingClient(new Error("boom")),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "demo",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.summary).toContain("boom");
  });

  // ---------------------------------------------------------------------------
  // Tier 2 severity classification (updated for 7-day baseline)
  // In Tier 3, call 2 is the 7-day window. weekStats.visitors must be
  // 7× the intended daily baseline to satisfy classification floors.
  // ---------------------------------------------------------------------------

  it("critical: week-baseline visitors >= zeroFloor, current = 0", async () => {
    // baseline = 200/day (floor=100), current = 0 → critical
    const week: UmamiStats = { pageviews: 3500, visitors: 1400, visits: 2100, bounces: 350, totaltime: 7000 };
    const current: UmamiStats = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("critical");
    expect(s.dedupKey).toMatch(/:critical$/);
  });

  it("high: visitorsPct = -60%, baseline >= high floor", async () => {
    // baseline = 100/day (floor=50 met), current = 40 → -60% → high
    const week: UmamiStats = { pageviews: 2100, visitors: 700, visits: 1050, bounces: 140, totaltime: 3500 };
    const current: UmamiStats = { pageviews: 120, visitors: 40, visits: 60, bounces: 10, totaltime: 200 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("high");
    expect(s.dedupKey).toMatch(/:high$/);
  });

  it("medium: visitorsPct = -34%, baseline >= medium floor", async () => {
    // baseline = 50/day (floor=20 met), current = 33 → -34% → medium
    const week: UmamiStats = { pageviews: 1400, visitors: 350, visits: 560, bounces: 70, totaltime: 2800 };
    const current: UmamiStats = { pageviews: 130, visitors: 33, visits: 52, bounces: 7, totaltime: 260 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("medium");
  });

  it("low: visitorsPct = -20%, below medium threshold", async () => {
    // baseline = 50/day (floor=20 met), current = 40 → -20%, mediumDropPct=30 not met → low
    const week: UmamiStats = { pageviews: 1400, visitors: 350, visits: 560, bounces: 70, totaltime: 2800 };
    const current: UmamiStats = { pageviews: 160, visitors: 40, visits: 64, bounces: 8, totaltime: 320 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("low: large drop but baseline below high floor (low-volume noise filter)", async () => {
    // baseline = 10/day (below both floors), current = 3 → -70% but low
    const week: UmamiStats = { pageviews: 210, visitors: 70, visits: 105, bounces: 14, totaltime: 700 };
    const current: UmamiStats = { pageviews: 9, visitors: 3, visits: 4, bounces: 1, totaltime: 30 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("low: positive delta", async () => {
    // baseline = 100/day, current = 150 → +50% → low
    const week: UmamiStats = { pageviews: 2100, visitors: 700, visits: 1050, bounces: 140, totaltime: 3500 };
    const current: UmamiStats = { pageviews: 450, visitors: 150, visits: 225, bounces: 30, totaltime: 750 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("per-app threshold override: lower medium pct floor flips severity", async () => {
    // baseline = 20/day (>= override floor=5), current = 17 → -15% → medium with override
    const week: UmamiStats = { pageviews: 700, visitors: 140, visits: 210, bounces: 35, totaltime: 1400 };
    const current: UmamiStats = { pageviews: 85, visitors: 17, visits: 25, bounces: 4, totaltime: 170 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, week),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
      alertThresholds: { umami: { visitorsMediumDropPct: 10, visitorsMediumDropFloor: 5 } },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("medium");
  });

  // ---------------------------------------------------------------------------
  // Fallback paths
  // ---------------------------------------------------------------------------

  it("week-window fetch fails — falls back to Tier 2 prior-24h comparison", async () => {
    const priorStats: UmamiStats = { pageviews: 1000, visitors: 400, visits: 500, bounces: 80, totaltime: 4000 };
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeThreeCallGetStatsClient(
          SAMPLE_STATS,
          new Error("week timeout"),
          priorStats,
        ),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("vs prior 24h (7d fetch failed)");
    expect(s.summary).toContain("1234 pageviews");
    expect(s.summary).not.toContain("vs 7d avg");
    // Tier 2 dedup key — no severity suffix since low
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
  });

  it("week-window and prior-window both fail — falls back to Tier 1 snapshot", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeThreeCallGetStatsClient(
          SAMPLE_STATS,
          new Error("week timeout"),
          new Error("prior timeout"),
        ),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("prior-window fetch failed");
    expect(s.summary).toContain("1234 pageviews");
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
  });

  it("prior-window fetch fails with UmamiApiError — Tier 1 snapshot contains status", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeThreeCallGetStatsClient(
          SAMPLE_STATS,
          new UmamiApiError("gateway timeout", { status: 504, transient: true }),
          new UmamiApiError("prior gateway timeout", { status: 504, transient: true }),
        ),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("prior-window fetch failed");
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
  });

  // ---------------------------------------------------------------------------
  // Per-event signals
  // ---------------------------------------------------------------------------

  it("trackedEvents missing — no getEvents calls, only umami-metrics signal", async () => {
    const getEventsSpy = vi.fn(async () => []);
    const c = createUmamiMetricsCollector({
      clientFactory: () => ({
        async getStats() { return SAMPLE_STATS; },
        getEvents: getEventsSpy,
      }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI }, // no trackedEvents
    });
    expect(getEventsSpy).not.toHaveBeenCalled();
    expect(signals.every((s) => s.kind === "umami-metrics")).toBe(true);
  });

  it("per-event happy path: 8 signups today, 49 over 7 days → +14% → low", async () => {
    const currentEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 8 }];
    const weekEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 49 }];
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFullClient({
          statsSequence: [SAMPLE_STATS, WEEK_SAMPLE_STATS],
          eventsSequence: [currentEvents, weekEvents],
        }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const evtSignal = signals.find((s) => s.kind === "umami-events")!;
    expect(evtSignal).toBeDefined();
    expect(evtSignal.severity).toBe("low");
    expect(evtSignal.summary).toContain("newsletter_signup");
    expect(evtSignal.summary).toContain("8 events");
    expect(evtSignal.summary).toContain("vs 7d avg");
    // dailyBaseline = 49/7 = 7, current = 8 → +14% → low
    expect(evtSignal.dedupKey).toBe("umami-events:uuid-erdei:newsletter_signup:2026-05-16");
  });

  it("per-event critical: baseline >= floor, current = 0", async () => {
    // baseline = 35/7 = 5/day (criticalBaselineFloor=5), current = 0 → critical
    const weekEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 35 }];
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFullClient({
          statsSequence: [SAMPLE_STATS, WEEK_SAMPLE_STATS],
          eventsSequence: [[], weekEvents],
        }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const evtSignal = signals.find((s) => s.kind === "umami-events")!;
    expect(evtSignal.severity).toBe("critical");
    expect(evtSignal.dedupKey).toMatch(/:critical$/);
  });

  it("per-event high: baseline=10/day, current=4 (-60%) → high", async () => {
    // baseline = 70/7 = 10/day (highBaselineFloor=5 met), current = 4 → -60% → high
    const weekEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 70 }];
    const currentEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 4 }];
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFullClient({
          statsSequence: [SAMPLE_STATS, WEEK_SAMPLE_STATS],
          eventsSequence: [currentEvents, weekEvents],
        }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const evtSignal = signals.find((s) => s.kind === "umami-events")!;
    expect(evtSignal.severity).toBe("high");
    expect(evtSignal.dedupKey).toMatch(/:high$/);
  });

  it("per-event low-volume guard: baseline=0.3/day, current=0 → low (floor not met)", async () => {
    // baseline = 2/7 ≈ 0.3/day (criticalBaselineFloor=5 not met) → low
    const weekEvents: UmamiEventCount[] = [{ eventName: "newsletter_signup", total: 2 }];
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFullClient({
          statsSequence: [SAMPLE_STATS, WEEK_SAMPLE_STATS],
          eventsSequence: [[], weekEvents],
        }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const evtSignal = signals.find((s) => s.kind === "umami-events")!;
    expect(evtSignal.severity).toBe("low");
  });

  it("trackedEvents has event not in API response: current=0, baseline=0 → low", async () => {
    // Event "newsletter_signup" absent from both responses → current=0, weekTotal=0 → low
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeFullClient({
          statsSequence: [SAMPLE_STATS, WEEK_SAMPLE_STATS],
          eventsSequence: [[], []],
        }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const evtSignal = signals.find((s) => s.kind === "umami-events")!;
    expect(evtSignal).toBeDefined();
    expect(evtSignal.severity).toBe("low");
  });

  it("events API failure: stats signal still emitted + one low events-unavailable signal", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => ({
        async getStats() { return SAMPLE_STATS; },
        async getEvents() { throw new UmamiApiError("events 500", { status: 500, transient: true }); },
      }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    const metricsSignal = signals.find((s) => s.kind === "umami-metrics");
    const eventsSignal = signals.find((s) => s.kind === "umami-events");
    expect(metricsSignal).toBeDefined();
    expect(eventsSignal).toBeDefined();
    expect(eventsSignal!.severity).toBe("low");
    expect(eventsSignal!.summary).toContain("events API call failed");
    expect(eventsSignal!.dedupKey).toMatch(/^umami-events:api-error:huntech-dev:/);
  });

  it("getEvents called with both current and week windows in parallel", async () => {
    const getEventsSpy = vi.fn(async (): Promise<UmamiEventCount[]> => []);
    const c = createUmamiMetricsCollector({
      clientFactory: () => ({
        async getStats() { return SAMPLE_STATS; },
        getEvents: getEventsSpy,
      }),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    await c.collect({
      cwd: "/x", app: "huntech-dev",
      connections: { umami: CONNECTED_UMAMI_WITH_EVENTS },
    });
    expect(getEventsSpy).toHaveBeenCalledTimes(2);
    const endAt = FIXED_NOW.getTime();
    const startAt = endAt - DAY_MS;
    const weekStartAt = endAt - 7 * DAY_MS;
    // Current window call
    expect(getEventsSpy).toHaveBeenCalledWith("uuid-erdei", { startAt, endAt });
    // Week window call
    expect(getEventsSpy).toHaveBeenCalledWith("uuid-erdei", { startAt: weekStartAt, endAt });
  });
});
