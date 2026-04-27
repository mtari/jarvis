import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

const captureWrites = (): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    stdout,
    stderr,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrSpy.mockRestore();
    },
  };
};

describe("dispatch", () => {
  it("prints help and returns 0 with no arguments", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch([]);
      expect(code).toBe(0);
      expect(cap.stdout.join("")).toContain("Usage: yarn jarvis");
    } finally {
      cap.restore();
    }
  });

  it("prints help with --help, -h, or 'help'", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const cap = captureWrites();
      try {
        const code = await dispatch([flag]);
        expect(code).toBe(0);
        expect(cap.stdout.join("")).toContain("Usage: yarn jarvis");
      } finally {
        cap.restore();
      }
    }
  });

  it("returns 1 and prints help on unknown command", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch(["sparkle"]);
      expect(code).toBe(1);
      expect(cap.stderr.join("")).toContain('unknown command "sparkle"');
      expect(cap.stdout.join("")).toContain("Usage: yarn jarvis");
    } finally {
      cap.restore();
    }
  });

  it("run with no agent returns 1", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch(["run"]);
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it("routes install to the install command", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dispatch-"));
    const dataDir = path.join(tmpRoot, "jarvis-data");
    const cap = captureWrites();
    try {
      const code = await dispatch(["install", "--data-dir", dataDir]);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dataDir, "jarvis.db"))).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("version returns 0 and prints Jarvis v", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch(["version"]);
      expect(code).toBe(0);
      expect(cap.stdout.join("")).toContain("Jarvis v");
    } finally {
      cap.restore();
    }
  });
});

describe("profile command", () => {
  let tmpRoot: string;
  let dataDir: string;
  const originalDataDirEnv = process.env["JARVIS_DATA_DIR"];

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-profile-cmd-"));
    dataDir = path.join(tmpRoot, "jarvis-data");
    process.env["JARVIS_DATA_DIR"] = dataDir;

    const cap = captureWrites();
    try {
      await dispatch(["install", "--data-dir", dataDir]);
    } finally {
      cap.restore();
    }
  });

  afterEach(() => {
    if (originalDataDirEnv === undefined) {
      delete process.env["JARVIS_DATA_DIR"];
    } else {
      process.env["JARVIS_DATA_DIR"] = originalDataDirEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("profile (no subcommand) prints a structured summary", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch(["profile"]);
      expect(code).toBe(0);
      const output = cap.stdout.join("") + cap.stderr.join("");
      // console.log writes go through a different path; check console.log spy too
      const consoleLogSpy = vi.mocked(console.log);
      const allLogs = (
        consoleLogSpy.mock.calls.flat().join("\n") + output
      );
      expect(allLogs).toContain("User profile (schemaVersion 1)");
      expect(allLogs).toContain("Identity:");
      expect(allLogs).toContain("Preferences:");
    } finally {
      cap.restore();
    }
  });

  it("profile <unknown-subcommand> returns 1", async () => {
    const cap = captureWrites();
    try {
      const code = await dispatch(["profile", "delete"]);
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });
});
