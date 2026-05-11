import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import {
  createDataSyncService,
  runDataSyncTick,
  type ExecSeam,
} from "./service.ts";

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

const DATA_DIR = "/fake/jarvis-data";
const NOW = 1_000_000_000;
const PUSH_DEBOUNCE_MS = 300_000;

describe("runDataSyncTick", () => {
  it("clean-tree no-op — empty status, 0 ahead", async () => {
    const execCalls: string[] = [];
    const exec: ExecSeam = (cmd) => {
      execCalls.push(cmd);
      if (cmd.startsWith("git status")) return Buffer.from("");
      if (cmd.startsWith("git rev-list")) return Buffer.from("0");
      throw new Error(`Unexpected: ${cmd}`);
    };
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const result = await runDataSyncTick({
      dataDir: DATA_DIR,
      pushDebounceMs: PUSH_DEBOUNCE_MS,
      lastPushAt: null,
      now: NOW,
      exec,
      ctx,
    });
    expect(result.action).toBe("no-op");
    expect(execCalls).toHaveLength(2);
  });

  it("dirty-tree commit — status has 1 modified file, 0 ahead", async () => {
    const execCalls: string[] = [];
    const exec: ExecSeam = (cmd) => {
      execCalls.push(cmd);
      if (cmd.startsWith("git status"))
        return Buffer.from("M vaults/personal/brains/jarvis/brain.json");
      if (cmd.startsWith("git add")) return Buffer.from("");
      if (cmd.startsWith("git commit")) return Buffer.from("");
      if (cmd.startsWith("git rev-list")) return Buffer.from("0");
      throw new Error(`Unexpected: ${cmd}`);
    };
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const result = await runDataSyncTick({
      dataDir: DATA_DIR,
      pushDebounceMs: PUSH_DEBOUNCE_MS,
      lastPushAt: null,
      now: NOW,
      exec,
      ctx,
    });
    expect(result.action).toBe("committed");
    expect(result.filesChanged).toBe(1);
    const commitCall = execCalls.find((c) => c.startsWith("git commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain("brain.json");
  });

  it("debounce-satisfied push — empty status, 2 ahead, old lastPushAt", async () => {
    const execCalls: string[] = [];
    const exec: ExecSeam = (cmd) => {
      execCalls.push(cmd);
      if (cmd.startsWith("git status")) return Buffer.from("");
      if (cmd.startsWith("git rev-list")) return Buffer.from("2");
      if (cmd.startsWith("git pull")) return Buffer.from("");
      if (cmd.startsWith("git push")) return Buffer.from("");
      throw new Error(`Unexpected: ${cmd}`);
    };
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const result = await runDataSyncTick({
      dataDir: DATA_DIR,
      pushDebounceMs: PUSH_DEBOUNCE_MS,
      lastPushAt: NOW - PUSH_DEBOUNCE_MS - 1,
      now: NOW,
      exec,
      ctx,
    });
    expect(result.action).toBe("committed-and-pushed");
    expect(result.newLastPushAt).toBe(NOW);
    expect(execCalls.some((c) => c.startsWith("git pull"))).toBe(true);
    expect(execCalls.some((c) => c.startsWith("git push"))).toBe(true);
  });

  it("debounce-not-satisfied skip — 1 ahead, recent lastPushAt", async () => {
    const execCalls: string[] = [];
    const exec: ExecSeam = (cmd) => {
      execCalls.push(cmd);
      if (cmd.startsWith("git status")) return Buffer.from("");
      if (cmd.startsWith("git rev-list")) return Buffer.from("1");
      throw new Error(`Unexpected: ${cmd}`);
    };
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const result = await runDataSyncTick({
      dataDir: DATA_DIR,
      pushDebounceMs: PUSH_DEBOUNCE_MS,
      lastPushAt: NOW - 10,
      now: NOW,
      exec,
      ctx,
    });
    expect(result.action).toBe("skipped-debounce");
    expect(execCalls.some((c) => c.startsWith("git pull"))).toBe(false);
    expect(execCalls.some((c) => c.startsWith("git push"))).toBe(false);
  });

  it("rebase-conflict skip — pull --rebase throws, no push", async () => {
    const execCalls: string[] = [];
    const exec: ExecSeam = (cmd) => {
      execCalls.push(cmd);
      if (cmd.startsWith("git status")) return Buffer.from("");
      if (cmd.startsWith("git rev-list")) return Buffer.from("1");
      if (cmd.startsWith("git pull")) throw new Error("conflict");
      throw new Error(`Unexpected: ${cmd}`);
    };
    const { ctx, logs } = fakeDaemonCtx(DATA_DIR);
    const result = await runDataSyncTick({
      dataDir: DATA_DIR,
      pushDebounceMs: PUSH_DEBOUNCE_MS,
      lastPushAt: NOW - PUSH_DEBOUNCE_MS - 1,
      now: NOW,
      exec,
      ctx,
    });
    expect(result.action).toBe("skipped-conflict");
    expect(execCalls.some((c) => c.startsWith("git push"))).toBe(false);
    const warnLog = logs.find(
      (l) => l.level === "warn" && l.message.includes("pull --rebase failed"),
    );
    expect(warnLog).toBeDefined();
  });
});

describe("createDataSyncService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enabled: false — tick body never called", async () => {
    let called = 0;
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const service = createDataSyncService({
      dataDir: DATA_DIR,
      enabled: false,
      _tickBody: async () => {
        called += 1;
      },
    });
    service.start(ctx);
    await vi.runAllTimersAsync();
    service.stop();
    expect(called).toBe(0);
  });

  it("tickInFlight overlap guard — body called only once during overlap", async () => {
    vi.useRealTimers();
    let inFlight = 0;
    let peak = 0;
    const { ctx } = fakeDaemonCtx(DATA_DIR);
    const service = createDataSyncService({
      dataDir: DATA_DIR,
      enabled: true,
      intervalMs: 1,
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
});
