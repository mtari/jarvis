import { describe, expect, it } from "vitest";
import {
  createUmamiClient,
  readUmamiConnection,
  UmamiApiError,
} from "./umami.ts";

const SAMPLE_STATS = {
  pageviews: 1234,
  visitors: 567,
  visits: 800,
  bounces: 234,
  totaltime: 45678,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createUmamiClient.getStats", () => {
  it("builds the correct URL + Authorization header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(SAMPLE_STATS);
    }) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://umami-self-seven.vercel.app",
      apiToken: "tok_abc",
      fetch: fetcher,
    });

    await client.getStats("site-uuid", { startAt: 100, endAt: 200 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://umami-self-seven.vercel.app/api/websites/site-uuid/stats?startAt=100&endAt=200",
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok_abc");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("strips trailing slashes from apiUrl and URL-encodes websiteId", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = (async (url: string) => {
      calls.push(url);
      return jsonResponse(SAMPLE_STATS);
    }) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://umami-self-seven.vercel.app///",
      apiToken: "tok_abc",
      fetch: fetcher,
    });

    await client.getStats("site uuid/with weird chars", { startAt: 1, endAt: 2 });

    const calledUrl = calls[0]!;
    expect(calledUrl.startsWith("https://umami-self-seven.vercel.app/api/")).toBe(true);
    expect(calledUrl).toContain("site%20uuid%2Fwith%20weird%20chars");
  });

  it("parses a valid stats response into the typed shape", async () => {
    const fetcher: typeof fetch = (async () =>
      jsonResponse(SAMPLE_STATS)) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://u",
      apiToken: "t",
      fetch: fetcher,
    });

    const stats = await client.getStats("site", { startAt: 0, endAt: 1 });

    expect(stats.pageviews).toBe(1234);
    expect(stats.visitors).toBe(567);
    expect(stats.bounces).toBe(234);
  });

  it("401 throws UmamiApiError flagged not-transient with auth hint", async () => {
    const fetcher: typeof fetch = (async () =>
      new Response("Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      })) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://u",
      apiToken: "bad",
      fetch: fetcher,
    });

    await expect(
      client.getStats("site", { startAt: 0, endAt: 1 }),
    ).rejects.toMatchObject({
      name: "UmamiApiError",
      status: 401,
      transient: false,
    });
    await expect(
      client.getStats("site", { startAt: 0, endAt: 1 }),
    ).rejects.toThrow(/unauthenticated/);
  });

  it("5xx throws UmamiApiError flagged transient", async () => {
    const fetcher: typeof fetch = (async () =>
      new Response("oops", {
        status: 503,
        statusText: "Service Unavailable",
      })) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://u",
      apiToken: "t",
      fetch: fetcher,
    });

    const err = await client
      .getStats("site", { startAt: 0, endAt: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiApiError);
    expect((err as UmamiApiError).status).toBe(503);
    expect((err as UmamiApiError).transient).toBe(true);
  });

  it("network failure throws UmamiApiError flagged transient with status 0", async () => {
    const fetcher: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://u",
      apiToken: "t",
      fetch: fetcher,
    });

    const err = await client
      .getStats("site", { startAt: 0, endAt: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiApiError);
    expect((err as UmamiApiError).status).toBe(0);
    expect((err as UmamiApiError).transient).toBe(true);
    expect((err as UmamiApiError).message).toMatch(/ECONNREFUSED/);
  });

  it("schema mismatch on 2xx throws non-transient UmamiApiError", async () => {
    const fetcher: typeof fetch = (async () =>
      jsonResponse({ pageviews: "wrong-shape" })) as typeof fetch;
    const client = createUmamiClient({
      apiUrl: "https://u",
      apiToken: "t",
      fetch: fetcher,
    });

    const err = await client
      .getStats("site", { startAt: 0, endAt: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiApiError);
    expect((err as UmamiApiError).transient).toBe(false);
    expect((err as UmamiApiError).message).toMatch(/schema/i);
  });

  it("rejects empty apiUrl / apiToken / websiteId", () => {
    expect(() => createUmamiClient({ apiUrl: "", apiToken: "t" })).toThrow(
      UmamiApiError,
    );
    expect(() =>
      createUmamiClient({ apiUrl: "https://u", apiToken: "" }),
    ).toThrow(UmamiApiError);
  });
});

describe("readUmamiConnection", () => {
  it("returns null when umami key is absent", () => {
    expect(readUmamiConnection({})).toBeNull();
    expect(readUmamiConnection({ facebook: { status: "connected" } })).toBeNull();
  });

  it("parses a valid umami connection", () => {
    const conn = readUmamiConnection({
      umami: {
        status: "connected",
        scriptUrl: "https://umami-self-seven.vercel.app/script.js",
        websiteId: "uuid-123",
        appEnvVars: ["NEXT_PUBLIC_UMAMI_WEBSITE_ID"],
      },
    });
    expect(conn?.status).toBe("connected");
    expect(conn?.websiteId).toBe("uuid-123");
  });

  it("returns null on shape mismatch (e.g. wrong status value)", () => {
    expect(
      readUmamiConnection({
        umami: { status: "totally-bogus", scriptUrl: "https://x" },
      }),
    ).toBeNull();
  });

  it("websiteId is optional — connection is valid without it", () => {
    const conn = readUmamiConnection({
      umami: {
        status: "connected",
        scriptUrl: "https://x/script.js",
      },
    });
    expect(conn).not.toBeNull();
    expect(conn?.websiteId).toBeUndefined();
  });

  it("accepts domainsAttribute as null (huntech-dev shape)", () => {
    const conn = readUmamiConnection({
      umami: {
        status: "connected",
        scriptUrl: "https://x/script.js",
        domainsAttribute: "huntech.dev,huntech-dev.vercel.app",
      },
    });
    expect(conn?.domainsAttribute).toBe("huntech.dev,huntech-dev.vercel.app");
    const connNull = readUmamiConnection({
      umami: {
        status: "connected",
        scriptUrl: "https://x/script.js",
        domainsAttribute: null,
      },
    });
    expect(connNull?.domainsAttribute).toBeNull();
  });
});
