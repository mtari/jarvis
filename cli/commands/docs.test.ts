import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadDocsIndex,
  type FetchUrl,
} from "../../orchestrator/docs.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import {
  brainDir,
  brainFile,
  dbFile,
} from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runDocs } from "./docs.ts";

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

describe("runDocs (router)", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("rejects unknown subcommand", async () => {
    const code = await runDocs(["frobnicate"]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("unknown subcommand");
  });

  it("requires a subcommand", async () => {
    const code = await runDocs([]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("missing subcommand");
  });
});

describe("docs list", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    seedBrain(sandbox, "demo");
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires --app", async () => {
    const code = await runDocs(["list"]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("--app is required");
  });

  it("errors when the app isn't onboarded", async () => {
    const code = await runDocs(["list", "--app", "no-brain"]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("not onboarded");
  });

  it("prints a friendly empty message", async () => {
    const code = await runDocs(["list", "--app", "demo"]);
    expect(code).toBe(0);
    expect(
      logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("No docs registered for demo");
  });

  it("emits valid JSON in --format json", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const code = await runDocs([
        "list",
        "--app",
        "demo",
        "--format",
        "json",
      ]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed: unknown = JSON.parse(written.trim());
      expect(Array.isArray(parsed)).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("rejects an unknown --format", async () => {
    const code = await runDocs([
      "list",
      "--app",
      "demo",
      "--format",
      "xml",
    ]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("invalid --format");
  });
});

describe("docs add (cache mode v1)", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    seedBrain(sandbox, "demo");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-add-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires --keep (absorb mode is unimplemented)", async () => {
    const file = path.join(tmpDir, "spec.md");
    fs.writeFileSync(file, "hello");
    const code = await runDocs(["add", "--app", "demo", file]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("absorb mode");
  });

  it("caches a local file end-to-end", async () => {
    const file = path.join(tmpDir, "brand-guide.md");
    fs.writeFileSync(file, "# Brand\n\nFoo bar baz");
    const code = await runDocs([
      "add",
      "--app",
      "demo",
      "--keep",
      "--title",
      "Brand Guide",
      "--tags",
      "brand,voice",
      file,
    ]);
    expect(code).toBe(0);

    const entries = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retention).toBe("cached");
    expect(entries[0]?.kind).toBe("file");
    expect(entries[0]?.title).toBe("Brand Guide");
    expect(entries[0]?.tags).toEqual(["brand", "voice"]);
    expect(entries[0]?.cachedFile).toBe(
      `docs/${entries[0]?.id}/content.txt`,
    );
    const cachePath = path.join(
      brainDir(sandbox.dataDir, "personal", "demo"),
      entries[0]!.cachedFile!,
    );
    expect(fs.readFileSync(cachePath, "utf8")).toContain("# Brand");

    // doc-added event should have been recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT payload FROM events WHERE kind = 'doc-added'")
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({
        retention: "cached",
        kind: "file",
        source: file,
      });
    } finally {
      db.close();
    }
  });

  it("rejects re-adding the same source", async () => {
    const file = path.join(tmpDir, "spec.md");
    fs.writeFileSync(file, "hello");
    expect(
      await runDocs(["add", "--app", "demo", "--keep", file]),
    ).toBe(0);
    const code = await runDocs(["add", "--app", "demo", "--keep", file]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("already registered");
  });

  it("disambiguates id when the same slug is taken by a different source", async () => {
    const a = path.join(tmpDir, "a", "spec.md");
    const b = path.join(tmpDir, "b", "spec.md");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, "A");
    fs.writeFileSync(b, "B");
    expect(
      await runDocs(["add", "--app", "demo", "--keep", a]),
    ).toBe(0);
    expect(
      await runDocs(["add", "--app", "demo", "--keep", b]),
    ).toBe(0);
    const entries = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toMatch(/-2$/);
  });

  it("cache-mode add for a URL uses the injected fetcher", async () => {
    const fetcher: FetchUrl = async () => ({ content: "<html>hi</html>" });
    // runDocs doesn't accept deps directly — but the URL fetcher path is
    // exercised via deps in tests. We pass through to the helper.
    const code = await runDocs(
      ["add", "--app", "demo", "--keep", "https://example.com/x"],
      { fetchUrl: fetcher },
    );
    expect(code).toBe(0);
    const entries = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("url");
    expect(entries[0]?.refreshedAt).toBeDefined();
  });

  it("requires source positional", async () => {
    const code = await runDocs(["add", "--app", "demo", "--keep"]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("source path or URL required");
  });

  it("rejects multiple positionals", async () => {
    const a = path.join(tmpDir, "a.md");
    const b = path.join(tmpDir, "b.md");
    fs.writeFileSync(a, "");
    fs.writeFileSync(b, "");
    const code = await runDocs([
      "add",
      "--app",
      "demo",
      "--keep",
      a,
      b,
    ]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("only one source");
  });

  it("surfaces load errors from the helper", async () => {
    const code = await runDocs([
      "add",
      "--app",
      "demo",
      "--keep",
      "/nonexistent/file.md",
    ]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("not found");
  });
});

describe("docs remove", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    seedBrain(sandbox, "demo");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-rm-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("removes an entry and its cache directory", async () => {
    const file = path.join(tmpDir, "spec.md");
    fs.writeFileSync(file, "hi");
    await runDocs(["add", "--app", "demo", "--keep", file]);
    const entries = loadDocsIndex(sandbox.dataDir, "personal", "demo");
    const id = entries[0]!.id;
    const cacheDir = path.join(
      brainDir(sandbox.dataDir, "personal", "demo"),
      "docs",
      id,
    );
    expect(fs.existsSync(cacheDir)).toBe(true);

    const code = await runDocs(["remove", "--app", "demo", id]);
    expect(code).toBe(0);
    expect(loadDocsIndex(sandbox.dataDir, "personal", "demo")).toHaveLength(0);
    expect(fs.existsSync(cacheDir)).toBe(false);

    // doc-removed event recorded
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT payload FROM events WHERE kind = 'doc-removed'")
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({ docId: id });
    } finally {
      db.close();
    }
  });

  it("requires --app and id", async () => {
    expect(await runDocs(["remove"])).toBe(1);
    expect(await runDocs(["remove", "--app", "demo"])).toBe(1);
  });

  it("errors on unknown id", async () => {
    const code = await runDocs(["remove", "--app", "demo", "ghost"]);
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("no doc with id");
  });
});
