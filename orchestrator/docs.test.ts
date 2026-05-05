import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brainDir,
  brainDocsFile,
  brainFile,
} from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { saveBrain } from "./brain.ts";
import {
  cacheAbsolutePath,
  cacheRelativePath,
  docIdFromSource,
  DocsError,
  isUrl,
  loadDocSource,
  loadDocsIndex,
  readCachedDocContent,
  removeCachedDocDir,
  saveDocsIndex,
  truncate,
  uniqueDocId,
  writeCachedDocContent,
  type DocEntry,
} from "./docs.ts";

function seedBrain(sandbox: InstallSandbox, app: string): void {
  const brainPath = brainFile(sandbox.dataDir, "personal", app);
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  saveBrain(brainPath, {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    userPreferences: {},
    connections: {},
    priorities: [],
    wip: {},
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isUrl", () => {
  it("matches http and https", () => {
    expect(isUrl("https://example.com/foo")).toBe(true);
    expect(isUrl("http://example.com")).toBe(true);
    expect(isUrl("HTTPS://example.com")).toBe(true);
  });
  it("rejects file paths", () => {
    expect(isUrl("/Users/me/doc.md")).toBe(false);
    expect(isUrl("./relative.md")).toBe(false);
    expect(isUrl("ftp://example.com")).toBe(false);
  });
});

describe("docIdFromSource", () => {
  it("derives a slug from a file basename", () => {
    expect(docIdFromSource("/tmp/Brand Guidelines v2.md")).toBe(
      "brand-guidelines-v2-md",
    );
  });
  it("derives a slug from a URL", () => {
    expect(docIdFromSource("https://example.com/api/v1/spec.html")).toContain(
      "example-com",
    );
  });
  it("never returns empty", () => {
    expect(docIdFromSource("/")).toBe("doc");
  });
  it("caps at 60 chars", () => {
    const long = "/tmp/" + "a".repeat(200) + ".md";
    const id = docIdFromSource(long);
    expect(id.length).toBeLessThanOrEqual(60);
  });
});

describe("uniqueDocId", () => {
  it("returns the input when free", () => {
    expect(uniqueDocId("foo", ["bar", "baz"])).toBe("foo");
  });
  it("appends -2 on first collision", () => {
    expect(uniqueDocId("foo", ["foo"])).toBe("foo-2");
  });
  it("walks past existing -2 / -3 suffixes", () => {
    expect(uniqueDocId("foo", ["foo", "foo-2", "foo-3"])).toBe("foo-4");
  });
});

describe("truncate", () => {
  it("returns text unchanged when under cap", () => {
    expect(truncate("short", 100, "/tmp/x")).toBe("short");
  });
  it("truncates and annotates over cap", () => {
    const out = truncate("a".repeat(50), 10, "/tmp/x");
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("truncated at 10 bytes");
    expect(out).toContain("original 50 bytes");
    expect(out).toContain("/tmp/x");
  });
});

// ---------------------------------------------------------------------------
// loadDocSource
// ---------------------------------------------------------------------------

describe("loadDocSource", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a local file", async () => {
    const file = path.join(tmpDir, "spec.md");
    fs.writeFileSync(file, "# Spec\n\nHello");
    const fetcher = async (): Promise<{ content: string }> => ({
      content: "should not be called",
    });
    const result = await loadDocSource(file, fetcher);
    expect(result.kind).toBe("file");
    expect(result.content).toContain("# Spec");
  });

  it("rejects relative paths", async () => {
    const fetcher = async (): Promise<{ content: string }> => ({
      content: "x",
    });
    await expect(loadDocSource("./foo.md", fetcher)).rejects.toThrow(
      DocsError,
    );
  });

  it("rejects non-existent paths", async () => {
    const fetcher = async (): Promise<{ content: string }> => ({
      content: "x",
    });
    await expect(
      loadDocSource(path.join(tmpDir, "missing.md"), fetcher),
    ).rejects.toThrow(/not found/);
  });

  it("rejects directories", async () => {
    const fetcher = async (): Promise<{ content: string }> => ({
      content: "x",
    });
    await expect(loadDocSource(tmpDir, fetcher)).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("delegates URLs to the fetcher", async () => {
    let fetched = "";
    const fetcher = async (
      u: string,
    ): Promise<{ content: string }> => {
      fetched = u;
      return { content: "<html>doc</html>" };
    };
    const result = await loadDocSource("https://example.com/x", fetcher);
    expect(fetched).toBe("https://example.com/x");
    expect(result.kind).toBe("url");
    expect(result.content).toContain("html");
  });

  it("truncates oversized content", async () => {
    const file = path.join(tmpDir, "big.md");
    fs.writeFileSync(file, "x".repeat(1000));
    const fetcher = async (): Promise<{ content: string }> => ({
      content: "x",
    });
    const result = await loadDocSource(file, fetcher, 100);
    expect(result.content.length).toBeLessThan(1000);
    expect(result.content).toContain("truncated at 100");
  });
});

