import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrokenLinksCollector,
  extractUrls,
  walkMarkdownFiles,
} from "./broken-links.ts";
import type { CollectorContext } from "./types.ts";

// ---------------------------------------------------------------------------
// extractUrls — Markdown URL extractor
// ---------------------------------------------------------------------------

describe("extractUrls", () => {
  it("returns empty for plain prose", () => {
    expect(extractUrls("Just a sentence with no URLs.")).toEqual([]);
  });

  it("picks up Markdown link URLs", () => {
    const md = "See [Wikipedia](https://en.wikipedia.org/wiki/Foo) for more.";
    expect(extractUrls(md)).toEqual(["https://en.wikipedia.org/wiki/Foo"]);
  });

  it("picks up bare angle-bracketed URLs", () => {
    expect(extractUrls("<https://example.com/path>")).toEqual([
      "https://example.com/path",
    ]);
  });

  it("picks up plain inline URLs", () => {
    expect(
      extractUrls("Source: https://example.com/article and others."),
    ).toEqual(["https://example.com/article"]);
  });

  it("strips trailing prose punctuation", () => {
    expect(extractUrls("done at https://example.com/done.")).toEqual([
      "https://example.com/done",
    ]);
    expect(extractUrls("see https://example.com,")).toEqual([
      "https://example.com",
    ]);
    expect(
      extractUrls("(linked from https://example.com)"),
    ).toEqual(["https://example.com"]);
  });

  it("dedupes the same URL appearing multiple times", () => {
    const md = "[a](https://example.com) and [b](https://example.com) again.";
    expect(extractUrls(md)).toEqual(["https://example.com"]);
  });

  it("skips loopback and private hosts", () => {
    expect(
      extractUrls(
        "skip http://localhost:3000 http://127.0.0.1/x http://0.0.0.0/y",
      ),
    ).toEqual([]);
  });

  it("skips relative paths, anchors, mailto and ftp", () => {
    expect(
      extractUrls(
        "no [self](#anchor) [rel](./README.md) [mail](mailto:x@y.z) ftp://files.example",
      ),
    ).toEqual([]);
  });

  it("handles both http and https", () => {
    const out = extractUrls("a http://a.example b https://b.example");
    expect(out.sort()).toEqual(["http://a.example", "https://b.example"]);
  });
});

// ---------------------------------------------------------------------------
// walkMarkdownFiles — file walker
// ---------------------------------------------------------------------------

describe("walkMarkdownFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bl-walk-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(rel: string, contents = ""): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  it("yields .md and .mdx files only", () => {
    writeFile("README.md", "");
    writeFile("docs/intro.mdx", "");
    writeFile("CHANGELOG.txt", "");
    writeFile("config.json", "");
    const found = [...walkMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found.sort()).toEqual(["README.md", "docs/intro.mdx"]);
  });

  it("recurses into nested directories", () => {
    writeFile("a/b/c/deep.md", "");
    const found = [...walkMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["a/b/c/deep.md"]);
  });

  it("skips known build / vendor / VCS dirs", () => {
    writeFile("README.md", "");
    writeFile("node_modules/x/y.md", "");
    writeFile(".git/HEAD.md", "");
    writeFile("dist/out.md", "");
    writeFile(".next/x.md", "");
    writeFile("coverage/lcov.md", "");
    writeFile(".turbo/cache.md", "");
    writeFile("jarvis-data/x.md", "");
    const found = [...walkMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["README.md"]);
  });

  it("returns empty when the dir is unreadable / missing", () => {
    expect([...walkMarkdownFiles(path.join(dir, "no-such-subdir"))]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collector.collect() — fetch + severity mapping
// ---------------------------------------------------------------------------

interface FakeFetchCall {
  url: string;
  method: string;
}

function fakeFetch(
  responses: Record<string, number | "throw">,
): {
  fetchFn: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: { method?: string },
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const status = responses[url];
    if (status === "throw") {
      throw new Error(`network failure for ${url}`);
    }
    if (status === undefined) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    return {
      status,
      ok: status >= 200 && status < 300,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

describe("createBrokenLinksCollector", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bl-coll-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeMd(rel: string, body: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  function ctx(): CollectorContext {
    return { cwd: dir, app: "test-app" };
  }

  it("returns no signals when there are no markdown files", async () => {
    const { fetchFn, calls } = fakeFetch({});
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns no signals when every URL responds 200", async () => {
    writeMd("README.md", "[a](https://ok.example/a) [b](https://ok.example/b)");
    const { fetchFn } = fakeFetch({
      "https://ok.example/a": 200,
      "https://ok.example/b": 200,
    });
    const collector = createBrokenLinksCollector({ fetchFn });
    expect(await collector.collect(ctx())).toEqual([]);
  });

  it("emits a `medium` signal for a 404 / 410", async () => {
    writeMd("README.md", "see [docs](https://example.com/missing)");
    const { fetchFn } = fakeFetch({ "https://example.com/missing": 404 });
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "broken-links",
      severity: "medium",
      dedupKey: "broken-links:https://example.com/missing",
    });
    expect(signals[0]?.summary).toContain("404");
    expect(signals[0]?.details).toMatchObject({ status: 404 });
  });

  it("emits a `high` signal for a 5xx", async () => {
    writeMd("README.md", "broken: https://flaky.example/api");
    const { fetchFn } = fakeFetch({ "https://flaky.example/api": 503 });
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("high");
    expect(signals[0]?.summary).toContain("503");
  });

  it("emits a `low` signal when the network call throws", async () => {
    writeMd("README.md", "ref: https://nope.example/dead");
    const { fetchFn } = fakeFetch({ "https://nope.example/dead": "throw" });
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("low");
    expect(signals[0]?.summary).toContain("unreachable");
    expect(signals[0]?.details).toMatchObject({
      url: "https://nope.example/dead",
      error: expect.stringContaining("network failure"),
    });
  });

  it("dedupes the same URL across multiple files into one signal", async () => {
    writeMd("a.md", "[x](https://example.com/missing)");
    writeMd("docs/b.md", "[y](https://example.com/missing)");
    const { fetchFn, calls } = fakeFetch({
      "https://example.com/missing": 404,
    });
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    // And the URL was only fetched once (deduped before the check)
    expect(calls.filter((c) => c.method !== "GET").length).toBeLessThanOrEqual(1);
  });

  it("retries with GET when the server returns 405 to HEAD", async () => {
    writeMd("README.md", "ref: https://strict.example/api");
    let firstCall = true;
    const fetchFn = (async (input: string | URL, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      const url = typeof input === "string" ? input : input.toString();
      if (firstCall && method === "HEAD") {
        firstCall = false;
        return { status: 405, ok: false } as Response;
      }
      return { status: 200, ok: true } as Response;
    }) as unknown as typeof globalThis.fetch;
    const collector = createBrokenLinksCollector({ fetchFn });
    const signals = await collector.collect(ctx());
    expect(signals).toEqual([]);
  });

  it("respects the concurrency cap", async () => {
    // Five URLs, concurrency=2: at most 2 should be in flight at once.
    writeMd(
      "README.md",
      "[1](https://a.example) [2](https://b.example) [3](https://c.example) [4](https://d.example) [5](https://e.example)",
    );
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 200, ok: true } as Response;
    }) as unknown as typeof globalThis.fetch;
    const collector = createBrokenLinksCollector({ fetchFn, concurrency: 2 });
    await collector.collect(ctx());
    expect(peak).toBeLessThanOrEqual(2);
  });
});
