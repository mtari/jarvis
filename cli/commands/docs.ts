import fs from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { absorbDoc, DocAbsorbError } from "../../agents/strategist-doc-absorb.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { brainExists } from "../../orchestrator/brain.ts";
import {
  cacheRelativePath,
  defaultFetchUrl,
  docIdFromSource,
  DocsError,
  isUrl,
  loadDocSource,
  loadDocsIndex,
  removeCachedDocDir,
  saveDocsIndex,
  uniqueDocId,
  writeCachedDocContent,
  type DocEntry,
  type FetchUrl,
} from "../../orchestrator/docs.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { brainFile, dbFile, envFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis docs <subcommand>`
 *   list   — list registered docs for an app
 *   add    — register a new doc (Phase 2.5 v1: cache mode only via --keep)
 *   remove — unregister a doc (drops cache; absorbed extracts stay in brain)
 *
 * Absorb mode (`docs add` without `--keep`, `docs absorb`, `docs reabsorb`)
 * lands in a follow-up — it drafts a brain-update plan and reuses the
 * Strategist redraft flow. Same for `docs refresh`. The current slice covers
 * cache-mode-only adds, plus list + remove.
 */

export interface DocsCommandDeps {
  /** Test seam — overrides URL fetcher. */
  fetchUrl?: FetchUrl;
  now?: Date;
  /** Test seam — overrides the LLM client used for absorb mode. */
  buildClient?: () => AnthropicClient;
}

export async function runDocs(
  rawArgs: string[],
  deps: DocsCommandDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "list":
      return runDocsList(rest);
    case "add":
      return runDocsAdd(rest, deps);
    case "remove":
      return runDocsRemove(rest, deps);
    case undefined:
      console.error(
        "docs: missing subcommand. Usage: yarn jarvis docs <list|add|remove> [...]",
      );
      return 1;
    default:
      console.error(
        `docs: unknown subcommand "${subcommand}". Available: list, add, remove.`,
      );
      return 1;
  }
}

// ---------------------------------------------------------------------------
// docs list
// ---------------------------------------------------------------------------

