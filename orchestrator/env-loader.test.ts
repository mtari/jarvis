import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnv } from "./env-loader.ts";

describe("parseEnv", () => {
  it("parses key=value pairs", () => {
    expect(parseEnv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnv("# comment\n\nFOO=bar\n# trailing")).toEqual({
      FOO: "bar",
    });
  });

  it("strips matching surrounding quotes", () => {
    expect(parseEnv('FOO="bar"\nBAZ=\'qux\'')).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("ignores lines without an equals sign", () => {
    expect(parseEnv("not-a-pair\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("rejects keys that aren't valid identifiers", () => {
    expect(parseEnv("123FOO=bar\nBAZ=qux")).toEqual({ BAZ: "qux" });
  });
});

describe("loadEnvFile", () => {
  let dir: string;
  let envPath: string;
  const trackedKeys = ["JARVIS_TEST_FOO", "JARVIS_TEST_BAR"];
  let originals: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-env-"));
    envPath = path.join(dir, ".env");
    originals = {};
    for (const k of trackedKeys) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of trackedKeys) {
      const orig = originals[k];
      if (orig === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = orig;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads keys into process.env when previously unset", () => {
    fs.writeFileSync(envPath, "JARVIS_TEST_FOO=hello");
    const res = loadEnvFile(envPath);
    expect(res.applied).toContain("JARVIS_TEST_FOO");
    expect(process.env["JARVIS_TEST_FOO"]).toBe("hello");
  });

  it("does not override existing process.env values by default", () => {
    process.env["JARVIS_TEST_FOO"] = "preset";
    fs.writeFileSync(envPath, "JARVIS_TEST_FOO=fromfile");
    const res = loadEnvFile(envPath);
    expect(process.env["JARVIS_TEST_FOO"]).toBe("preset");
    expect(res.applied).not.toContain("JARVIS_TEST_FOO");
  });

  it("overrides when override: true", () => {
    process.env["JARVIS_TEST_FOO"] = "preset";
    fs.writeFileSync(envPath, "JARVIS_TEST_FOO=fromfile");
    loadEnvFile(envPath, { override: true });
    expect(process.env["JARVIS_TEST_FOO"]).toBe("fromfile");
  });

  it("skips empty values (e.g., the post-install ANTHROPIC_API_KEY= stub)", () => {
    fs.writeFileSync(envPath, "JARVIS_TEST_FOO=");
    const res = loadEnvFile(envPath);
    expect(res.applied).not.toContain("JARVIS_TEST_FOO");
    expect(process.env["JARVIS_TEST_FOO"]).toBeUndefined();
  });

  it("returns empty result when file is missing", () => {
    const res = loadEnvFile(path.join(dir, "missing.env"));
    expect(res).toEqual({ loaded: {}, applied: [] });
  });
});
