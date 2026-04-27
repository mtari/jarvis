import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface DaemonLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
  /** Force-rotate the underlying file handle. Useful for tests. */
  flush(): void;
  close(): void;
}

export interface CreateLoggerOptions {
  logsDir: string;
  /** Override the clock for tests. */
  now?: () => Date;
  /** Echo every entry to console (useful while developing). Off by default. */
  echo?: boolean;
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export function createDaemonLogger(opts: CreateLoggerOptions): DaemonLogger {
  const now = opts.now ?? (() => new Date());
  let currentFile: string | null = null;
  let closed = false;

  const logFileFor = (date: Date): string =>
    path.join(opts.logsDir, `daemon-${date.toISOString().slice(0, 10)}.log`);

  const ensureFile = (): string => {
    if (closed) {
      throw new Error("DaemonLogger has been closed");
    }
    const target = logFileFor(now());
    if (target !== currentFile) {
      fs.mkdirSync(opts.logsDir, { recursive: true });
      currentFile = target;
    }
    return target;
  };

  const write = (
    level: LogLevel,
    message: string,
    meta: Record<string, unknown> | undefined,
  ): void => {
    const entry: LogEntry = {
      ts: now().toISOString(),
      level,
      message,
      ...(meta ?? {}),
    };
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(ensureFile(), line);
    if (opts.echo) {
      process.stdout.write(line);
    }
  };

  const errorMeta = (
    error: unknown,
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    if (error === undefined) return meta ?? {};
    if (error instanceof Error) {
      return {
        error: {
          name: error.name,
          message: error.message,
          ...(error.stack !== undefined && { stack: error.stack }),
        },
        ...(meta ?? {}),
      };
    }
    return { error, ...(meta ?? {}) };
  };

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, error, meta) =>
      write("error", message, errorMeta(error, meta)),
    flush: () => {
      // Sync appends are already on disk; no-op kept for API symmetry.
    },
    close: () => {
      if (closed) return;
      closed = true;
      currentFile = null;
    },
  };
}