async function runDocsList(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`docs list: ${(err as Error).message}`);
    return 1;
  }
  const app = parsed.values.app;
  const vault = parsed.values.vault ?? "personal";
  const format = parsed.values.format ?? "table";
  if (!app) {
    console.error(
      "docs list: --app is required. Usage: yarn jarvis docs list --app <name>",
    );
    return 1;
  }
  if (format !== "table" && format !== "json") {
    console.error(
      `docs list: invalid --format "${format}" (expected table | json).`,
    );
    return 1;
  }
  const dataDir = getDataDir();
  if (!brainExists(brainFile(dataDir, vault, app))) {
    console.error(
      `docs list: app "${app}" in vault "${vault}" not onboarded. Run \`yarn jarvis onboard --app ${app}\` first.`,
    );
    return 1;
  }

  const entries = loadDocsIndex(dataDir, vault, app);
  if (format === "json") {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (entries.length === 0) {
    console.log(`No docs registered for ${app}.`);
    console.log(
      `  Add one: yarn jarvis docs add --app ${app} --keep <path-or-url>`,
    );
    return 0;
  }
  console.log(`Docs for ${app} (${entries.length}):`);
  for (const e of entries) {
    const sizeNote = e.cachedFile ? "  (cached)" : "";
    console.log(`  ${e.id}  [${e.retention} ${e.kind}]${sizeNote}`);
    console.log(`    source: ${e.source}`);
    console.log(`    added:  ${e.addedAt}`);
    if (e.summary && e.summary.length > 0) {
      console.log(`    note:   ${e.summary}`);
    }
    if (e.tags.length > 0) {
      console.log(`    tags:   ${e.tags.join(", ")}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// docs add (cache mode v1)
// ---------------------------------------------------------------------------

async function runDocsAdd(
  rest: string[],
  deps: DocsCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
        keep: { type: "boolean" },
        title: { type: "string" },
        tags: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`docs add: ${(err as Error).message}`);
    return 1;
  }
  const app = parsed.values.app;
  const vault = parsed.values.vault ?? "personal";
  const keep = parsed.values.keep === true;
  const sources = parsed.positionals;

  if (!app) {
    console.error(
      "docs add: --app is required. Usage: yarn jarvis docs add --app <name> --keep <path-or-url>",
    );
    return 1;
  }
  if (sources.length === 0) {
    console.error(
      "docs add: source path or URL required. Usage: yarn jarvis docs add --app <name> --keep <path-or-url>",
    );
    return 1;
  }
  if (sources.length > 1) {
    console.error(
      `docs add: only one source per call (got ${sources.length}). Run docs add separately for each.`,
    );
    return 1;
  }
  const dataDir = getDataDir();
  if (!brainExists(brainFile(dataDir, vault, app))) {
    console.error(
      `docs add: app "${app}" in vault "${vault}" not onboarded. Run \`yarn jarvis onboard --app ${app}\` first.`,
    );
    return 1;
  }

  const source = sources[0]!;
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;

  let loaded;
  try {
    loaded = await loadDocSource(source, fetchUrl);
  } catch (err) {
    if (err instanceof DocsError) {
      console.error(`docs add: ${err.message}`);
      return 1;
    }
    console.error(
      `docs add: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const existing = loadDocsIndex(dataDir, vault, app);
  // Refuse to clobber an existing entry with the same source — keep the
  // user's mental model intact ("add the same doc twice = no-op").
  const sameSource = existing.find((e) => e.source === source);
  if (sameSource) {
    console.error(
      `docs add: source "${source}" is already registered as id "${sameSource.id}". Run \`docs remove\` first to replace it.`,
    );
    return 1;
  }

  if (!keep) {
    return absorbDocViaStrategist({
      app,
      vault,
      dataDir,
      source,
      docContent: loaded.content,
      ...(parsed.values.title !== undefined && { contextTag: parsed.values.title }),
      ...(deps.buildClient !== undefined && { buildClient: deps.buildClient }),
    });
  }

  const wantedId = docIdFromSource(source);
  const id = uniqueDocId(
    wantedId,
    existing.map((e) => e.id),
  );

  // Write content first so a partial failure leaves the index untouched.
  try {
    writeCachedDocContent(dataDir, vault, app, id, loaded.content);
  } catch (err) {
    console.error(
      `docs add: failed to write cache file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const addedAt = (deps.now ?? new Date()).toISOString();
  const title = parsed.values.title ?? id;
  const tags = parseTags(parsed.values.tags);

  const newEntry: DocEntry = {
    id,
    kind: isUrl(source) ? "url" : "file",
    retention: "cached",
    source,
    title,
    tags,
    addedAt,
    summary: "",
    cachedFile: cacheRelativePath(id),
    ...(isUrl(source) ? { refreshedAt: addedAt } : {}),
  };

  const next = [...existing, newEntry];
  try {
    saveDocsIndex(dataDir, vault, app, next);
  } catch (err) {
    // Best-effort cleanup of the cache directory if the index write fails.
    removeCachedDocDir(dataDir, vault, app, id);
    console.error(
      `docs add: failed to write docs.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  recordEvent(dataDir, app, vault, "doc-added", {
    docId: id,
    source,
    retention: "cached",
    kind: newEntry.kind,
  });

  console.log(`✓ Cached doc ${id}`);
  console.log(`  Source: ${source}`);
  console.log(`  Bytes:  ${loaded.content.length}`);
  console.log(
    `  List:   yarn jarvis docs list --app ${app}${vault !== "personal" ? ` --vault ${vault}` : ""}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// docs remove
// ---------------------------------------------------------------------------

async function runDocsRemove(
  rest: string[],
  deps: DocsCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`docs remove: ${(err as Error).message}`);
    return 1;
  }
  const app = parsed.values.app;
  const vault = parsed.values.vault ?? "personal";
  const id = parsed.positionals[0];
  if (!app) {
    console.error(
      "docs remove: --app is required. Usage: yarn jarvis docs remove --app <name> <id>",
    );
    return 1;
  }
  if (!id) {
    console.error(
      "docs remove: <id> required. Usage: yarn jarvis docs remove --app <name> <id>",
    );
    return 1;
  }

  const dataDir = getDataDir();
  if (!brainExists(brainFile(dataDir, vault, app))) {
    console.error(
      `docs remove: app "${app}" in vault "${vault}" not onboarded.`,
    );
    return 1;
  }

  const existing = loadDocsIndex(dataDir, vault, app);
  const target = existing.find((e) => e.id === id);
  if (!target) {
    console.error(
      `docs remove: no doc with id "${id}" registered for ${app}. List with \`docs list\`.`,
    );
    return 1;
  }
  const next = existing.filter((e) => e.id !== id);
  try {
    saveDocsIndex(dataDir, vault, app, next);
  } catch (err) {
    console.error(
      `docs remove: failed to write docs.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  removeCachedDocDir(dataDir, vault, app, id);

  recordEvent(dataDir, app, vault, "doc-removed", {
    docId: id,
    retention: target.retention,
  });

  console.log(`✓ Removed doc ${id}`);
  if (target.retention === "absorbed") {
    console.log(
      "  (Note: anything already extracted into the brain stays — only the registry entry was removed.)",
    );
  }
  // unused — silences linter for `deps` when remove doesn't need it.
  void deps;
  return 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseTags(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function recordEvent(
  dataDir: string,
  app: string,
  vault: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const file = dbFile(dataDir);
  if (!fs.existsSync(file)) return;
  const db = new Database(file);
  try {
    appendEvent(db, { appId: app, vaultId: vault, kind, payload });
  } finally {
    db.close();
  }
}

interface AbsorbDocCliInput {
  app: string;
  vault: string;
  dataDir: string;
  source: string;
  docContent: string;
  contextTag?: string;
  buildClient?: () => AnthropicClient;
}

async function absorbDocViaStrategist(
  input: AbsorbDocCliInput,
): Promise<number> {
  loadEnvFile(envFile(input.dataDir));
  const baseClient: AnthropicClient = input.buildClient
    ? input.buildClient()
    : createSdkClient();
  const recorder = buildAgentCallRecorder(baseClient, dbFile(input.dataDir), {
    app: input.app,
    vault: input.vault,
    agent: "strategist",
    mode: "subscription",
  });
  try {
    const result = await absorbDoc({
      client: recorder.client,
      app: input.app,
      vault: input.vault,
      dataDir: input.dataDir,
      source: input.source,
      docContent: input.docContent,
      ...(input.contextTag !== undefined && { contextTag: input.contextTag }),
    });
    recorder.flush();
    console.log(`✓ Absorb plan drafted for ${input.app}`);
    console.log(`  Plan: ${result.planId}`);
    console.log(`  Path: ${result.planPath}`);
    console.log(`  Doc:  ${result.docId} (registered, retention=absorbed)`);
    console.log("");
    console.log(
      "  Review with: yarn jarvis plans --pending-review --app " + input.app,
    );
    console.log(
      "  After approval, apply the proposed brain changes by hand (auto-apply lands in a follow-up).",
    );
    return 0;
  } catch (err) {
    recorder.flush();
    if (err instanceof DocAbsorbError) {
      console.error(`docs add (absorb): ${err.message}`);
      return 1;
    }
    console.error(
      `docs add (absorb): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
