import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  costForCall,
  formatUsd,
  hasExplicitPricing,
  pricingFor,
} from "./cost.ts";

describe("pricingFor", () => {
  it("returns Sonnet pricing for known Sonnet model", () => {
    expect(pricingFor("claude-sonnet-4-6").inputPerMTok).toBe(3.0);
    expect(pricingFor("claude-sonnet-4-6").outputPerMTok).toBe(15.0);
  });

  it("falls back to Sonnet pricing for unknown models", () => {
    const fallback = pricingFor("future-model-2030");
    expect(fallback).toEqual(pricingFor("claude-sonnet-4-6"));
  });

  it("hasExplicitPricing flags fallback usage", () => {
    expect(hasExplicitPricing("claude-sonnet-4-6")).toBe(true);
    expect(hasExplicitPricing("future-model-2030")).toBe(false);
  });
});

describe("costForCall", () => {
  it("computes Sonnet cost from token counts", () => {
    // 1M input + 500K output @ Sonnet 4.6 → $3 + $7.50 = $10.50
    const c = costForCall({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(c).toBeCloseTo(10.5, 5);
  });

  it("applies cache pricing separately", () => {
    // 1M cached read @ $0.30 = $0.30
    const c = costForCall({
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
      cacheCreationTokens: 0,
    });
    expect(c).toBeCloseTo(0.3, 5);
  });

  it("applies cache-creation pricing separately", () => {
    // 1M cache creation @ $3.75 = $3.75
    const c = costForCall({
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(c).toBeCloseTo(3.75, 5);
  });

  it("uses Haiku pricing for the haiku model id", () => {
    const c = costForCall({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(c).toBeCloseTo(1.0, 5);
  });
});

describe("cacheHitRate", () => {
  it("returns 0 when there are no calls", () => {
    expect(cacheHitRate([])).toBe(0);
  });

  it("returns the share of cached input over total input", () => {
    const rate = cacheHitRate([
      { inputTokens: 100, cachedInputTokens: 0 },
      { inputTokens: 100, cachedInputTokens: 300 }, // 100 fresh + 300 cached
    ]);
    // total input 200 + 300 cached = 500 billable
    // cached = 300; rate = 300/500 = 0.6
    expect(rate).toBeCloseTo(0.6, 5);
  });
});

describe("formatUsd", () => {
  it("rounds tiny amounts to $0.00", () => {
    expect(formatUsd(0.0004)).toBe("$0.00");
  });
  it("formats with 2 decimal places", () => {
    expect(formatUsd(4.237)).toBe("$4.24");
  });
});
