import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "./atomic-write.ts";

describe("atomicWriteFileSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-atomic-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes content to the destination", () => {
    const file = path.join(dir, "out.txt");
    atomicWriteFileSync(file, "hello");
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
  });

  it("overwrites an existing file", () => {
    const file = path.join(dir, "out.txt");
    fs.writeFileSync(file, "old");
    atomicWriteFileSync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  it("does not leave temp files behind on success", () => {
    const file = path.join(dir, "out.txt");
    atomicWriteFileSync(file, "hello");
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["out.txt"]);
  });

  it("does not leave temp files behind on rename failure", () => {
    const file = path.join(dir, "missing-subdir", "out.txt");
    expect(() => atomicWriteFileSync(file, "hello")).toThrow();
    const parent = path.dirname(path.dirname(file));
    const entries = fs.readdirSync(parent).filter((e) => e !== ".");
    expect(entries).toEqual([]);
  });
});
