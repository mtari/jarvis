import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { brainDir, triageDir } from "../../cli/paths.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import { createTriageService, runTriageTickIfDue } from "./service.ts";

interface LogCall {
  level: "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

function fakeDaemonCtx(dataDir: string): {
  ctx: DaemonContext;
  logs: LogCall[];
} {
  const logs: LogCall[] = [];
  return {
    logs,
    ctx: {
      dataDir,
      pidFile: { pid: 1, startedAt: "" },
      logger: {
        info: (message, meta) => logs.push({ level: "info", message, meta }),
        warn: (message, meta) => logs.push({ level: "warn", message, meta }),
        error: (message, _err, meta) =>
          logs.push({ level: "error", message, meta }),
        flush: () => {},
        close: () => {},
      },
    },
  };
}

// The service reads `now.getDay()` and `now.getHours()` — both return
// local time. Constructing via the multi-arg Date constructor lets us
// pin the local-time Monday/9am point regardless of CI timezone.
// Month is zero-indexed: 4 = May.
const MONDAY_9AM = new Date(2026, 4, 4, 9, 0);
const MONDAY_8AM = new Date(2026, 4, 4, 8, 0);
const MONDAY_2PM = new Date(2026, 4, 4, 14, 0);
const NEXT_MONDAY_9AM = new Date(2026, 4, 11, 9, 0);
const SUNDAY_9AM = new Date(2026, 4, 3, 9, 0);
const TUESDAY_9AM = new Date(2026, 4, 5, 9, 0);

function localDateString(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("runTriageTickIfDue", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    fs.rmSync(brainDir(sandbox.dataDir, "personal", "jarvis"), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function tickAt(now: Date): {
    result: ReturnType<typeof runTriageTickIfDue>;
    logs: LogCall[];
  } {
    const { ctx, logs } = fakeDaemonCtx(sandbox.dataDir);
    const result = runTriageTickIfDue({
      dataDir: sandbox.dataDir,
      dayOfWeek: 1, // Monday
      hour: 9,
      windowDays: 7,
      now,
      ctx,
    });
    return { result, logs };
  }

  it("skips when it's the wrong day of the week", () => {
    const { result } = tickAt(SUNDAY_9AM);
    expect(result).toEqual({ fired: false, skipReason: "wrong-day" });
    expect(fs.existsSync(triageDir(sandbox.dataDir))).toBe(false);
  });

  it("skips when it's before the configured hour", () => {
    const { result } = tickAt(MONDAY_8AM);
    expect(result).toEqual({ fired: false, skipReason: "before-hour" });
    expect(fs.existsSync(triageDir(sandbox.dataDir))).toBe(false);
  });

  it("fires on Monday at the configured hour and writes a markdown report", () => {
    const { result, logs } = tickAt(MONDAY_9AM);
    expect(result.fired).toBe(true);
    expect(result.outputPath).toBeDefined();
    const expected = path.join(
      triageDir(sandbox.dataDir),
      `${localDateString(MONDAY_9AM)}.md`,
    );
    expect(result.outputPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    const md = fs.readFileSync(expected, "utf8");
    expect(md).toContain("# Triage —");
    expect(md).toContain("## Summary");
    expect(logs.find((l) => l.message.includes("wrote weekly report"))).toBeTruthy();
  });

  it("skips a second fire on the same day (file-existence guard)", () => {
    const first = tickAt(MONDAY_9AM);
    expect(first.result.fired).toBe(true);
    // Tick again later the same day
    const second = tickAt(MONDAY_2PM);
    expect(second.result).toEqual({
      fired: false,
      skipReason: "already-fired-today",
    });
  });

  it("fires on a different Monday (different date suffix in filename)", () => {
    expect(tickAt(MONDAY_9AM).result.fired).toBe(true);
    expect(tickAt(NEXT_MONDAY_9AM).result.fired).toBe(true);
    const files = fs.readdirSync(triageDir(sandbox.dataDir)).sort();
    expect(files).toHaveLength(2);
  });

  it("doesn't fire on Tuesday even if Monday's run was missed", () => {
    // No file for Monday — but day is Tuesday now.
    const { result } = tickAt(TUESDAY_9AM);
    expect(result).toEqual({ fired: false, skipReason: "wrong-day" });
  });
});

describe("createTriageService", () => {
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

  it("invokes the tick body on start (initial fire)", async () => {
    let called = 0;
    const { ctx } = fakeDaemonCtx(sandbox.dataDir);
    const service = createTriageService({
      dataDir: sandbox.dataDir,
      tickMs: 1_000_000, // long; we only care about the initial fire
      _tickBody: async () => {
        called += 1;
      },
    });
    service.start(ctx);
    // Initial fire is async (void tickFn()); yield to the event loop.
    await new Promise((r) => setTimeout(r, 10));
    service.stop();
    expect(called).toBe(1);
  });

  it("guards against overlapping ticks (tickInFlight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const { ctx } = fakeDaemonCtx(sandbox.dataDir);
    const service = createTriageService({
      dataDir: sandbox.dataDir,
      tickMs: 1, // fire constantly
      _tickBody: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
      },
    });
    service.start(ctx);
    await new Promise((r) => setTimeout(r, 50));
    service.stop();
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("logs an error when the tick body throws and keeps the service alive", async () => {
    const { ctx, logs } = fakeDaemonCtx(sandbox.dataDir);
    let calls = 0;
    const service = createTriageService({
      dataDir: sandbox.dataDir,
      tickMs: 5,
      _tickBody: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    service.start(ctx);
    await new Promise((r) => setTimeout(r, 30));
    service.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(logs.find((l) => l.level === "error")).toBeTruthy();
  });
});
