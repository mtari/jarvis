import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import { runVersion } from "./version.ts";

describe("runVersion", () => {
  let written: string[];
  let restoreStdout: () => void;

  beforeEach(() => {
    written = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        written.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });
    restoreStdout = () => spy.mockRestore();
  });

  afterEach(() => {
    restoreStdout();
  });

  it("returns 0", async () => {
    const code = await runVersion([]);
    expect(code).toBe(0);
  });

  it("prints Jarvis v<semver> matching package.json", async () => {
    await runVersion([]);
    const output = written.join("");
    expect(output).toMatch(/^Jarvis v\d+\.\d+\.\d+/);
    expect(output).toContain(`Jarvis v${pkg.version}`);
  });

  it("ignores extra args and still returns 0", async () => {
    const code = await runVersion(["--foo", "bar"]);
    expect(code).toBe(0);
    expect(written.join("")).toContain("Jarvis v");
  });
});
