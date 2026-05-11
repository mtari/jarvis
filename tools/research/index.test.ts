import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherProjectResearch } from "./index.ts";
import type { CompetitorSnapshot } from "./competitors.ts";
import type { FacebookInsightsResult } from "./facebook-insights.ts";
import type { TrendPoint } from "./google-trends.ts";
import type { Brain } from "../../orchestrator/brain.ts";

function makeBrain(overrides: Partial<Brain> = {}): Brain {
  return {
    schemaVersion: 1,
    projectName: "test-app",
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    userPreferences: {},
    connections: {},
    priorities: [],
    wip: {},
    ...overrides,
  } as Brain;
}

const COMPETITOR: CompetitorSnapshot = {
  url: "https://competitor.example.com",
  title: "Competitor",
  h1: "Welcome",
  description: "Best product",
  prices: ["$9.99"],
};

const FB_RESULT: FacebookInsightsResult = {
  pageImpressions: 1000,
  pageEngagedUsers: 50,
  pagePostEngagements: 25,
};

const TRENDS_RESULT: TrendPoint[][] = [
  [{ date: "Apr 1, 2026", value: 80 }],
];

describe("gatherProjectResearch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-research-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("all adapters succeed — bundle is fully populated", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://competitor.example.com"], targetKeywords: ["saas"] },
      connections: { facebook: { pageId: "123", tokenEnvVar: "FB_TOKEN" } },
    });
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn().mockResolvedValue(COMPETITOR),
      facebookAdapter: vi.fn().mockResolvedValue(FB_RESULT),
      trendsAdapter: vi.fn().mockResolvedValue(TRENDS_RESULT),
      env: { FB_TOKEN: "tok" },
    });
    expect(bundle.competitors).toHaveLength(1);
    expect(bundle.competitors[0]).toEqual(COMPETITOR);
    expect(bundle.facebookInsights).toEqual(FB_RESULT);
    expect(bundle.trends).toEqual(TRENDS_RESULT);
  });

  it("one adapter rejects — that slot is null/[], others populated", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://c.example.com"], targetKeywords: ["kw"] },
      connections: { facebook: { pageId: "123", tokenEnvVar: "FB_TOKEN" } },
    });
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn().mockResolvedValue(COMPETITOR),
      facebookAdapter: vi.fn().mockRejectedValue(new Error("FB exploded")),
      trendsAdapter: vi.fn().mockResolvedValue(TRENDS_RESULT),
      env: { FB_TOKEN: "tok" },
    });
    expect(bundle.competitors).toHaveLength(1);
    expect(bundle.facebookInsights).toBeNull();
    expect(bundle.trends).toEqual(TRENDS_RESULT);
  });

  it("all adapters reject — bundle has empty/null for all sources", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://c.example.com"], targetKeywords: ["kw"] },
      connections: { facebook: { pageId: "123", tokenEnvVar: "FB_TOKEN" } },
    });
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn().mockRejectedValue(new Error("nope")),
      facebookAdapter: vi.fn().mockRejectedValue(new Error("nope")),
      trendsAdapter: vi.fn().mockRejectedValue(new Error("nope")),
      env: { FB_TOKEN: "tok" },
    });
    expect(bundle.competitors).toEqual([]);
    expect(bundle.facebookInsights).toBeNull();
    expect(bundle.trends).toBeNull();
  });

  it("brain without brand — competitors empty and trends null, no adapter called", async () => {
    const brain = makeBrain({});
    const competitorAdapter = vi.fn();
    const trendsAdapter = vi.fn();
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter,
      facebookAdapter: vi.fn().mockResolvedValue(null),
      trendsAdapter,
    });
    expect(bundle.competitors).toEqual([]);
    expect(bundle.trends).toBeNull();
    expect(competitorAdapter).not.toHaveBeenCalled();
    expect(trendsAdapter).not.toHaveBeenCalled();
  });

  it("brain without FB connection — facebookInsights null, FB adapter not called", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://c.example.com"] },
    });
    const facebookAdapter = vi.fn();
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn().mockResolvedValue(COMPETITOR),
      facebookAdapter,
      trendsAdapter: vi.fn().mockResolvedValue(null),
    });
    expect(bundle.facebookInsights).toBeNull();
    expect(facebookAdapter).not.toHaveBeenCalled();
  });

  it("FB connection present but tokenEnvVar unset — facebookInsights null, FB adapter not called", async () => {
    const brain = makeBrain({
      connections: { facebook: { pageId: "123", tokenEnvVar: "FB_TOKEN_MISSING" } },
    });
    const facebookAdapter = vi.fn();
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn().mockResolvedValue(null),
      facebookAdapter,
      trendsAdapter: vi.fn().mockResolvedValue(null),
      env: {}, // FB_TOKEN_MISSING not set
    });
    expect(bundle.facebookInsights).toBeNull();
    expect(facebookAdapter).not.toHaveBeenCalled();
  });

  it("second call reads from cache — adapter not invoked again", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://c.example.com"], targetKeywords: ["kw"] },
      connections: { facebook: { pageId: "123", tokenEnvVar: "FB_TOKEN" } },
    });
    const nowMs = 1_000_000;
    const competitorAdapter = vi.fn().mockResolvedValue(COMPETITOR);
    const facebookAdapter = vi.fn().mockResolvedValue(FB_RESULT);
    const trendsAdapter = vi.fn().mockResolvedValue(TRENDS_RESULT);

    // First call — populates cache
    await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter,
      facebookAdapter,
      trendsAdapter,
      env: { FB_TOKEN: "tok" },
      nowMs,
    });

    // Second call with same nowMs — should read from cache
    await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter,
      facebookAdapter,
      trendsAdapter,
      env: { FB_TOKEN: "tok" },
      nowMs,
    });

    expect(competitorAdapter).toHaveBeenCalledTimes(1);
    expect(facebookAdapter).toHaveBeenCalledTimes(1);
    expect(trendsAdapter).toHaveBeenCalledTimes(1);
  });

  it("competitor adapter returning null is filtered out", async () => {
    const brain = makeBrain({
      brand: { competitors: ["https://a.example.com", "https://b.example.com"] },
    });
    const bundle = await gatherProjectResearch(brain, tmpDir, {
      competitorAdapter: vi.fn()
        .mockResolvedValueOnce(COMPETITOR)
        .mockResolvedValueOnce(null),
      facebookAdapter: vi.fn().mockResolvedValue(null),
      trendsAdapter: vi.fn().mockResolvedValue(null),
    });
    expect(bundle.competitors).toHaveLength(1);
    expect(bundle.competitors[0]).toEqual(COMPETITOR);
  });
});
