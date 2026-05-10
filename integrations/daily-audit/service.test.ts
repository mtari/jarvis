import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonLogger } from "../../orchestrator/daemon-logger.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import type { DaemonContext } from "../../cli/commands/daemon.ts";
import { createDailyAuditService } from "./service.ts";

function buildCtx(sandbox: InstallSandbox): DaemonContext {
  const logger = createDaemonLogger({
    logsDir: `${sandbox.dataDir}/logs`,
    echo: false,
  });
  return {
    dataDir: sandbox.dataDir,
    logger,
    pidFile: { pid: process.pid, startedAt: new Date().toISOString() },
  };
}

describe("createDailyAuditService", () => {
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

  it("invokes the tick body once on start and routes through _tickBody", async () => {
    const ctx = buildCtx(sandbox);
    try {
      const tickBody = vi.fn(async () => {});
      const svc = createDailyAuditService({
        dataDir: sandbox.dataDir,
        tickMs: 60_000_000,
        _tickBody: tickBody,
      });
      svc.start(ctx);
      // Initial fire is async; let microtasks drain.
      await new Promise((r) => setImmediate(r));
      expect(tickBody).toHaveBeenCalledTimes(1);
      svc.stop();
    } finally {
      ctx.logger.close();
    }
  });

  it("guards re-entry via tickInFlight", async () => {
    const ctx = buildCtx(sandbox);
    try {
      let resolveBody: (() => void) | undefined;
      const tickBody = vi.fn(
        (): Promise<void> =>
          new Promise<void>((resolve) => {
            resolveBody = resolve;
          }),
      );
      const svc = createDailyAuditService({
        dataDir: sandbox.dataDir,
        tickMs: 1,
        _tickBody: tickBody,
      });
      svc.start(ctx);
      // Wait long enough that several setInterval ticks would have fired
      // if not for the in-flight guard.
      await new Promise((r) => setTimeout(r, 25));
      expect(tickBody).toHaveBeenCalledTimes(1);
      resolveBody?.();
      svc.stop();
    } finally {
      ctx.logger.close();
    }
  });

  it("isolates errors from the tick body", async () => {
    const ctx = buildCtx(sandbox);
    try {
      const tickBody = vi.fn(async () => {
        throw new Error("boom");
      });
      const svc = createDailyAuditService({
        dataDir: sandbox.dataDir,
        tickMs: 60_000_000,
        _tickBody: tickBody,
      });
      // Should not throw — error is logged and swallowed.
      svc.start(ctx);
      await new Promise((r) => setImmediate(r));
      expect(tickBody).toHaveBeenCalledTimes(1);
      svc.stop();
    } finally {
      ctx.logger.close();
    }
  });
});
