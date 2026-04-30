import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { brainDir, brainFile } from "../paths.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { runScan } from "./scan.ts";
import type {
  Signal,
  SignalCollector,
} from "../../tools/scanners/types.ts";

function seedBrainWithRepo(
  sandbox: InstallSandbox,
  app: string,
  rootPath: string,
  monorepoPath?: string,
): void {
  fs.mkdirSync(brainDir(sandbox.dataDir, "personal", app), { recursive: true });
  saveBrain(brainFile(sandbox.dataDir, "personal", app), {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    repo: {
      rootPath,
      ...(monorepoPath !== undefined && { monorepoPath }),
    },
  });
}

function fakeCollector(signals: Signal[]): SignalCollector & {
  calls: Array<{ cwd: string }>;
} {
  const calls: Array<{ cwd: string }> = [];
  return {
    kind: "fake",
    description: "fake collector for tests",
    calls,
    async collect(ctx) {
      calls.push({ cwd: ctx.cwd });
      return signals;
    },
  };
}

describe("runScan", () => {
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

  it("returns 1 when --app is missing", async () => {
    const code = await runScan([]);
    expect(code).toBe(1);
  });

  it("returns 1 when the brain doesn't exist", async () => {
    const code = await runScan(["--app", "nonexistent"]);
    expect(code).toBe(1);
  });

  it("returns 1 when the brain exists but has no repo configured", async () => {
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", "demo"), {
      recursive: true,
    });
    saveBrain(brainFile(sandbox.dataDir, "personal", "demo"), {
      schemaVersion: 1,
      projectName: "demo",
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
    });
    const code = await runScan(["--app", "demo"]);
    expect(code).toBe(1);
  });

  it("runs the collectors with the resolved cwd from brain.repo", async () => {
    seedBrainWithRepo(sandbox, "demo", "/Users/me/projects/demo");
    const c = fakeCollector([]);
    await runScan(["--app", "demo"], { collectors: [c] });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.cwd).toBe("/Users/me/projects/demo");
  });

  it("joins monorepoPath into the cwd when set", async () => {
    seedBrainWithRepo(
      sandbox,
      "demo",
      "/Users/me/projects/applications",
      "apps/demo-nextjs",
    );
    const c = fakeCollector([]);
    await runScan(["--app", "demo"], { collectors: [c] });
    expect(c.calls[0]?.cwd).toBe(
      path.join("/Users/me/projects/applications", "apps/demo-nextjs"),
    );
  });

  it("returns 0 when only low/medium signals were emitted", async () => {
    seedBrainWithRepo(sandbox, "demo", "/repo");
    const c = fakeCollector([
      { kind: "fake", severity: "low", summary: "info" },
      { kind: "fake", severity: "medium", summary: "fyi" },
    ]);
    expect(await runScan(["--app", "demo"], { collectors: [c] })).toBe(0);
  });

  it("returns 1 when at least one high or critical signal is emitted", async () => {
    seedBrainWithRepo(sandbox, "demo", "/repo");
    const c = fakeCollector([
      { kind: "fake", severity: "low", summary: "info" },
      { kind: "fake", severity: "high", summary: "real issue" },
    ]);
    expect(await runScan(["--app", "demo"], { collectors: [c] })).toBe(1);
  });

  it("prints a per-collector summary line and the signal headlines", async () => {
    seedBrainWithRepo(sandbox, "demo", "/repo");
    const c = fakeCollector([
      { kind: "fake", severity: "high", summary: "lodash advisory" },
    ]);
    await runScan(["--app", "demo"], { collectors: [c] });
    const out = logs.join("\n");
    expect(out).toContain("fake");
    expect(out).toContain("1 signal(s)");
    expect(out).toContain("[HIGH] lodash advisory");
  });
});
