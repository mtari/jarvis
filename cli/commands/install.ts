import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { runMigrations } from "../../migrations/runner.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { saveProfile } from "../../orchestrator/profile.ts";
import {
  brainDir,
  brainDocsFile,
  brainFile,
  checkpointsDir,
  dbFile,
  envFile,
  getDataDir,
  ideasDir,
  logsDir,
  migrationsDbDir,
  planDir,
  profileFile,
  sandboxDir,
  setupQueueFile,
  vaultDir,
} from "../paths.ts";

const ENV_TEMPLATE = `# Jarvis runs every agent under your Claude Code subscription via the
# @anthropic-ai/claude-agent-sdk — see MASTER_PLAN.md §18. The SDK spawns
# the local 'claude' CLI subprocess which inherits auth from ~/.claude/,
# so no Anthropic API key is needed here.

# Slack tokens — Phase 1+. Uncomment when wiring the Slack adapter.
# SLACK_BOT_TOKEN=
# SLACK_APP_TOKEN=

# Umami credentials — Phase 1+ when self-hosted analytics is wired in.
# UMAMI_API_URL=
# UMAMI_API_TOKEN=
`;

interface EventRow {
  id: number;
  app_id: string;
  vault_id: string;
  kind: string;
  payload: string;
  created_at: string;
}

export interface InstallOptions {
  /**
   * Override the Claude CLI precheck for tests. When set, replaces the
   * default `claude --version` invocation; return true to proceed, false
   * to abort with the install error.
   */
  checkClaudeCli?: () => boolean;
}

