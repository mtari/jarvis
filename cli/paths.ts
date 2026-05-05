import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export function repoRoot(): string {
  return REPO_ROOT;
}

export function defaultDataDir(): string {
  return path.resolve(REPO_ROOT, "..", "jarvis-data");
}

export function getDataDir(): string {
  return process.env["JARVIS_DATA_DIR"] ?? defaultDataDir();
}

export function dbFile(dataDir: string): string {
  return path.join(dataDir, "jarvis.db");
}

export function envFile(dataDir: string): string {
  return path.join(dataDir, ".env");
}

export function profileFile(dataDir: string): string {
  return path.join(dataDir, "user-profile.json");
}

export function setupQueueFile(dataDir: string): string {
  return path.join(dataDir, "setup-queue.jsonl");
}

export function ideasDir(dataDir: string): string {
  return path.join(dataDir, "ideas");
}

export function businessIdeasFile(dataDir: string): string {
  return path.join(dataDir, "Business_Ideas.md");
}

export function logsDir(dataDir: string): string {
  return path.join(dataDir, "logs");
}

export function triageDir(dataDir: string): string {
  return path.join(dataDir, "triage");
}

export function checkpointsDir(dataDir: string): string {
  return path.join(dataDir, "logs", "checkpoints");
}

export function sandboxDir(dataDir: string): string {
  return path.join(dataDir, "sandbox");
}

export function daemonPidFile(dataDir: string): string {
  return path.join(dataDir, ".daemon.pid");
}

export function vaultDir(dataDir: string, vaultName: string): string {
  return path.join(dataDir, "vaults", vaultName);
}

export function brainDir(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(vaultDir(dataDir, vaultName), "brains", app);
}

export function brainFile(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(brainDir(dataDir, vaultName, app), "brain.json");
}

export function notesFile(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(brainDir(dataDir, vaultName, app), "notes.md");
}

export function brainLockFile(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(brainDir(dataDir, vaultName, app), ".lock");
}

export function brainDocsFile(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(brainDir(dataDir, vaultName, app), "docs", "docs.json");
}

export function planDir(
  dataDir: string,
  vaultName: string,
  app: string,
): string {
  return path.join(vaultDir(dataDir, vaultName), "plans", app);
}

export function migrationsDbDir(): string {
  return path.join(REPO_ROOT, "migrations", "db");
}

export function planTemplatesDir(): string {
  return path.join(REPO_ROOT, "plan-templates");
}
