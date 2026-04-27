import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonLogger } from "./daemon-logger.ts";

function readLines(file: string): Array<Record<string, unknown>> {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createDaemonLogger", () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-daemon-log-"));
  });

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("writes JSON-line entries with ts/level/message", () => {
    const logger = createDaemonLogger({
      logsDir,
      now: () => new Date("2026-04-27T10:00:00Z"),
    });
    logger.info("hello", { pid: 1234 });
    logger.warn("careful");
    logger.flush();
    logger.close();

    const file = path.join(logsDir, "daemon-2026-04-27.log");
    const entries = readLines(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      ts: "2026-04-27T10:00:00.000Z",
      level: "info",
      message: "hello",
      pid: 1234,
    });
    expect(entries[1]).toMatchObject({ level: "warn", message: "careful" });
  });

  it("records error meta with name + message + stack", () => {
    const logger = createDaemonLogger({
      logsDir,
      now: () => new Date("2026-04-27T10:00:00Z"),
    });
    const err = new Error("boom");
    logger.error("service failed", err, { service: "test" });
    logger.close();

    const entries = readLines(path.join(logsDir, "daemon-2026-04-27.log"));
    expect(entries[0]).toMatchObject({
      level: "error",
      message: "service failed",
      service: "test",
    });
    const errObj = entries[0]!["error"] as Record<string, string>;
    expect(errObj.name).toBe("Error");
    expect(errObj.message).toBe("boom");
    expect(errObj.stack).toContain("boom");
  });

  it("rotates the file when the date advances", () => {
    let now = new Date("2026-04-27T23:59:59Z");
    const logger = createDaemonLogger({ logsDir, now: () => now });
    logger.info("on day one");
    logger.flush();
    now = new Date("2026-04-28T00:00:01Z");
    logger.info("on day two");
    logger.close();

    const day1 = readLines(path.join(logsDir, "daemon-2026-04-27.log"));
    const day2 = readLines(path.join(logsDir, "daemon-2026-04-28.log"));
    expect(day1).toHaveLength(1);
    expect(day1[0]?.message).toBe("on day one");
    expect(day2).toHaveLength(1);
    expect(day2[0]?.message).toBe("on day two");
  });

  it("creates logsDir if missing", () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    const logger = createDaemonLogger({
      logsDir,
      now: () => new Date("2026-04-27T10:00:00Z"),
    });
    logger.info("hello");
    logger.close();
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it("close() makes further writes throw", () => {
    const logger = createDaemonLogger({ logsDir });
    logger.close();
    expect(() => logger.info("late")).toThrow(/closed/);
  });
});
