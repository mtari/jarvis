import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../orchestrator/atomic-write.ts";
import type { ToolHandler, ToolResult } from "../orchestrator/tool-loop.ts";

export interface DeveloperToolsOptions {
  /** Absolute path of the repo root. All file ops are rooted here and refused outside. */
  repoRoot: string;
  /** Max bytes returned from read_file before truncating. Default 256 KiB. */
  maxReadBytes?: number;
  /** Max bytes accepted by write_file. Default 1 MiB. */
  maxWriteBytes?: number;
  /** Max stdout/stderr captured per run_bash call (each). Default 64 KiB. */
  maxBashOutputBytes?: number;
  /** Default timeout when run_bash callers omit timeoutSec. Default 60s. */
  defaultBashTimeoutSec?: number;
}

export interface DeveloperTools {
  read_file: ToolHandler;
  write_file: ToolHandler;
  list_dir: ToolHandler;
  run_bash: ToolHandler;
}

const DEFAULT_MAX_READ = 256 * 1024;
const DEFAULT_MAX_WRITE = 1024 * 1024;
const DEFAULT_MAX_BASH_OUTPUT = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_SEC = 60;
const SIGKILL_GRACE_MS = 2000;

const FORBIDDEN_TOP_LEVEL_DIRS = new Set([
  ".git",
  "node_modules",
  "jarvis-data",
]);
const FORBIDDEN_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [/^\.env(\..+)?$/];

export class ToolPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPathError";
  }
}

export function resolveSafePath(repoRoot: string, requested: string): string {
  if (!requested) {
    throw new ToolPathError("path is required");
  }
  if (path.isAbsolute(requested)) {
    throw new ToolPathError(`absolute paths are not allowed: ${requested}`);
  }
  const resolved = path.resolve(repoRoot, requested);
  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolPathError(`path escapes repo root: ${requested}`);
  }
  if (rel !== "") {
    const segments = rel.split(path.sep);
    const top = segments[0];
    if (top && FORBIDDEN_TOP_LEVEL_DIRS.has(top)) {
      throw new ToolPathError(`path inside forbidden directory: ${top}/`);
    }
  }
  const base = path.basename(resolved);
  for (const pattern of FORBIDDEN_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      throw new ToolPathError(`path matches forbidden pattern: ${requested}`);
    }
  }
  return resolved;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ToolPathError(`${field} must be a string`);
  }
  return value;
}

