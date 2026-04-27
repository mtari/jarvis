import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.ts";

const lockDataSchema = z.object({
  pid: z.number().int(),
  heldSince: z.string(),
  heartbeat: z.string(),
});

export type LockData = z.infer<typeof lockDataSchema>;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
const DEFAULT_STALE_HEARTBEAT_MS = 10000;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_RETRY_TIMEOUT_MS = 5000;

export interface AcquireOptions {
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  retryDelayMs?: number;
  retryTimeoutMs?: number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export interface AcquiredLock {
  readonly path: string;
  release(): void;
  tickHeartbeat(): void;
}

export class LockHeldError extends Error {
  public readonly heldBy: LockData;

  constructor(heldBy: LockData) {
    super(`Lock held by pid=${heldBy.pid} since ${heldBy.heldSince}`);
    this.name = "LockHeldError";
    this.heldBy = heldBy;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readLockFile(lockPath: string): LockData | null {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return lockDataSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function inspectLock(lockPath: string): LockData | null {
  return readLockFile(lockPath);
}

export interface StaleCheckOptions {
  staleHeartbeatMs?: number;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
}

export function isLockStale(
  data: LockData,
  opts: StaleCheckOptions = {},
): boolean {
  const stale = opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
  const now = opts.now ?? (() => new Date());
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const heartbeatAt = Date.parse(data.heartbeat);
  if (Number.isNaN(heartbeatAt)) return true;
  if (now().getTime() - heartbeatAt > stale) return true;
  if (!isPidAlive(data.pid)) return true;
  return false;
}

function exclusiveWrite(lockPath: string, data: LockData): void {
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function acquireLock(
  lockPath: string,
  opts: AcquireOptions = {},
): Promise<AcquiredLock> {
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleHeartbeatMs =
    opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retryTimeoutMs = opts.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? (() => new Date());

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const start = Date.now();

  while (true) {
    const stamp = now().toISOString();
    const data: LockData = {
      pid,
      heldSince: stamp,
      heartbeat: stamp,
    };
    try {
      exclusiveWrite(lockPath, data);
      return makeAcquiredLock(lockPath, data, heartbeatIntervalMs, now);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const existing = readLockFile(lockPath);
    if (
      !existing ||
      isLockStale(existing, { staleHeartbeatMs, now, isPidAlive })
    ) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() - start > retryTimeoutMs) {
      throw new LockHeldError(existing);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

function makeAcquiredLock(
  lockPath: string,
  initial: LockData,
  intervalMs: number,
  now: () => Date,
): AcquiredLock {
  let current = initial;
  let released = false;

  const tick = (): void => {
    if (released) return;
    current = { ...current, heartbeat: now().toISOString() };
    try {
      atomicWriteFileSync(
        lockPath,
        JSON.stringify(current, null, 2) + "\n",
      );
    } catch {
      // best-effort; the next acquirer will see a stale heartbeat
    }
  };

  let intervalHandle: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    intervalHandle = setInterval(tick, intervalMs);
    intervalHandle.unref();
  }

  return {
    path: lockPath,
    tickHeartbeat: tick,
    release(): void {
      if (released) return;
      released = true;
      if (intervalHandle) clearInterval(intervalHandle);
      fs.rmSync(lockPath, { force: true });
    },
  };
}
