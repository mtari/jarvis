import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeveloperTools,
  resolveSafePath,
  ToolPathError,
  type DeveloperTools,
} from "./developer-tools.ts";

describe("resolveSafePath", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("resolves a normal repo-relative path", () => {
    expect(resolveSafePath(repo, "src/foo.ts")).toBe(
      path.join(repo, "src/foo.ts"),
    );
  });

  it("rejects empty paths", () => {
    expect(() => resolveSafePath(repo, "")).toThrow(ToolPathError);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveSafePath(repo, "/etc/passwd")).toThrow(ToolPathError);
  });

  it("rejects paths that escape the repo root", () => {
    expect(() => resolveSafePath(repo, "../../etc/passwd")).toThrow(
      ToolPathError,
    );
  });

  it("rejects forbidden top-level directories", () => {
    for (const top of [".git", "node_modules", "jarvis-data"]) {
      expect(() => resolveSafePath(repo, `${top}/anything`)).toThrow(
        ToolPathError,
      );
    }
  });

  it("rejects .env and .env.* files at any depth", () => {
    expect(() => resolveSafePath(repo, ".env")).toThrow(ToolPathError);
    expect(() => resolveSafePath(repo, ".env.local")).toThrow(ToolPathError);
    expect(() => resolveSafePath(repo, "deep/nested/.env.production")).toThrow(
      ToolPathError,
    );
  });

  it("allows nested paths that don't trigger any rule", () => {
    expect(resolveSafePath(repo, "a/b/c.ts")).toBe(
      path.join(repo, "a/b/c.ts"),
    );
  });
});

describe("developer tools", () => {
  let repo: string;
  let tools: DeveloperTools;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dev-tools-"));
    tools = createDeveloperTools({
      repoRoot: repo,
      maxReadBytes: 1024,
      maxWriteBytes: 2048,
      maxBashOutputBytes: 256,
      defaultBashTimeoutSec: 5,
    });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe("read_file", () => {
    it("reads a normal file", async () => {
      fs.writeFileSync(path.join(repo, "hello.txt"), "hello world");
      const result = await tools.read_file.execute({ path: "hello.txt" });
      expect(result.content).toBe("hello world");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError on missing file", async () => {
      const result = await tools.read_file.execute({ path: "missing.txt" });
      expect(result.isError).toBe(true);
    });

    it("returns isError when path points at a directory", async () => {
      fs.mkdirSync(path.join(repo, "sub"));
      const result = await tools.read_file.execute({ path: "sub" });
      expect(result.isError).toBe(true);
    });

    it("rejects forbidden paths via path-safety", async () => {
      const result = await tools.read_file.execute({ path: "/etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/absolute paths/);
    });

    it("truncates files larger than maxReadBytes", async () => {
      fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(2000));
      const result = await tools.read_file.execute({ path: "big.txt" });
      expect(result.content).toContain("[truncated at 1024 bytes");
      expect(result.content.length).toBeGreaterThan(1024);
    });
  });

  describe("write_file", () => {
    it("writes a file atomically and creates parent dirs", async () => {
      const result = await tools.write_file.execute({
        path: "deep/nested/file.txt",
        content: "hello",
      });
      expect(result.isError).toBeUndefined();
      expect(
        fs.readFileSync(path.join(repo, "deep/nested/file.txt"), "utf8"),
      ).toBe("hello");
    });

    it("rejects oversized content", async () => {
      const result = await tools.write_file.execute({
        path: "big.txt",
        content: "x".repeat(3000),
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exceeds cap/);
    });

    it("refuses to write outside the repo", async () => {
      const result = await tools.write_file.execute({
        path: "../escape.txt",
        content: "no",
      });
      expect(result.isError).toBe(true);
    });

    it("refuses .env files", async () => {
      const result = await tools.write_file.execute({
        path: ".env",
        content: "SECRET=x",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("list_dir", () => {
    it("lists entries with directory suffix", async () => {
      fs.writeFileSync(path.join(repo, "a.txt"), "");
      fs.mkdirSync(path.join(repo, "sub"));
      const result = await tools.list_dir.execute({ path: "." });
      const entries = result.content.split("\n");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("sub/");
    });

    it("returns isError on missing directory", async () => {
      const result = await tools.list_dir.execute({ path: "nope" });
      expect(result.isError).toBe(true);
    });

    it("returns isError when path is a file", async () => {
      fs.writeFileSync(path.join(repo, "f.txt"), "");
      const result = await tools.list_dir.execute({ path: "f.txt" });
      expect(result.isError).toBe(true);
    });
  });

  describe("run_bash", () => {
    it("runs a successful command and captures stdout", async () => {
      const result = await tools.run_bash.execute({
        command: "printf 'hello\\nworld'",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("exit code: 0");
      expect(result.content).toContain("hello\nworld");
    });

    it("flags non-zero exit code as isError", async () => {
      const result = await tools.run_bash.execute({
        command: "exit 7",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("exit code: 7");
    });

    it("rejects an empty command", async () => {
      const result = await tools.run_bash.execute({ command: "  " });
      expect(result.isError).toBe(true);
    });

    it("captures stderr separately", async () => {
      const result = await tools.run_bash.execute({
        command: "printf 'oops' 1>&2; exit 1",
      });
      expect(result.content).toContain("--- stderr ---");
      expect(result.content).toContain("oops");
    });

    it("kills runaway commands after the timeout", async () => {
      const result = await tools.run_bash.execute({
        command: "sleep 5",
        timeoutSec: 1,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/timed out after 1s/);
    });

    it("truncates stdout beyond maxBashOutputBytes", async () => {
      const result = await tools.run_bash.execute({
        command: "printf 'x%.0s' $(seq 1 1000)",
      });
      expect(result.content).toMatch(/truncated stdout/);
    });

    it("runs with cwd set to the repo root", async () => {
      fs.writeFileSync(path.join(repo, "marker.txt"), "");
      const result = await tools.run_bash.execute({ command: "ls marker.txt" });
      expect(result.content).toContain("marker.txt");
    });
  });
});
