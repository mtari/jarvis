import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCached, setCached } from "./cache.ts";

describe("cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    const result = getCached<string>(tmpDir, "missing");
    expect(result).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "bad.json"), "not-json{{{");
    const result = getCached<string>(tmpDir, "bad");
    expect(result).toBeNull();
  });

  it("returns null past TTL boundary", () => {
    const ttlMs = 60_000;
    setCached(tmpDir, "item", "hello", { nowMs: 1000, ttlMs });
    const result = getCached<string>(tmpDir, "item", { nowMs: 1000 + ttlMs + 1 });
    expect(result).toBeNull();
  });

  it("returns value within TTL boundary", () => {
    const ttlMs = 60_000;
    setCached(tmpDir, "item", "hello", { nowMs: 1000, ttlMs });
    const result = getCached<string>(tmpDir, "item", { nowMs: 1000 + ttlMs - 1 });
    expect(result).toBe("hello");
  });

  it("setCached writes a valid JSON file", () => {
    setCached(tmpDir, "mykey", { x: 1 }, { nowMs: 5000, ttlMs: 3600_000 });
    const filePath = path.join(tmpDir, "mykey.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { cachedAt: number; ttlMs: number; value: { x: number } };
    expect(parsed.cachedAt).toBe(5000);
    expect(parsed.ttlMs).toBe(3600_000);
    expect(parsed.value).toEqual({ x: 1 });
  });

  it("round-trip setCached → getCached returns original value", () => {
    const data = { name: "Acme", score: 42 };
    setCached(tmpDir, "roundtrip", data, { nowMs: 1000, ttlMs: 86400_000 });
    const result = getCached<typeof data>(tmpDir, "roundtrip", { nowMs: 2000 });
    expect(result).toEqual(data);
  });

  it("setCached creates intermediate directories", () => {
    const nestedDir = path.join(tmpDir, "a", "b", "c");
    setCached(nestedDir, "key", "value");
    const filePath = path.join(nestedDir, "key.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("returns null exactly at TTL expiry (boundary condition)", () => {
    const ttlMs = 60_000;
    setCached(tmpDir, "boundary", "data", { nowMs: 0, ttlMs });
    const result = getCached<string>(tmpDir, "boundary", { nowMs: ttlMs + 1 });
    expect(result).toBeNull();
  });
});
