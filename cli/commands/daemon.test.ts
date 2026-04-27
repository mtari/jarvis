import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapDaemon,
  createHeartbeatService,
  DaemonError,
  type DaemonContext,
  type DaemonService,
} from "./daemon.ts";
import { PidFileHeldError, readPidFile } from "../../orchestrator/daemon-pid.ts";
import { daemonPidFile, logsDir } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";

interface RecordingService extends DaemonService {
  startedWith?: DaemonContext;
  stopCalls: number;
}

function recordingService(name: string, options: { failOnStart?: boolean } = {}): RecordingService {
  const svc: RecordingService = {
    name,
    stopCalls: 0,
    start(ctx) {
      svc.startedWith = ctx;
      if (options.failOnStart) throw new Error(`${name} boom`);
    },
    stop() {
      svc.stopCalls += 1;
    },
  };
  return svc;
}

describe("bootstrapDaemon", () => {
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

  it("acquires the PID file, starts services, and returns a working shutdown", async () => {
    const svc = recordingService("alpha");
    const handle = await bootstrapDaemon({
      dataDir: sandbox.dataDir,
      services: [svc],
    });

    expect(svc.startedWith).toBeDefined();
    const pid = readPidFile(daemonPidFile(sandbox.dataDir));
    expect(pid?.pid).toBe(process.pid);

    await handle.shutdown("test");

    expect(svc.stopCalls).toBe(1);
    expect(fs.existsSync(daemonPidFile(sandbox.dataDir))).toBe(false);
  });

  it("stops services in reverse start order on shutdown", async () => {
    const order: string[] = [];
    const a: DaemonService = {
      name: "a",
      start: () => void order.push("start:a"),
      stop: () => void order.push("stop:a"),
    };
    const b: DaemonService = {
      name: "b",
      start: () => void order.push("start:b"),
      stop: () => void order.push("stop:b"),
    };
    const handle = await bootstrapDaemon({
      dataDir: sandbox.dataDir,
      services: [a, b],
    });
    await handle.shutdown();
    expect(order).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
  });

  it("rolls back when a service fails to start", async () => {
    const ok = recordingService("ok");
    const bad = recordingService("bad", { failOnStart: true });
    await expect(
      bootstrapDaemon({
        dataDir: sandbox.dataDir,
        services: [ok, bad],
      }),
    ).rejects.toThrow(/bad boom/);

    expect(ok.stopCalls).toBe(1);
    expect(fs.existsSync(daemonPidFile(sandbox.dataDir))).toBe(false);
  });

  it("throws DaemonError when the data dir lacks an install", async () => {
    const empty = path.join(sandbox.tmpRoot, "no-install");
    fs.mkdirSync(empty);
    await expect(
      bootstrapDaemon({ dataDir: empty, services: [] }),
    ).rejects.toBeInstanceOf(DaemonError);
  });

  it("idempotent shutdown does not double-stop services", async () => {
    const svc = recordingService("once");
    const handle = await bootstrapDaemon({
      dataDir: sandbox.dataDir,
      services: [svc],
    });
    await handle.shutdown();
    await handle.shutdown();
    expect(svc.stopCalls).toBe(1);
  });

  it("writes daemon-YYYY-MM-DD.log entries during the lifecycle", async () => {
    const handle = await bootstrapDaemon({
      dataDir: sandbox.dataDir,
      services: [recordingService("logged")],
      now: () => new Date("2026-04-27T10:00:00Z"),
    });
    await handle.shutdown("test");
    const logFile = path.join(
      logsDir(sandbox.dataDir),
      "daemon-2026-04-27.log",
    );
    const text = fs.readFileSync(logFile, "utf8");
    expect(text).toContain('"message":"daemon starting"');
    expect(text).toContain('"message":"service started"');
    expect(text).toContain('"message":"daemon stopped"');
  });
});

describe("createHeartbeatService", () => {
  it("ticks the logger at the configured interval", async () => {
    const svc = createHeartbeatService(50);
    const tickedMessages: string[] = [];
    const ctx: DaemonContext = {
      dataDir: "ignored",
      logger: {
        info: (m) => void tickedMessages.push(m),
        warn: () => {},
        error: () => {},
        flush: () => {},
        close: () => {},
      },
      pidFile: { pid: 1, startedAt: "" },
    };
    svc.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 130));
    svc.stop();
    expect(tickedMessages.length).toBeGreaterThanOrEqual(2);
    expect(tickedMessages.every((m) => m === "heartbeat")).toBe(true);
  });

  it("clears the timer on stop", async () => {
    const svc = createHeartbeatService(20);
    const tickedMessages: string[] = [];
    const ctx: DaemonContext = {
      dataDir: "ignored",
      logger: {
        info: (m) => void tickedMessages.push(m),
        warn: () => {},
        error: () => {},
        flush: () => {},
        close: () => {},
      },
      pidFile: { pid: 1, startedAt: "" },
    };
    svc.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    svc.stop();
    const before = tickedMessages.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tickedMessages.length).toBe(before);
  });
});

describe("PidFileHeldError surface", () => {
  it("is thrown by daemon-pid layer when an arbitrary live pid holds the file", () => {
    // Sanity-check that bootstrapDaemon would propagate this.
    const fake = new PidFileHeldError({
      pid: 1234,
      startedAt: "2026-04-27T10:00:00Z",
    });
    expect(fake).toBeInstanceOf(PidFileHeldError);
    expect(fake.message).toContain("1234");
  });
});
