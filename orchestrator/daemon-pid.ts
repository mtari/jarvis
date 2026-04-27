import fs from "node:fs";
import { z } from "zod";

const pidFileSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
});

export type PidFileData = z.infer<typeof pidFileSchema>;

export class PidFileHeldError extends Error {
  public readonly heldBy: PidFileData;

  constructor(heldBy: PidFileData) {
    super(
      `Daemon already running (pid ${heldBy.pid}, since ${heldBy.startedAt})`,
    );
    this.name = "PidFileHeldError";
    this.heldBy = heldBy;
  }
}

export interface AcquireOptions {
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export function readPidFile(pidPath: string): PidFileData | null {
  let text: string;
  try {
    text = fs.readFileSync(pidPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return pidFileSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquirePidFile(
  pidPath: string,
  opts: AcquireOptions = {},
): PidFileData {
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? (() => new Date());

  const existing = readPidFile(pidPath);
  if (existing && existing.pid !== pid && isPidAlive(existing.pid)) {
    throw new PidFileHeldError(existing);
  }

  const data: PidFileData = {
    pid,
    startedAt: now().toISOString(),
  };
  fs.writeFileSync(pidPath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  return data;
}

export function releasePidFile(
  pidPath: string,
  opts: { pid?: number } = {},
): void {
  const pid = opts.pid ?? process.pid;
  const existing = readPidFile(pidPath);
  if (existing && existing.pid === pid) {
    fs.rmSync(pidPath, { force: true });
  }
}
