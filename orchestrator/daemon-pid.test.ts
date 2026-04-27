import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquirePidFile,
  PidFileHeldError,
  readPidFile,
  releasePidFile,
} from "./daemon-pid.ts";

describe("daemon-pid", () => {
  let dir: string;
  let pidPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-daemon-pid-"));
    pidPath = path.join(dir, ".daemon.pid");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("readPidFile returns null when missing", () => {
    expect(readPidFile(pidPath)).toBeNull();
  });

  it("readPidFile returns null on a malformed file", () => {
    fs.writeFileSync(pidPath, "garbage");
    expect(readPidFile(pidPath)).toBeNull();
  });

  it("acquirePidFile writes a JSON record with pid + startedAt", () => {
    const fakeNow = new Date("2026-04-27T12:00:00Z");
    const data = acquirePidFile(pidPath, {
      pid: 12345,
      now: () => fakeNow,
    });
    expect(data).toEqual({
      pid: 12345,
      startedAt: "2026-04-27T12:00:00.000Z",
    });
    const onDisk = readPidFile(pidPath);
    expect(onDisk).toEqual(data);
  });

  it("refuses when another live process holds the pid file", () => {
    const otherPid = 99_999_999;
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: otherPid,
        startedAt: new Date().toISOString(),
      }),
    );
    expect(() =>
      acquirePidFile(pidPath, {
        pid: 1234,
        isPidAlive: () => true,
      }),
    ).toThrow(PidFileHeldError);
  });

  it("takes over a stale pid file (holding pid is dead)", () => {
    const deadPid = 99_999_998;
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    const data = acquirePidFile(pidPath, {
      pid: 4321,
      isPidAlive: (p) => p !== deadPid,
    });
    expect(data.pid).toBe(4321);
    expect(readPidFile(pidPath)?.pid).toBe(4321);
  });

  it("re-acquiring with the same pid updates startedAt without throwing", () => {
    acquirePidFile(pidPath, {
      pid: 1234,
      now: () => new Date("2026-04-27T10:00:00Z"),
    });
    const second = acquirePidFile(pidPath, {
      pid: 1234,
      now: () => new Date("2026-04-27T11:00:00Z"),
    });
    expect(second.startedAt).toBe("2026-04-27T11:00:00.000Z");
  });

  it("releasePidFile removes the file when pid matches", () => {
    acquirePidFile(pidPath, { pid: 1234 });
    releasePidFile(pidPath, { pid: 1234 });
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("releasePidFile is a no-op when another pid holds the file", () => {
    fs.writeFileSync(
      pidPath,
      JSON.stringify({
        pid: 9999,
        startedAt: new Date().toISOString(),
      }),
    );
    releasePidFile(pidPath, { pid: 1234 });
    expect(fs.existsSync(pidPath)).toBe(true);
  });

  it("releasePidFile is a no-op when the file is missing", () => {
    expect(() => releasePidFile(pidPath, { pid: 1234 })).not.toThrow();
  });
});
