import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  inspectLock,
  isLockStale,
  LockHeldError,
} from "./lock.ts";

describe("acquireLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lock-"));
    lockPath = path.join(dir, ".lock");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a lock on a fresh path and writes pid + heldSince + heartbeat", async () => {
    const lock = await acquireLock(lockPath, { heartbeatIntervalMs: 0 });
    try {
      const data = inspectLock(lockPath);
      expect(data?.pid).toBe(process.pid);
      expect(data?.heldSince).toBeTypeOf("string");
      expect(data?.heartbeat).toBe(data?.heldSince);
    } finally {
      lock.release();
    }
  });

  it("release removes the lock file", async () => {
    const lock = await acquireLock(lockPath, { heartbeatIntervalMs: 0 });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("creates the parent directory if missing", async () => {
    const nested = path.join(dir, "nested", "dir", ".lock");
    const lock = await acquireLock(nested, { heartbeatIntervalMs: 0 });
    try {
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("throws LockHeldError when held by a fresh other-pid lock", async () => {
    const otherPid = 99_999_999;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: otherPid,
        heldSince: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }),
    );

    await expect(
      acquireLock(lockPath, {
        heartbeatIntervalMs: 0,
        retryDelayMs: 5,
        retryTimeoutMs: 30,
        isPidAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(LockHeldError);
  });

  it("takes over when the holding PID is dead", async () => {
    const deadPid = 99_999_998;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        heldSince: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }),
    );

    const lock = await acquireLock(lockPath, {
      heartbeatIntervalMs: 0,
      isPidAlive: (pid) => pid !== deadPid,
    });
    try {
      const data = inspectLock(lockPath);
      expect(data?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("takes over when the heartbeat is stale", async () => {
    const stalePid = 99_999_997;
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: stalePid,
        heldSince: longAgo,
        heartbeat: longAgo,
      }),
    );

    const lock = await acquireLock(lockPath, {
      heartbeatIntervalMs: 0,
      staleHeartbeatMs: 100,
      isPidAlive: () => true,
    });
    try {
      const data = inspectLock(lockPath);
      expect(data?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("treats a corrupted lock file as missing and takes over", async () => {
    fs.writeFileSync(lockPath, "{not-valid-json");
    const lock = await acquireLock(lockPath, { heartbeatIntervalMs: 0 });
    try {
      const data = inspectLock(lockPath);
      expect(data?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("tickHeartbeat updates the heartbeat timestamp", async () => {
    let now = new Date("2026-04-27T10:00:00Z");
    const lock = await acquireLock(lockPath, {
      heartbeatIntervalMs: 0,
      now: () => now,
    });
    try {
      const before = inspectLock(lockPath);
      expect(before?.heartbeat).toBe("2026-04-27T10:00:00.000Z");

      now = new Date("2026-04-27T10:00:05Z");
      lock.tickHeartbeat();

      const after = inspectLock(lockPath);
      expect(after?.heartbeat).toBe("2026-04-27T10:00:05.000Z");
      expect(after?.heldSince).toBe("2026-04-27T10:00:00.000Z");
    } finally {
      lock.release();
    }
  });
});

describe("inspectLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lock-inspect-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the lock file is missing", () => {
    expect(inspectLock(path.join(dir, ".lock"))).toBeNull();
  });

  it("returns null when the lock file is malformed", () => {
    const lockPath = path.join(dir, ".lock");
    fs.writeFileSync(lockPath, "garbage");
    expect(inspectLock(lockPath)).toBeNull();
  });

  it("returns parsed data for a valid lock file", () => {
    const lockPath = path.join(dir, ".lock");
    const data = {
      pid: 1234,
      heldSince: "2026-04-27T10:00:00.000Z",
      heartbeat: "2026-04-27T10:00:02.000Z",
    };
    fs.writeFileSync(lockPath, JSON.stringify(data));
    expect(inspectLock(lockPath)).toEqual(data);
  });
});

describe("isLockStale", () => {
  const fresh = {
    pid: 100,
    heldSince: "2026-04-27T10:00:00.000Z",
    heartbeat: "2026-04-27T10:00:02.000Z",
  };
  const baseNow = () => new Date("2026-04-27T10:00:03.000Z");

  it("is fresh when the heartbeat is within the window and the PID is alive", () => {
    expect(
      isLockStale(fresh, { now: baseNow, isPidAlive: () => true }),
    ).toBe(false);
  });

  it("is stale when the heartbeat is older than the window", () => {
    const lateNow = () => new Date("2026-04-27T10:00:30.000Z");
    expect(
      isLockStale(fresh, {
        now: lateNow,
        isPidAlive: () => true,
        staleHeartbeatMs: 10_000,
      }),
    ).toBe(true);
  });

  it("is stale when the holding PID is dead", () => {
    expect(
      isLockStale(fresh, { now: baseNow, isPidAlive: () => false }),
    ).toBe(true);
  });

  it("is stale when the heartbeat is unparseable", () => {
    expect(
      isLockStale(
        { ...fresh, heartbeat: "not-a-date" },
        { now: baseNow, isPidAlive: () => true },
      ),
    ).toBe(true);
  });
});
