import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsDir } from "../paths.ts";
import { runLogs, todayLogPath, type TailSpawnFn } from "./logs.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStreams(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

/**
 * Build a fake ChildProcess-shaped object that fires an "error" event on the
 * next tick. Used to test the spawn-error path without relying on module mocks.
 */
function fakeBrokenChild(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  // Minimal ChildProcess surface needed by spawnTail.
  (emitter as unknown as { kill: () => boolean }).kill = () => true;
  setImmediate(() => {
    const err = Object.assign(new Error("spawn tail ENOENT"), {
      code: "ENOENT",
    });
    emitter.emit("error", err);
  });
  return emitter;
}

// ---------------------------------------------------------------------------
// todayLogPath helper
// ---------------------------------------------------------------------------

describe("todayLogPath", () => {
  it("returns a path inside logsDir() with YYYY-MM-DD matching the supplied date", () => {
    const dataDir = "/tmp/fake-data";
    const date = new Date("2026-04-28T12:00:00Z");
    const result = todayLogPath(dataDir, date);
    expect(result).toBe(path.join(logsDir(dataDir), "daemon-2026-04-28.log"));
  });

  it("zero-pads month and day", () => {
    const dataDir = "/tmp/fake-data";
    const date = new Date("2026-01-05T00:00:00Z");
    const result = todayLogPath(dataDir, date);
    expect(result).toBe(path.join(logsDir(dataDir), "daemon-2026-01-05.log"));
  });
});

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------

describe("runLogs — subcommand routing", () => {
  it("returns 1 and prints usage when no subcommand given", async () => {
    const cap = captureStreams();
    try {
      const code = await runLogs([]);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain("subcommand required");
      expect(cap.stdout.join("")).toContain("tail");
    } finally {
      cap.restore();
    }
  });

  it("returns 1 and prints usage for an unknown subcommand", async () => {
    const cap = captureStreams();
    try {
      const code = await runLogs(["watch"]);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain('unknown subcommand "watch"');
      expect(cap.stdout.join("")).toContain("tail");
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// File-not-found error path
// ---------------------------------------------------------------------------

describe("runLogs tail — file not found", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("returns 1 and prints a clear error when the log file does not exist", async () => {
    const cap = captureStreams();
    try {
      const missingFile = path.join(
        logsDir(sandbox.dataDir),
        "daemon-2026-04-28.log",
      );
      const code = await runLogs(["tail", "--file", missingFile]);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain("log file not found");
      expect(cap.stderr.join("")).toContain(missingFile);
      expect(cap.stderr.join("")).toContain("yarn jarvis daemon");
    } finally {
      cap.restore();
    }
  });

  it("returns 1 for missing today's default log (no --file override)", async () => {
    // The sandbox's logs dir is empty; no daemon log has been created.
    const cap = captureStreams();
    try {
      const code = await runLogs(["tail"]);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain("log file not found");
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming integration: pre-written file, SIGINT clean exit
// ---------------------------------------------------------------------------

describe("runLogs tail — streaming from a real file", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-logs-test-"));
    logFile = path.join(tmpDir, "daemon-2026-04-28.log");
    // Write a few pre-existing NDJSON lines so tail -f has content to emit.
    fs.writeFileSync(
      logFile,
      [
        '{"level":"info","message":"daemon starting","pid":1234}',
        '{"level":"info","message":"service started","service":"heartbeat"}',
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 on SIGINT while tail is running", async () => {
    // Emit SIGINT shortly after starting so the test does not hang.
    const timer = setTimeout(() => {
      process.emit("SIGINT", "SIGINT");
    }, 200);

    let code: number;
    try {
      code = await runLogs(["tail", "--file", logFile]);
    } finally {
      clearTimeout(timer);
    }

    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spawn error path — uses the injectable spawnFn to avoid ESM module mocking
// ---------------------------------------------------------------------------

describe("runLogs tail — spawn error", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-logs-err-"));
    logFile = path.join(tmpDir, "daemon.log");
    fs.writeFileSync(logFile, "line\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 1 and prints an error when the child process emits an error event", async () => {
    const brokenSpawn: TailSpawnFn = () => fakeBrokenChild();

    const cap = captureStreams();
    try {
      const code = await runLogs(["tail", "--file", logFile], {
        spawnFn: brokenSpawn,
      });
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain("failed to spawn tail");
    } finally {
      cap.restore();
    }
  });
});
