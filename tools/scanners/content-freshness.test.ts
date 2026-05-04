import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createContentFreshnessCollector,
  severityForAge,
  walkContentMarkdownFiles,
} from "./content-freshness.ts";
import type { CollectorContext } from "./types.ts";

// ---------------------------------------------------------------------------
// severityForAge — pure severity band mapping
// ---------------------------------------------------------------------------

describe("severityForAge", () => {
  it("returns low when age is just past the threshold", () => {
    expect(severityForAge(365, 365)).toBe("low");
    expect(severityForAge(500, 365)).toBe("low");
  });

  it("returns medium at 2x..3x the threshold", () => {
    expect(severityForAge(730, 365)).toBe("medium");
    expect(severityForAge(900, 365)).toBe("medium");
  });

  it("returns high at 3x or more", () => {
    expect(severityForAge(1095, 365)).toBe("high");
    expect(severityForAge(2000, 365)).toBe("high");
  });

  it("scales with a custom threshold", () => {
    expect(severityForAge(100, 50)).toBe("medium");
    expect(severityForAge(160, 50)).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// walkContentMarkdownFiles — file walker
// ---------------------------------------------------------------------------

describe("walkContentMarkdownFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cf-walk-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(rel: string, contents = ""): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  it("yields .md and .mdx files", () => {
    writeFile("post.md", "");
    writeFile("guide.mdx", "");
    writeFile("config.json", "");
    writeFile("notes.txt", "");
    const found = [...walkContentMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found.sort()).toEqual(["guide.mdx", "post.md"]);
  });

  it("skips meta files at any depth (README, CHANGELOG, LICENSE, CLAUDE, etc.)", () => {
    writeFile("README.md", "");
    writeFile("CHANGELOG.md", "");
    writeFile("LICENSE.md", "");
    writeFile("CONTRIBUTING.md", "");
    writeFile("CLAUDE.md", "");
    writeFile("AGENTS.md", "");
    writeFile("docs/CONTRIBUTING.md", "");
    writeFile("docs/post.md", "");
    const found = [...walkContentMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["docs/post.md"]);
  });

  it("is case-insensitive for meta filenames", () => {
    writeFile("readme.md", "");
    writeFile("Readme.md", "");
    writeFile("blog.md", "");
    const found = [...walkContentMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["blog.md"]);
  });

  it("recurses into nested dirs", () => {
    writeFile("a/b/c/deep.md", "");
    const found = [...walkContentMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["a/b/c/deep.md"]);
  });

  it("skips known build / vendor / VCS dirs", () => {
    writeFile("post.md", "");
    writeFile("node_modules/x/y.md", "");
    writeFile(".git/HEAD.md", "");
    writeFile("dist/out.md", "");
    writeFile(".next/x.md", "");
    writeFile("coverage/lcov.md", "");
    writeFile(".turbo/cache.md", "");
    writeFile("jarvis-data/x.md", "");
    const found = [...walkContentMarkdownFiles(dir)].map((f) =>
      path.relative(dir, f),
    );
    expect(found).toEqual(["post.md"]);
  });

  it("returns empty when the dir is unreadable / missing", () => {
    expect([
      ...walkContentMarkdownFiles(path.join(dir, "no-such-subdir")),
    ]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createContentFreshnessCollector — collect()
// ---------------------------------------------------------------------------

describe("createContentFreshnessCollector", () => {
  let dir: string;
  const FIXED_NOW = new Date("2026-05-01T00:00:00.000Z");
  const NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);
  const DAY = 86_400;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cf-coll-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeMd(rel: string, body = ""): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  function ctx(): CollectorContext {
    return { cwd: dir, app: "test-app" };
  }

  /** Build a getLastModified seam from a relpath → ageDays map. */
  function mtimeMap(byRel: Record<string, number>) {
    return (abs: string, cwd: string): number | null => {
      const rel = path.relative(cwd, abs);
      const ageDays = byRel[rel];
      if (ageDays === undefined) return null;
      return NOW_SEC - ageDays * DAY;
    };
  }

  it("returns no signals when there are no content markdown files", async () => {
    const collector = createContentFreshnessCollector({
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({}),
    });
    expect(await collector.collect(ctx())).toEqual([]);
  });

  it("returns no signals when every file is below the threshold", async () => {
    writeMd("post-a.md");
    writeMd("post-b.md");
    const collector = createContentFreshnessCollector({
      staleDays: 365,
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({ "post-a.md": 30, "post-b.md": 364 }),
    });
    expect(await collector.collect(ctx())).toEqual([]);
  });

  it("emits one signal per stale file with the right dedupKey", async () => {
    writeMd("blog/old.md");
    const collector = createContentFreshnessCollector({
      staleDays: 365,
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({ "blog/old.md": 400 }),
    });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "content-freshness",
      severity: "low",
      dedupKey: "content-freshness:blog/old.md",
    });
    expect(signals[0]?.details).toMatchObject({
      file: "blog/old.md",
      ageDays: 400,
      staleDays: 365,
    });
    expect(signals[0]?.summary).toContain("400d");
  });

  it("severity bands track the staleness ratio", async () => {
    writeMd("a.md");
    writeMd("b.md");
    writeMd("c.md");
    const collector = createContentFreshnessCollector({
      staleDays: 100,
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({
        "a.md": 150, // 1.5x → low
        "b.md": 250, // 2.5x → medium
        "c.md": 400, // 4x   → high
      }),
    });
    const signals = await collector.collect(ctx());
    const byFile = Object.fromEntries(
      signals.map((s) => [s.dedupKey, s.severity]),
    );
    expect(byFile["content-freshness:a.md"]).toBe("low");
    expect(byFile["content-freshness:b.md"]).toBe("medium");
    expect(byFile["content-freshness:c.md"]).toBe("high");
  });

  it("skips files for which getLastModified returns null", async () => {
    writeMd("tracked.md");
    writeMd("untracked.md");
    const collector = createContentFreshnessCollector({
      staleDays: 100,
      now: () => FIXED_NOW,
      getLastModified: (abs, cwd) => {
        const rel = path.relative(cwd, abs);
        return rel === "tracked.md" ? NOW_SEC - 200 * DAY : null;
      },
    });
    const signals = await collector.collect(ctx());
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dedupKey).toBe("content-freshness:tracked.md");
  });

  it("ignores meta files even if stale (skipped at walk)", async () => {
    writeMd("README.md");
    writeMd("post.md");
    const collector = createContentFreshnessCollector({
      staleDays: 100,
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({ "README.md": 9999, "post.md": 9999 }),
    });
    const signals = await collector.collect(ctx());
    expect(signals.map((s) => s.dedupKey)).toEqual([
      "content-freshness:post.md",
    ]);
  });

  it("uses default staleDays = 365 when not specified", async () => {
    writeMd("just-fresh.md");
    writeMd("just-stale.md");
    const collector = createContentFreshnessCollector({
      now: () => FIXED_NOW,
      getLastModified: mtimeMap({
        "just-fresh.md": 364,
        "just-stale.md": 365,
      }),
    });
    const signals = await collector.collect(ctx());
    expect(signals.map((s) => s.dedupKey)).toEqual([
      "content-freshness:just-stale.md",
    ]);
  });
});
