import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getDataDir, logsDir } from "../paths.ts";

const USAGE = `Usage: yarn jarvis logs <subcommand> [options]

Subcommands:
  tail [--file <path>]    Stream a daemon log file in real time (tail -f).
                          Defaults to today's daemon log in the data dir.
                          Use --file to point at any log path.

Options:
  --file <path>           Override the log file path (useful for testing or
                          pointing at older log files).
`;

/**
 * Resolve today's daemon log path using the standard naming convention:
 * <logsDir>/daemon-YYYY-MM-DD.log
 */
export function todayLogPath(dataDir: string, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return path.join(logsDir(dataDir), `daemon-${yyyy}-${mm}-${dd}.log`);
}

/**
 * Minimal spawn signature used by spawnTail.
 * Accepts an "ignore"|"inherit"|"inherit" stdio tuple and returns a ChildProcess.
 */
export type TailSpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "inherit", "inherit"] | "inherit" | "pipe" },
) => ChildProcess;

export interface RunLogsOptions {
  /** Injectable spawn function; defaults to the real child_process.spawn. */
  spawnFn?: TailSpawnFn;
}

export async function runLogs(
  rawArgs: string[],
  opts: RunLogsOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;

  if (!subcommand) {
    process.stderr.write("logs: subcommand required\n\n");
    process.stdout.write(USAGE);
    return 1;
  }

  if (subcommand !== "tail") {
    process.stderr.write(
      `logs: unknown subcommand "${subcommand}". Expected: tail\n\n`,
    );
    process.stdout.write(USAGE);
    return 1;
  }

  // --- parse tail options ---
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        file: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`logs tail: ${(err as Error).message}\n`);
    return 1;
  }

  const dataDir = getDataDir();
  const logFile = parsed.values.file ?? todayLogPath(dataDir);

  if (!fs.existsSync(logFile)) {
    process.stderr.write(
      `logs tail: log file not found: ${logFile}\n` +
        `  The daemon may not have started yet. Run: yarn jarvis daemon\n`,
    );
    return 1;
  }

  const spawnFn: TailSpawnFn =
    opts.spawnFn ??
    ((cmd, args, spawnOpts) => spawn(cmd, args, spawnOpts as Parameters<typeof spawn>[2]));

  return spawnTail(logFile, spawnFn);
}

/**
 * Spawn `tail -f <file>` with stdio passed through to the parent process.
 * Sends SIGTERM to the child on SIGINT, then exits 0.
 */
function spawnTail(logFile: string, spawnFn: TailSpawnFn): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawnFn("tail", ["-f", logFile], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    const onSigint = (): void => {
      child.kill("SIGTERM");
      resolve(0);
    };
    process.once("SIGINT", onSigint);

    child.once("close", (code) => {
      process.removeListener("SIGINT", onSigint);
      resolve(code ?? 0);
    });

    child.once("error", (err) => {
      process.removeListener("SIGINT", onSigint);
      process.stderr.write(
        `logs tail: failed to spawn tail: ${err.message}\n`,
      );
      resolve(1);
    });
  });
}
