import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { runTelemetry } from "./telemetry.ts";

describe("runTelemetry", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("prints a table report on an empty database (exit 0)", async () => {
    expect(await runTelemetry([])).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Telemetry");
    expect(out).toContain("Plan transitions:");
    expect(out).toContain("Override rate");
    expect(out).toContain("(no review decisions recorded in this window)");
    expect(out).toContain("Escalations:");
    expect(out).toContain("Learning loop:");
  });

  it("renders override rates with counts when feedback exists", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "i1", type: "improvement" },
      });
      recordFeedback(db, {
        kind: "reject",
        actor: "user",
        targetType: "plan",
        targetId: "i1",
      });
    } finally {
      db.close();
    }
    expect(await runTelemetry([])).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("improvement");
    expect(out).toContain("rejected=1");
  });

  it("--format json emits a parseable report", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const code = await runTelemetry(["--format", "json"]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed: unknown = JSON.parse(written.trim());
      expect(parsed).toHaveProperty("planTransitions");
      expect(parsed).toHaveProperty("overrideRates");
      expect(parsed).toHaveProperty("escalations");
      expect(parsed).toHaveProperty("learningLoop");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("rejects invalid --format", async () => {
    expect(await runTelemetry(["--format", "xml"])).toBe(1);
    const err = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(err).toContain("invalid --format");
  });

  it("rejects unknown options", async () => {
    expect(await runTelemetry(["--bogus"])).toBe(1);
  });

  it("--since narrows the window", async () => {
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 60);
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(db, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "plan-drafted",
        payload: { planId: "old", type: "improvement" },
        createdAt: longAgo.toISOString(),
      });
    } finally {
      db.close();
    }
    const since = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    })();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      expect(
        await runTelemetry(["--since", since, "--format", "json"]),
      ).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed = JSON.parse(written.trim()) as {
        planTransitions: { drafted: number };
      };
      expect(parsed.planTransitions.drafted).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
