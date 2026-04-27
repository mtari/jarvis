import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBrain } from "../../orchestrator/brain.ts";
import { loadProfile } from "../../orchestrator/profile.ts";
import {
  brainDocsFile,
  brainFile,
  dbFile,
  envFile,
  planDir,
  profileFile,
  setupQueueFile,
  vaultDir,
} from "../paths.ts";
import { runInstall } from "./install.ts";

const silenceLogs = (): void => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
};

describe("runInstall", () => {
  let dataDir: string;

  beforeEach(() => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-install-"));
    dataDir = path.join(tmpRoot, "jarvis-data");
    silenceLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  });

  it("creates the full data layout and returns 0", async () => {
    const code = await runInstall(["--data-dir", dataDir]);
    expect(code).toBe(0);

    expect(fs.existsSync(envFile(dataDir))).toBe(true);
    const envContent = fs.readFileSync(envFile(dataDir), "utf8");
    expect(envContent).toContain("ANTHROPIC_API_KEY=");
    expect(envContent).toContain("# SLACK_BOT_TOKEN=");

    expect(fs.existsSync(dbFile(dataDir))).toBe(true);
    expect(fs.existsSync(setupQueueFile(dataDir))).toBe(true);
    expect(fs.existsSync(profileFile(dataDir))).toBe(true);

    const personalVault = vaultDir(dataDir, "personal");
    expect(fs.existsSync(path.join(personalVault, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(personalVault, "brains"))).toBe(true);
    expect(fs.existsSync(path.join(personalVault, "plans"))).toBe(true);

    const brainPath = brainFile(dataDir, "personal", "jarvis");
    expect(fs.existsSync(brainPath)).toBe(true);
    const brain = loadBrain(brainPath);
    expect(brain.projectName).toBe("jarvis");
    expect(brain.projectType).toBe("other");
    expect(brain.projectStatus).toBe("active");

    const docsJson = brainDocsFile(dataDir, "personal", "jarvis");
    expect(fs.readFileSync(docsJson, "utf8")).toBe("[]\n");

    expect(fs.existsSync(planDir(dataDir, "personal", "jarvis"))).toBe(true);

    const profile = loadProfile(profileFile(dataDir));
    expect(profile.schemaVersion).toBe(1);
    expect(profile.identity.name).toBe("");

    const db = new Database(dbFile(dataDir));
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "_migrations",
          "agent_state",
          "events",
          "feedback",
          "scheduled_posts",
          "suppressions",
          "vault_state",
        ]),
      );

      const vaultRow = db
        .prepare("SELECT * FROM vault_state WHERE vault_id = ?")
        .get("personal") as
        | { vault_id: string; remote: string | null; ahead: number; behind: number }
        | undefined;
      expect(vaultRow?.vault_id).toBe("personal");
      expect(vaultRow?.remote).toBeNull();

      const eventCount = (
        db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
      ).c;
      expect(eventCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("records the remote when --remote is provided", async () => {
    const remote = "git@github.com:example/personal-vault.git";
    const code = await runInstall(["--data-dir", dataDir, "--remote", remote]);
    expect(code).toBe(0);

    const personalVault = vaultDir(dataDir, "personal");
    const remoteOut = execFileSync(
      "git",
      ["-C", personalVault, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();
    expect(remoteOut).toBe(remote);

    const db = new Database(dbFile(dataDir));
    try {
      const row = db
        .prepare("SELECT remote FROM vault_state WHERE vault_id = ?")
        .get("personal") as { remote: string };
      expect(row.remote).toBe(remote);
    } finally {
      db.close();
    }
  });

  it("refuses to overwrite a non-empty data directory", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "leftover.txt"), "hi");

    const code = await runInstall(["--data-dir", dataDir]);
    expect(code).toBe(1);
  });

  it("rejects an unknown flag", async () => {
    const code = await runInstall(["--data-dir", dataDir, "--bogus", "x"]);
    expect(code).toBe(1);
  });

  it("leaves no .smoke-test.* artifacts behind after the smoke test", async () => {
    await runInstall(["--data-dir", dataDir]);
    const dataDirEntries = fs.readdirSync(dataDir);
    expect(dataDirEntries.some((e) => e.startsWith(".smoke-test"))).toBe(false);
  });
});
