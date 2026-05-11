import { describe, expect, it, vi } from "vitest";
import { fetchTrendSignals } from "./google-trends.ts";
import type { TrendTransport } from "./google-trends.ts";

function makeTrendsJson(entries: { date: string; value: number }[]): string {
  return JSON.stringify({
    default: {
      timelineData: entries.map((e) => ({
        formattedAxisTime: e.date,
        value: [e.value],
      })),
    },
  });
}

describe("fetchTrendSignals", () => {
  it("returns null for empty keywords array", async () => {
    const transport: TrendTransport = { interestOverTime: vi.fn() };
    const result = await fetchTrendSignals([], { transport });
    expect(result).toBeNull();
  });

  it("single keyword happy path", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn().mockResolvedValue(
        makeTrendsJson([
          { date: "Apr 1, 2026", value: 50 },
          { date: "Apr 8, 2026", value: 75 },
        ]),
      ),
    };
    const result = await fetchTrendSignals(["typescript"], { transport });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual([
      { date: "Apr 1, 2026", value: 50 },
      { date: "Apr 8, 2026", value: 75 },
    ]);
  });

  it("multi-keyword returns results in keyword order", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn()
        .mockResolvedValueOnce(makeTrendsJson([{ date: "Apr 1, 2026", value: 10 }]))
        .mockResolvedValueOnce(makeTrendsJson([{ date: "Apr 1, 2026", value: 20 }]))
        .mockResolvedValueOnce(makeTrendsJson([{ date: "Apr 1, 2026", value: 30 }])),
    };
    const result = await fetchTrendSignals(["a", "b", "c"], { transport });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]![0]!.value).toBe(10);
    expect(result![1]![0]!.value).toBe(20);
    expect(result![2]![0]!.value).toBe(30);
  });

  it("executes keywords sequentially", async () => {
    const callOrder: string[] = [];
    const transport: TrendTransport = {
      interestOverTime: vi.fn().mockImplementation(async (opts) => {
        callOrder.push(opts.keyword as string);
        return makeTrendsJson([]);
      }),
    };
    await fetchTrendSignals(["first", "second", "third"], { transport });
    expect(callOrder).toEqual(["first", "second", "third"]);
  });

  it("failed keyword slot becomes empty array, others still returned", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn()
        .mockResolvedValueOnce(makeTrendsJson([{ date: "Apr 1, 2026", value: 5 }]))
        .mockRejectedValueOnce(new Error("rate limit"))
        .mockResolvedValueOnce(makeTrendsJson([{ date: "Apr 1, 2026", value: 15 }])),
    };
    const result = await fetchTrendSignals(["ok", "fail", "ok2"], { transport });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toHaveLength(1);
    expect(result![1]).toEqual([]);
    expect(result![2]).toHaveLength(1);
  });

  it("returns null when all keywords throw", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const result = await fetchTrendSignals(["a", "b"], { transport });
    expect(result).toBeNull();
  });

  it("returns null when JSON parse fails for all keywords", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn().mockResolvedValue("not valid json{"),
    };
    const result = await fetchTrendSignals(["keyword"], { transport });
    expect(result).toBeNull();
  });

  it("passes geo option to transport", async () => {
    const transport: TrendTransport = {
      interestOverTime: vi.fn().mockResolvedValue(makeTrendsJson([])),
    };
    await fetchTrendSignals(["keyword"], { transport, geo: "HU" });
    expect(transport.interestOverTime).toHaveBeenCalledWith(
      expect.objectContaining({ geo: "HU" }),
    );
  });
});
