import { describe, expect, it, vi } from "vitest";
import type { UmamiClient, UmamiStats } from "../umami.ts";
import { UmamiApiError } from "../umami.ts";
import { createUmamiMetricsCollector } from "./umami-metrics.ts";

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

const SAMPLE_STATS: UmamiStats = {
  pageviews: 1234,
  visitors: 567,
  visits: 800,
  bounces: 234,
  totaltime: 45678,
};

const CONNECTED_UMAMI = {
  status: "connected" as const,
  scriptUrl: "https://umami-self-seven.vercel.app/script.js",
  websiteId: "uuid-erdei",
};

function makeClient(stats: UmamiStats): UmamiClient {
  return {
    async getStats() {
      return stats;
    },
  };
}

function makeFailingClient(err: unknown): UmamiClient {
  return {
    async getStats() {
      throw err;
    },
  };
}

function makeTwoCallClient(
  firstStats: UmamiStats,
  secondStats: UmamiStats,
): UmamiClient {
  let call = 0;
  return {
    async getStats() {
      return ++call === 1 ? firstStats : secondStats;
    },
  };
}

function makePriorFailClient(currentStats: UmamiStats, err: unknown): UmamiClient {
  let call = 0;
  return {
    async getStats() {
      if (++call === 1) return currentStats;
      throw err;
    },
  };
}

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

  it("happy path — emits one low signal with delta annotation", async () => {
    const factory = vi.fn(() => makeTwoCallClient(SAMPLE_STATS, SAMPLE_STATS));
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
    // Same stats for current and prior → 0% delta
    expect(s.summary).toContain("Δ 0%");
    // Low severity keeps Tier 1 dedupKey grain (no severity suffix)
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
    expect(s.details).toMatchObject({
      app: "erdei-fahazak",
      websiteId: "uuid-erdei",
      stats: SAMPLE_STATS,
    });
    const details = s.details as { window: { startAt: number; endAt: number } };
    const dayMs = 24 * 60 * 60 * 1000;
    expect(details.window.endAt).toBe(FIXED_NOW.getTime());
    expect(details.window.startAt).toBe(FIXED_NOW.getTime() - dayMs);
  });

  it("handles zero metrics without leaking NaN or Infinity to summary", async () => {
    const zero: UmamiStats = {
      pageviews: 0,
      visitors: 0,
      visits: 0,
      bounces: 0,
      totaltime: 0,
    };
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
    expect(signals[0]?.dedupKey).toMatch(
      /^umami-metrics:api-error:demo:2026-05-16$/,
    );
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
  // Tier 2 severity classification
  // ---------------------------------------------------------------------------

  it("critical: prior visitors >= floor, current = 0", async () => {
    const prior: UmamiStats = { pageviews: 500, visitors: 200, visits: 300, bounces: 50, totaltime: 1000 };
    const current: UmamiStats = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("critical");
    expect(s.dedupKey).toMatch(/:critical$/);
  });

  it("high: visitorsPct = -60%, prior visitors >= high floor", async () => {
    const prior: UmamiStats = { pageviews: 300, visitors: 100, visits: 150, bounces: 20, totaltime: 500 };
    const current: UmamiStats = { pageviews: 120, visitors: 40, visits: 60, bounces: 10, totaltime: 200 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("high");
    expect(s.dedupKey).toMatch(/:high$/);
  });

  it("medium: visitorsPct = -34%, prior visitors >= medium floor", async () => {
    const prior: UmamiStats = { pageviews: 200, visitors: 50, visits: 80, bounces: 10, totaltime: 400 };
    const current: UmamiStats = { pageviews: 130, visitors: 33, visits: 52, bounces: 7, totaltime: 260 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("medium");
  });

  it("low: visitorsPct = -20%, below medium threshold", async () => {
    const prior: UmamiStats = { pageviews: 200, visitors: 50, visits: 80, bounces: 10, totaltime: 400 };
    const current: UmamiStats = { pageviews: 160, visitors: 40, visits: 64, bounces: 8, totaltime: 320 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("low: large drop but prior visitors below high floor (low-volume noise filter)", async () => {
    // −70% drop but prior = 10 visitors (below both floors)
    const prior: UmamiStats = { pageviews: 30, visitors: 10, visits: 15, bounces: 2, totaltime: 100 };
    const current: UmamiStats = { pageviews: 9, visitors: 3, visits: 4, bounces: 1, totaltime: 30 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("low: positive delta", async () => {
    const prior: UmamiStats = { pageviews: 300, visitors: 100, visits: 150, bounces: 20, totaltime: 500 };
    const current: UmamiStats = { pageviews: 450, visitors: 150, visits: 225, bounces: 30, totaltime: 750 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
  });

  it("per-app threshold override: lower medium pct floor flips severity", async () => {
    // −15% drop: low at defaults (mediumDropPct=30), medium with override (mediumDropPct=10)
    const prior: UmamiStats = { pageviews: 100, visitors: 20, visits: 30, bounces: 5, totaltime: 200 };
    const current: UmamiStats = { pageviews: 85, visitors: 17, visits: 25, bounces: 4, totaltime: 170 };
    const c = createUmamiMetricsCollector({
      clientFactory: () => makeTwoCallClient(current, prior),
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

  it("prior-window fetch fails — fallback to Tier 1 (low, no severity suffix, error in summary)", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () => makePriorFailClient(SAMPLE_STATS, new Error("timeout")),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("prior-window fetch failed");
    expect(s.summary).toContain("timeout");
    expect(s.summary).toContain("1234 pageviews");
    // Tier 1 dedupKey — no severity suffix
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
  });

  it("prior-window fetch fails with UmamiApiError — same fallback", async () => {
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makePriorFailClient(
          SAMPLE_STATS,
          new UmamiApiError("gateway timeout", { status: 504, transient: true }),
        ),
      env: { UMAMI_API_URL: "https://u", UMAMI_API_TOKEN: "t" },
      now: () => FIXED_NOW,
    });
    const signals = await c.collect({
      cwd: "/x",
      app: "erdei-fahazak",
      connections: { umami: CONNECTED_UMAMI },
    });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.severity).toBe("low");
    expect(s.summary).toContain("prior-window fetch failed");
    expect(s.summary).toContain("504");
    expect(s.dedupKey).toBe("umami-metrics:uuid-erdei:2026-05-16");
  });
});
