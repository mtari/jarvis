import { describe, expect, it, vi } from "vitest";
import { fetchFacebookInsights } from "./facebook-insights.ts";

describe("fetchFacebookInsights", () => {
  function makeResponse(data: unknown, status = 200): typeof globalThis.fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    } as Response);
  }

  const happyPayload = {
    data: [
      {
        name: "page_impressions",
        values: [
          { value: 100, end_time: "2026-05-05T07:00:00+0000" },
          { value: 200, end_time: "2026-05-06T07:00:00+0000" },
          { value: 300, end_time: "2026-05-07T07:00:00+0000" },
        ],
      },
      {
        name: "page_engaged_users",
        values: [
          { value: 10, end_time: "2026-05-05T07:00:00+0000" },
          { value: 20, end_time: "2026-05-06T07:00:00+0000" },
        ],
      },
      {
        name: "page_post_engagements",
        values: [
          { value: 5, end_time: "2026-05-05T07:00:00+0000" },
        ],
      },
    ],
  };

  it("sums each metric across all values", async () => {
    const result = await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: makeResponse(happyPayload),
    });
    expect(result).not.toBeNull();
    expect(result!.pageImpressions).toBe(600);
    expect(result!.pageEngagedUsers).toBe(30);
    expect(result!.pagePostEngagements).toBe(5);
  });

  it("returns zeros for missing metrics", async () => {
    const payload = { data: [{ name: "page_impressions", values: [{ value: 50 }] }] };
    const result = await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: makeResponse(payload),
    });
    expect(result).not.toBeNull();
    expect(result!.pageImpressions).toBe(50);
    expect(result!.pageEngagedUsers).toBe(0);
    expect(result!.pagePostEngagements).toBe(0);
  });

  it("returns all zeros when data array is empty", async () => {
    const result = await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: makeResponse({ data: [] }),
    });
    expect(result).not.toBeNull();
    expect(result!.pageImpressions).toBe(0);
    expect(result!.pageEngagedUsers).toBe(0);
    expect(result!.pagePostEngagements).toBe(0);
  });

  it("returns null on non-2xx status", async () => {
    const result = await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: makeResponse({}, 401),
    });
    expect(result).toBeNull();
  });

  it("returns null on network throw", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    expect(result).toBeNull();
  });

  it("URL includes correct metric names and since param", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);
    await fetchFacebookInsights({
      pageId: "mypageid",
      accessToken: "mytoken",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("mypageid");
    expect(calledUrl).toContain("page_impressions");
    expect(calledUrl).toContain("page_engaged_users");
    expect(calledUrl).toContain("page_post_engagements");
    expect(calledUrl).toContain("since=");
  });

  it("uses v19.0 as default graph API version", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);
    await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/v19.0/");
  });

  it("accepts custom graph API version", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);
    await fetchFacebookInsights({
      pageId: "123",
      accessToken: "tok",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      graphApiVersion: "v20.0",
    });
    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/v20.0/");
  });
});
