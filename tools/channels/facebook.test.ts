import { describe, expect, it, vi } from "vitest";
import {
  createFacebookAdapter,
  DEFAULT_GRAPH_API_VERSION,
  FacebookAdapterError,
  readFacebookEnv,
} from "./facebook.ts";
import type { PublishInput } from "./types.ts";

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    postId: "post-1",
    planId: "plan-1",
    appId: "demo",
    content: "Hello world",
    assets: [],
    channel: "facebook",
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  responses: Array<{
    ok?: boolean;
    status?: number;
    statusText?: string;
    body?: unknown;
    text?: string;
    throws?: Error;
  }>,
): { fetcher: typeof fetch; calls: FetchCall[] } {
  let i = 0;
  const calls: FetchCall[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[i++];
    if (!r) throw new Error("fakeFetch: out of responses");
    if (r.throws) throw r.throws;
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), {
      status: r.status ?? (r.ok === false ? 500 : 200),
      statusText: r.statusText ?? "OK",
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

// ---------------------------------------------------------------------------
// readFacebookEnv
// ---------------------------------------------------------------------------

describe("readFacebookEnv", () => {
  it("returns config when both vars are present", () => {
    expect(
      readFacebookEnv({
        FB_PAGE_ID: "123",
        FB_PAGE_ACCESS_TOKEN: "tok",
      }),
    ).toEqual({ pageId: "123", accessToken: "tok" });
  });

  it("trims whitespace", () => {
    expect(
      readFacebookEnv({
        FB_PAGE_ID: "  123  ",
        FB_PAGE_ACCESS_TOKEN: "  tok  ",
      }),
    ).toEqual({ pageId: "123", accessToken: "tok" });
  });

  it("returns null when either var is missing", () => {
    expect(readFacebookEnv({ FB_PAGE_ID: "123" })).toBeNull();
    expect(readFacebookEnv({ FB_PAGE_ACCESS_TOKEN: "tok" })).toBeNull();
    expect(readFacebookEnv({})).toBeNull();
  });

  it("returns null when either var is whitespace-only", () => {
    expect(
      readFacebookEnv({
        FB_PAGE_ID: "   ",
        FB_PAGE_ACCESS_TOKEN: "tok",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createFacebookAdapter
// ---------------------------------------------------------------------------

describe("createFacebookAdapter", () => {
  it("registers for the facebook channel", () => {
    const a = createFacebookAdapter({ pageId: "p", accessToken: "t" });
    expect(a.channels).toEqual(["facebook"]);
  });

  it("rejects empty pageId / accessToken", () => {
    expect(() =>
      createFacebookAdapter({ pageId: "", accessToken: "t" }),
    ).toThrow(FacebookAdapterError);
    expect(() =>
      createFacebookAdapter({ pageId: "p", accessToken: "" }),
    ).toThrow(FacebookAdapterError);
  });

  it("POSTs to the right Graph API URL with message + access_token", async () => {
    const { fetcher, calls } = fakeFetch([
      { ok: true, body: { id: "fbpost_123" } },
    ]);
    const a = createFacebookAdapter({
      pageId: "12345",
      accessToken: "secret",
      fetcher,
    });
    const result = await a.publish(input({ content: "hi" }));
    expect(result).toEqual({ ok: true, publishedId: "fbpost_123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/12345/feed`,
    );
    expect(calls[0]?.init?.method).toBe("POST");
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get("message")).toBe("hi");
    expect(params.get("access_token")).toBe("secret");
  });

  it("URL-encodes the pageId", async () => {
    const { fetcher, calls } = fakeFetch([
      { ok: true, body: { id: "x" } },
    ]);
    const a = createFacebookAdapter({
      pageId: "page name with spaces",
      accessToken: "t",
      fetcher,
    });
    await a.publish(input());
    expect(calls[0]?.url).toContain("page%20name%20with%20spaces");
  });

  it("uses a custom Graph API version", async () => {
    const { fetcher, calls } = fakeFetch([
      { ok: true, body: { id: "x" } },
    ]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      graphApiVersion: "v21.0",
      fetcher,
    });
    await a.publish(input());
    expect(calls[0]?.url).toContain("/v21.0/");
  });

  it("returns ok:false transient on 5xx", async () => {
    const { fetcher } = fakeFetch([
      { status: 500, statusText: "Server Error", text: "graph down" },
    ]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transient).toBe(true);
      expect(result.reason).toContain("500");
    }
  });

  it("returns ok:false transient on 429", async () => {
    const { fetcher } = fakeFetch([
      { status: 429, statusText: "Too Many Requests" },
    ]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transient).toBe(true);
    }
  });

  it("returns ok:false NON-transient on 4xx (token expired etc.)", async () => {
    const { fetcher } = fakeFetch([
      { status: 401, statusText: "Unauthorized", text: "bad token" },
    ]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transient).toBe(false);
    }
  });

  it("returns ok:false transient on network error (fetch throws)", async () => {
    const { fetcher } = fakeFetch([{ throws: new Error("DNS fail") }]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transient).toBe(true);
      expect(result.reason).toContain("DNS fail");
    }
  });

  it("returns ok:false when 2xx body has no id", async () => {
    const { fetcher } = fakeFetch([{ ok: true, body: { foo: "bar" } }]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
  });

  it("rejects posts with assets in v1 (text-only)", async () => {
    const { fetcher, calls } = fakeFetch([
      { ok: true, body: { id: "x" } },
    ]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
    });
    const result = await a.publish(input({ assets: ["hero.jpg"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("text-only");
    }
    // Ensure we did NOT make a Graph API call when assets present.
    expect(calls).toHaveLength(0);
  });

  it("dryRun returns synthetic id without calling fetch", async () => {
    const { fetcher, calls } = fakeFetch([]);
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
      dryRun: true,
    });
    const result = await a.publish(input({ postId: "post-9" }));
    expect(result).toEqual({
      ok: true,
      publishedId: "fb-dryrun-post-9",
    });
    expect(calls).toHaveLength(0);
  });

  it("aborts on timeout (controller.abort)", async () => {
    // Hand the adapter a fetch that respects AbortSignal.
    const fetcher = ((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    const a = createFacebookAdapter({
      pageId: "p",
      accessToken: "t",
      fetcher,
      timeoutMs: 5,
    });
    const result = await a.publish(input());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("network error");
      expect(result.transient).toBe(true);
    }
  });
});
