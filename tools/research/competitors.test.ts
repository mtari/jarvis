import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCompetitorSnapshot } from "./competitors.ts";

describe("fetchCompetitorSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFetch(html: string, status = 200): typeof globalThis.fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => html,
    } as Response);
  }

  it("extracts title, h1, description, and prices", async () => {
    const html = `
      <html>
        <head>
          <title>Acme Store</title>
          <meta name="description" content="Best prices in town">
        </head>
        <body>
          <h1>Welcome to Acme</h1>
          <span>$19.99 and €25.00</span>
        </body>
      </html>
    `;
    const result = await fetchCompetitorSnapshot("https://acme.example.com", {
      fetchFn: makeFetch(html),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Acme Store");
    expect(result!.h1).toBe("Welcome to Acme");
    expect(result!.description).toBe("Best prices in town");
    expect(result!.prices).toContain("$19.99");
    expect(result!.prices).toContain("€25.00");
    expect(result!.url).toBe("https://acme.example.com");
  });

  it("returns empty strings and empty array when fields are missing", async () => {
    const result = await fetchCompetitorSnapshot("https://empty.example.com", {
      fetchFn: makeFetch("<html><body>No metadata</body></html>"),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("");
    expect(result!.h1).toBe("");
    expect(result!.description).toBe("");
    expect(result!.prices).toEqual([]);
  });

  it("strips HTML tags from title and h1", async () => {
    const html = `
      <title><b>Bold Title</b></title>
      <h1><span>Styled H1</span></h1>
    `;
    const result = await fetchCompetitorSnapshot("https://styled.example.com", {
      fetchFn: makeFetch(html),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Bold Title");
    expect(result!.h1).toBe("Styled H1");
  });

  it("returns null on non-2xx status", async () => {
    const result = await fetchCompetitorSnapshot("https://fail.example.com", {
      fetchFn: makeFetch("Not found", 404),
    });
    expect(result).toBeNull();
  });

  it("returns null on network throw", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await fetchCompetitorSnapshot("https://broken.example.com", {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    expect(result).toBeNull();
  });

  it("calls logger on non-2xx", async () => {
    const logger = vi.fn();
    await fetchCompetitorSnapshot("https://fail.example.com", {
      fetchFn: makeFetch("", 503),
      logger,
    });
    expect(logger).toHaveBeenCalled();
  });

  it("calls logger on network error", async () => {
    const logger = vi.fn();
    const fetchFn = vi.fn().mockRejectedValue(new Error("timeout"));
    await fetchCompetitorSnapshot("https://broken.example.com", {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      logger,
    });
    expect(logger).toHaveBeenCalled();
  });

  it("returns null on AbortError (timeout) using fake timers", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const resultPromise = fetchCompetitorSnapshot("https://slow.example.com", {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("extracts HUF price candidates", async () => {
    const html = `<html><body><p>12 500 HUF</p><p>3000HUF</p></body></html>`;
    const result = await fetchCompetitorSnapshot("https://hu.example.com", {
      fetchFn: makeFetch(html),
    });
    expect(result).not.toBeNull();
    expect(result!.prices.length).toBeGreaterThan(0);
  });
});