export function createDeveloperTools(
  opts: DeveloperToolsOptions,
): DeveloperTools {
  const { repoRoot } = opts;
  if (!path.isAbsolute(repoRoot)) {
    throw new Error("DeveloperTools.repoRoot must be an absolute path");
  }
  const maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ;
  const maxWriteBytes = opts.maxWriteBytes ?? DEFAULT_MAX_WRITE;
  const maxBashOutputBytes =
    opts.maxBashOutputBytes ?? DEFAULT_MAX_BASH_OUTPUT;
  const defaultBashTimeoutSec =
    opts.defaultBashTimeoutSec ?? DEFAULT_BASH_TIMEOUT_SEC;

  const read_file: ToolHandler = {
    definition: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the Jarvis repo. Refuses absolute paths, paths that escape the repo root, anything inside .git/, node_modules/, or jarvis-data/, and any .env* file. Returns truncated content (with a marker) when the file exceeds the byte cap.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path" },
        },
        required: ["path"],
      },
    },
    execute: (input): ToolResult => {
      let resolved: string;
      try {
        resolved = resolveSafePath(repoRoot, asString(input["path"], "path"));
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return {
          content: `file not found: ${input["path"] as string}`,
          isError: true,
        };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return {
          content: `not a file: ${input["path"] as string}`,
          isError: true,
        };
      }
      const buf = fs.readFileSync(resolved);
      if (buf.length > maxReadBytes) {
        const truncated = buf.subarray(0, maxReadBytes).toString("utf8");
        return {
          content:
            `${truncated}\n\n[truncated at ${maxReadBytes} bytes; full size ${buf.length}]`,
        };
      }
      return { content: buf.toString("utf8") };
    },
  };

  const write_file: ToolHandler = {
    definition: {
      name: "write_file",
      description:
        "Atomically write a UTF-8 text file inside the Jarvis repo (tempfile + fsync + rename). Creates parent directories as needed. Same path-safety rules as read_file. Rejects oversized content.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
    execute: (input): ToolResult => {
      let resolved: string;
      try {
        resolved = resolveSafePath(repoRoot, asString(input["path"], "path"));
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      let content: string;
      try {
        content = asString(input["content"], "content");
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > maxWriteBytes) {
        return {
          content: `write_file: content size ${byteLength} bytes exceeds cap ${maxWriteBytes}`,
          isError: true,
        };
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      atomicWriteFileSync(resolved, content);
      return {
        content: `wrote ${input["path"] as string} (${byteLength} bytes)`,
      };
    },
  };

  const list_dir: ToolHandler = {
    definition: {
      name: "list_dir",
      description:
        "List the entries in a directory inside the Jarvis repo. Directories are suffixed with `/`. Same path-safety rules as read_file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative directory path" },
        },
        required: ["path"],
      },
    },
    execute: (input): ToolResult => {
      let resolved: string;
      try {
        resolved = resolveSafePath(repoRoot, asString(input["path"], "path"));
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return {
          content: `not found: ${input["path"] as string}`,
          isError: true,
        };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return {
          content: `not a directory: ${input["path"] as string}`,
          isError: true,
        };
      }
      const entries = fs
        .readdirSync(resolved, { withFileTypes: true })
        .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
        .sort();
      return { content: entries.join("\n") };
    },
  };

  const run_bash: ToolHandler = {
    definition: {
      name: "run_bash",
      description:
        "Run a shell command from the Jarvis repo root with a timeout. Returns the exit code, captured stdout, and captured stderr. Output is truncated per stream beyond the byte cap. Useful for `yarn typecheck`, `yarn test`, `git`, `gh`, etc.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line" },
          timeoutSec: {
            type: "number",
            description: `Per-call timeout. Default ${defaultBashTimeoutSec}s.`,
          },
        },
        required: ["command"],
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const command =
        typeof input["command"] === "string" ? input["command"] : "";
      if (!command.trim()) {
        return { content: "run_bash: empty command", isError: true };
      }
      const timeoutSec =
        typeof input["timeoutSec"] === "number" && input["timeoutSec"] > 0
          ? input["timeoutSec"]
          : defaultBashTimeoutSec;
      const result = await runShell(
        command,
        repoRoot,
        timeoutSec,
        maxBashOutputBytes,
      );
      const lines: string[] = [];
      lines.push(`exit code: ${result.exitCode}`);
      if (result.timedOut) lines.push(`timed out after ${timeoutSec}s`);
      if (result.stdout) lines.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr) lines.push(`--- stderr ---\n${result.stderr}`);
      return {
        content: lines.join("\n"),
        ...((result.exitCode !== 0 || result.timedOut) && { isError: true }),
      };
    },
  };

  return { read_file, write_file, list_dir, run_bash };
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runShell(
  command: string,
  cwd: string,
  timeoutSec: number,
  maxOutputBytes: number,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const onStdout = (chunk: Buffer): void => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
      if (chunk.length > remaining) stdoutTruncated = true;
    };
    const onStderr = (chunk: Buffer): void => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
      if (chunk.length > remaining) stderrTruncated = true;
    };
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);

    const sigtermTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      const sigkillTimer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }, timeoutSec * 1000);
    sigtermTimer.unref();

    proc.on("close", (code) => {
      clearTimeout(sigtermTimer);
      const finalStdout = stdoutTruncated
        ? `${stdout}\n[truncated stdout at ${maxOutputBytes} bytes]`
        : stdout;
      const finalStderr = stderrTruncated
        ? `${stderr}\n[truncated stderr at ${maxOutputBytes} bytes]`
        : stderr;
      resolve({
        exitCode: code ?? -1,
        stdout: finalStdout,
        stderr: finalStderr,
        timedOut,
      });
    });
  });
}