export async function runInstall(
  rawArgs: string[],
  opts: InstallOptions = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        "data-dir": { type: "string" },
        remote: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`install: ${(err as Error).message}`);
    return 1;
  }

  const dataDir = parsed.values["data-dir"] ?? getDataDir();
  const remote = parsed.values.remote;

  // Per §18, every agent runs through the Claude Agent SDK driving the
  // local `claude` CLI. If it isn't installed or authenticated, all
  // agent fires would fail at runtime — fail fast at install time.
  const claudeOk = opts.checkClaudeCli ? opts.checkClaudeCli() : checkClaudeCli();
  if (!claudeOk) {
    console.error(
      "install: `claude` CLI not found on PATH or fails to run.\n" +
        "  Jarvis runs every agent under your Claude Code subscription via the SDK\n" +
        "  (see MASTER_PLAN.md §18). Install Claude Code from https://claude.com/claude-code,\n" +
        "  authenticate it once, then re-run `yarn jarvis install`.",
    );
    return 1;
  }

  if (fs.existsSync(dataDir)) {
    const entries = fs.readdirSync(dataDir);
    if (entries.length > 0) {
      console.error(
        `install: data directory ${dataDir} already exists and is not empty. Refusing to overwrite. Remove it first or pick a different --data-dir.`,
      );
      return 1;
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(envFile(dataDir), ENV_TEMPLATE, { mode: 0o600 });

  fs.mkdirSync(logsDir(dataDir), { recursive: true });
  fs.mkdirSync(checkpointsDir(dataDir), { recursive: true });
  fs.mkdirSync(sandboxDir(dataDir), { recursive: true });
  fs.mkdirSync(ideasDir(dataDir), { recursive: true });
  fs.writeFileSync(setupQueueFile(dataDir), "");

  saveProfile(profileFile(dataDir), { schemaVersion: 1 });

  const db = new Database(dbFile(dataDir));
  try {
    await runMigrations(db, migrationsDbDir());

    const personalVault = vaultDir(dataDir, "personal");
    fs.mkdirSync(personalVault, { recursive: true });
    fs.mkdirSync(path.join(personalVault, "brains"), { recursive: true });
    fs.mkdirSync(path.join(personalVault, "plans"), { recursive: true });

    execFileSync(
      "git",
      ["init", "--quiet", "--initial-branch=main", personalVault],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (remote) {
      execFileSync(
        "git",
        ["-C", personalVault, "remote", "add", "origin", remote],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    }

    db.prepare(
      "INSERT INTO vault_state (vault_id, remote, ahead, behind, updated_at) VALUES (?, ?, 0, 0, ?)",
    ).run("personal", remote ?? null, new Date().toISOString());

    const jBrainDir = brainDir(dataDir, "personal", "jarvis");
    fs.mkdirSync(jBrainDir, { recursive: true });
    fs.mkdirSync(path.join(jBrainDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(jBrainDir, "research"), { recursive: true });
    fs.writeFileSync(brainDocsFile(dataDir, "personal", "jarvis"), "[]\n");

    saveBrain(brainFile(dataDir, "personal", "jarvis"), {
      schemaVersion: 1,
      projectName: "jarvis",
      projectType: "other",
      projectStatus: "active",
      projectPriority: 3,
    });

    fs.mkdirSync(planDir(dataDir, "personal", "jarvis"), { recursive: true });

    await runRestoreSmokeTest(db, dataDir);
  } finally {
    db.close();
  }

  printNextSteps(dataDir, remote);
  return 0;
}

async function runRestoreSmokeTest(
  liveDb: Database.Database,
  dataDir: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  const inserted = liveDb
    .prepare(
      "INSERT INTO events (app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get("jarvis", "personal", "install-marker", JSON.stringify({ seed: true }), stamp) as { id: number };
  const seedId = inserted.id;

  const tempJsonl = path.join(dataDir, ".smoke-test.jsonl");
  const events = liveDb
    .prepare("SELECT * FROM events ORDER BY id")
    .all() as EventRow[];
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(tempJsonl, lines);

  const scratchPath = path.join(dataDir, ".smoke-test.db");
  fs.rmSync(scratchPath, { force: true });
  const scratchDb = new Database(scratchPath);
  try {
    await runMigrations(scratchDb, migrationsDbDir());
    const importStmt = scratchDb.prepare(
      "INSERT INTO events (id, app_id, vault_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const line of lines.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as EventRow;
      importStmt.run(
        row.id,
        row.app_id,
        row.vault_id,
        row.kind,
        row.payload,
        row.created_at,
      );
    }

    const liveCount = (
      liveDb.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
    ).c;
    const scratchCount = (
      scratchDb
        .prepare("SELECT COUNT(*) as c FROM events")
        .get() as { c: number }
    ).c;
    if (liveCount !== scratchCount) {
      throw new Error(
        `restore smoke-test: row counts diverged (live=${liveCount}, restored=${scratchCount})`,
      );
    }

    const livePayload = (
      liveDb
        .prepare("SELECT payload FROM events WHERE id = ?")
        .get(seedId) as { payload: string }
    ).payload;
    const scratchPayload = (
      scratchDb
        .prepare("SELECT payload FROM events WHERE id = ?")
        .get(seedId) as { payload: string }
    ).payload;
    if (livePayload !== scratchPayload) {
      throw new Error("restore smoke-test: seed-event payload mismatch");
    }
  } finally {
    scratchDb.close();
    fs.rmSync(scratchPath, { force: true });
    fs.rmSync(tempJsonl, { force: true });
  }

  liveDb.prepare("DELETE FROM events WHERE id = ?").run(seedId);
}

function printNextSteps(dataDir: string, remote: string | undefined): void {
  const remoteLine = remote
    ? `→ Vault remote configured: ${remote}`
    : "→ Add a remote:    yarn jarvis vault add-remote personal <git-url>";
  const remoteSuffix = remote ? "" : " (no remote)";
  console.log(
    [
      "",
      `✓ Installed. Default vault \`personal\` created${remoteSuffix}.`,
      `✓ Claude Code CLI detected — agents will run under your subscription.`,
      `→ Fill in profile: yarn jarvis profile edit`,
      remoteLine,
      `→ Add more vaults: yarn jarvis vault create <name> [--remote <url>]`,
      `→ First plan:      yarn jarvis plan --app jarvis "<your first self-improvement>"`,
      "",
    ].join("\n"),
  );
}

/**
 * Returns true when the local `claude` CLI exists on PATH and `--version`
 * exits 0. Used as the install-time precheck per §18 — Jarvis cannot run
 * agents without a working Claude Code subprocess.
 */
function checkClaudeCli(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}
