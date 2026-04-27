import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainLockFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runDoctor } from "./doctor.ts";

describe("runDoctor", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logs: string[];

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logs = [];
    console.log = (msg?: unknown): void => {
      logs.push(typeof msg === "string" ? msg : String(msg));
    };
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("returns 0 on a clean install with no issues", async () => {
    const code = await runDoctor([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Daemon: not running");
    expect(out).toContain("yarn jarvis daemon");
    expect(out).toContain("No stale brain locks");
    expect(out).toContain("No plans awaiting review");
    expect(out).toContain("personal: (no remote)");
  });

  it("counts plans awaiting review", async () => {
    dropPlan(sandbox, "2026-04-27-test", { status: "awaiting-review" });
    await runDoctor([]);
    const out = logs.join("\n");
    expect(out).toContain("1 plan(s) awaiting your review");
  });

  it("flags a stale brain lock and exits 1", async () => {
    const lockPath = brainLockFile(sandbox.dataDir, "personal", "jarvis");
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        heldSince: longAgo,
        heartbeat: longAgo,
      }),
    );
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("Stale brain locks");
  });

  it("flags an unparseable plan file", async () => {
    const planPath = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "plans",
      "jarvis",
      "broken.md",
    );
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "not a plan");
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("unparseable plan file");
  });
});