// ---------------------------------------------------------------------------
// Index I/O + cache layout
// ---------------------------------------------------------------------------

describe("loadDocsIndex / saveDocsIndex", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    seedBrain(sandbox, "demo");
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("returns empty array when docs.json is missing", () => {
    expect(loadDocsIndex(sandbox.dataDir, "personal", "demo")).toEqual([]);
  });

  it("round-trips a valid index", () => {
    const entries: DocEntry[] = [
      {
        id: "spec",
        kind: "file",
        retention: "cached",
        source: "/tmp/spec.md",
        title: "Spec",
        tags: ["api"],
        addedAt: "2026-05-04T12:00:00.000Z",
        summary: "",
        cachedFile: "docs/spec/content.txt",
      },
    ];
    saveDocsIndex(sandbox.dataDir, "personal", "demo", entries);
    expect(loadDocsIndex(sandbox.dataDir, "personal", "demo")).toEqual(entries);
  });

  it("drops invalid entries silently", () => {
    const file = brainDocsFile(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "good", kind: "file", retention: "cached", source: "/tmp/g", title: "g", addedAt: "2026-01-01", tags: [], summary: "" },
        { id: "bad" }, // missing required
      ]),
    );
    const out = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("good");
  });

  it("throws DocsError on non-JSON content", () => {
    const file = brainDocsFile(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    expect(() => loadDocsIndex(sandbox.dataDir, "personal", "demo")).toThrow(
      DocsError,
    );
  });

  it("throws DocsError when JSON is not an array", () => {
    const file = brainDocsFile(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id: "x" }));
    expect(() => loadDocsIndex(sandbox.dataDir, "personal", "demo")).toThrow(
      /array/,
    );
  });
});

describe("cache file IO", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    seedBrain(sandbox, "demo");
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("cacheRelativePath uses POSIX separators", () => {
    expect(cacheRelativePath("foo")).toBe("docs/foo/content.txt");
  });

  it("writes + reads cached content", () => {
    writeCachedDocContent(sandbox.dataDir, "personal", "demo", "spec", "hello");
    const abs = cacheAbsolutePath(sandbox.dataDir, "personal", "demo", "spec");
    expect(fs.existsSync(abs)).toBe(true);
    expect(
      readCachedDocContent(sandbox.dataDir, "personal", "demo", "spec"),
    ).toBe("hello");
  });

  it("readCachedDocContent returns null when missing", () => {
    expect(
      readCachedDocContent(sandbox.dataDir, "personal", "demo", "nope"),
    ).toBeNull();
  });

  it("removeCachedDocDir is idempotent", () => {
    writeCachedDocContent(sandbox.dataDir, "personal", "demo", "spec", "x");
    removeCachedDocDir(sandbox.dataDir, "personal", "demo", "spec");
    expect(
      fs.existsSync(
        path.join(brainDir(sandbox.dataDir, "personal", "demo"), "docs", "spec"),
      ),
    ).toBe(false);
    // second call must not throw
    removeCachedDocDir(sandbox.dataDir, "personal", "demo", "spec");
  });
});
