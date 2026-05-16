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

  it("happy path — emits one low signal with the current-window snapshot", async () => {
    const factory = vi.fn(() => makeClient(SAMPLE_STATS));
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
    const c = createUmamiMetricsCollector({
      clientFactory: () =>
        makeClient({
          pageviews: 0,
          visitors: 0,
          visits: 0,
          bounces: 0,
          totaltime: 0,
        }),
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
});
