import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  OnboardError,
  runOnboardAgent,
  type AbsorbedDoc,
  type CachedDocSummary,
} from "../../agents/onboard.ts";
import type { RunAgentTransport } from "../../orchestrator/agent-sdk-runtime.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  brainDir,
  brainDocsFile,
  brainFile,
  dbFile,
  envFile,
  getDataDir,
  planDir,
  vaultDir,
} from "../paths.ts";

export interface OnboardCommandDeps {
  /** Test injection — overrides the SDK transport. */
  transport?: RunAgentTransport;
  /** For tests: skip the network and return a stub for any URL doc fetch. */
  fetchUrl?: (url: string) => Promise<{ content: string; contentType?: string }>;
}

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const MAX_DOC_BYTES = 256 * 1024;

interface DocsArgs {
  absorb: string[];
  keep: string[];
}

export async function runOnboard(
  rawArgs: string[],
  deps: OnboardCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        repo: { type: "string" },
        "monorepo-path": { type: "string" },
        vault: { type: "string" },
        docs: { type: "string", multiple: true },
        "docs-keep": { type: "string", multiple: true },
        "move-docs": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`onboard: ${(err as Error).message}`);
    return 1;
  }

  const v = parsed.values;
  const app = v.app;
  if (!app) {
    console.error(
      'onboard: --app is required. Usage: yarn jarvis onboard --app <name> --repo <path-or-url>',
    );
    return 1;
  }
  if (!APP_NAME_PATTERN.test(app)) {
    console.error(
      `onboard: --app "${app}" must be lowercase, dash-separated, alphanumeric (e.g., erdei-fahazak).`,
    );
    return 1;
  }
  const repoArg = v.repo;
  if (!repoArg) {
    console.error("onboard: --repo is required (local absolute path).");
    return 1;
  }

  const vault = v.vault ?? "personal";
  const dataDir = getDataDir();

  const vaultPath = vaultDir(dataDir, vault);
  if (!fs.existsSync(vaultPath)) {
    console.error(
      `onboard: vault "${vault}" not found at ${vaultPath}. ` +
        "Phase 1 supports the default `personal` vault only; multi-vault create lands later.",
    );
    return 1;
  }

  // Refuse to clobber an existing brain
  const targetBrain = brainFile(dataDir, vault, app);
  if (fs.existsSync(targetBrain)) {
    console.error(
      `onboard: app "${app}" already has a brain at ${targetBrain}. ` +
        "Refusing to overwrite. Pick a different --app or remove the existing brain manually.",
    );
    return 1;
  }

  // Resolve repo root (Phase 1: local absolute paths only).
  const repoRoot = resolveRepoRoot(repoArg, v["monorepo-path"]);
  if (!repoRoot.ok) {
    console.error(`onboard: ${repoRoot.message}`);
    return 1;
  }

  loadEnvFile(envFile(dataDir));

  // Load docs
  const docsArgs: DocsArgs = {
    absorb: v.docs ?? [],
    keep: v["docs-keep"] ?? [],
  };
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;

  let absorbedDocs: AbsorbedDoc[];
  let cachedDocs: Array<{
    summary: CachedDocSummary;
    content: string;
    contentType: string;
  }>;
  try {
    absorbedDocs = await Promise.all(
      docsArgs.absorb.map((src) => loadDoc(src, fetchUrl)),
    );
    cachedDocs = await Promise.all(
      docsArgs.keep.map(async (src) => {
        const doc = await loadDoc(src, fetchUrl);
        return {
          summary: {
            id: docIdFromSource(src),
            source: src,
            summary: `Cached at onboard time (${new Date().toISOString().slice(0, 10)})`,
          },
          content: doc.content,
          contentType: "text/plain",
        };
      }),
    );
  } catch (err) {
    console.error(
      `onboard: doc load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(`Onboarding ${app} from ${repoRoot.path}…`);
  console.log(
    `  Vault: ${vault}  •  Absorbed docs: ${absorbedDocs.length}  •  Cached docs: ${cachedDocs.length}`,
  );

  let agentResult;
  try {
    agentResult = await runOnboardAgent({
      app,
      repoRoot: repoRoot.path,
      absorbedDocs,
      cachedDocs: cachedDocs.map((c) => c.summary),
      ...(deps.transport !== undefined && { transport: deps.transport }),
    });
  } catch (err) {
    if (err instanceof OnboardError) {
      console.error(`onboard: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Write brain.json + scaffolding
  const brainFolder = brainDir(dataDir, vault, app);
  fs.mkdirSync(path.join(brainFolder, "docs"), { recursive: true });
  fs.mkdirSync(path.join(brainFolder, "research"), { recursive: true });
  fs.mkdirSync(planDir(dataDir, vault, app), { recursive: true });

  const docsIndex: Array<Record<string, unknown>> = [];

  // Cache the kept docs to brains/<app>/docs/<id>/
  for (const c of cachedDocs) {
    const cacheDir = path.join(brainFolder, "docs", c.summary.id);
    fs.mkdirSync(cacheDir, { recursive: true });
    const filename = "content.txt";
    fs.writeFileSync(path.join(cacheDir, filename), c.content);
    docsIndex.push({
      id: c.summary.id,
      kind: isUrl(c.summary.source) ? "url" : "file",
      retention: "cached",
      source: c.summary.source,
      title: c.summary.id,
      tags: [],
      addedAt: new Date().toISOString(),
      summary: c.summary.summary ?? "",
      cachedFile: `docs/${c.summary.id}/${filename}`,
    });
  }
  // Record absorbed docs as a stub entry (originals not retained per §7)
  for (const a of absorbedDocs) {
    docsIndex.push({
      id: docIdFromSource(a.source),
      kind: isUrl(a.source) ? "url" : "file",
      retention: "absorbed",
      source: a.source,
      title: docIdFromSource(a.source),
      tags: [],
      addedAt: new Date().toISOString(),
      summary: "Absorbed at onboard; content extracted into brain.",
    });
  }
  fs.writeFileSync(
    brainDocsFile(dataDir, vault, app),
    JSON.stringify(docsIndex, null, 2) + "\n",
  );

  saveBrain(targetBrain, agentResult.brain);

  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: app,
      vaultId: vault,
      kind: "app-onboarded",
      payload: {
        app,
        vault,
        repoRoot: repoRoot.path,
        ...(v["monorepo-path"] !== undefined && {
          monorepoPath: v["monorepo-path"],
        }),
        absorbedDocsCount: absorbedDocs.length,
        cachedDocsCount: cachedDocs.length,
        numTurns: agentResult.numTurns,
      },
    });
  } finally {
    db.close();
  }

  // §7: --move-docs deletes the source files for any local doc (absorbed or
  // cached) once the brain + cached copies are durably on disk. URL docs are
  // never touched; we don't own them. Skipped silently when the flag is off.
  const moveDocs = v["move-docs"] === true;
  const moveResults: { moved: string[]; failed: Array<{ source: string; error: string }> } = {
    moved: [],
    failed: [],
  };
  if (moveDocs) {
    const sourcesToDelete: string[] = [];
    for (const a of absorbedDocs) {
      if (!isUrl(a.source)) sourcesToDelete.push(a.source);
    }
    for (const c of cachedDocs) {
      if (!isUrl(c.summary.source)) sourcesToDelete.push(c.summary.source);
    }
    for (const source of sourcesToDelete) {
      try {
        fs.rmSync(source, { force: true });
        moveResults.moved.push(source);
      } catch (err) {
        moveResults.failed.push({
          source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  console.log(`✓ Onboarded ${app}`);
  console.log(`  Brain: ${targetBrain}`);
  console.log(`  Plans dir: ${planDir(dataDir, vault, app)}`);
  console.log(`  Turns: ${agentResult.numTurns}`);
  if (moveDocs) {
    if (moveResults.moved.length > 0) {
      console.log(`  Moved ${moveResults.moved.length} source doc(s) into jarvis-data:`);
      for (const m of moveResults.moved) console.log(`    - ${m} (deleted)`);
    }
    for (const f of moveResults.failed) {
      console.log(`  ⚠ Failed to delete ${f.source}: ${f.error}`);
    }
  }
  console.log(
    `  Next: yarn jarvis plan --app ${app} "<your first plan brief>"`,
  );
  return 0;
}

interface ResolvedRepoOk {
  ok: true;
  path: string;
}
interface ResolvedRepoError {
  ok: false;
  message: string;
}

function resolveRepoRoot(
  repoArg: string,
  monorepoPath: string | undefined,
): ResolvedRepoOk | ResolvedRepoError {
  // Phase 1: only absolute local paths. URL/git remote support lands later.
  if (!path.isAbsolute(repoArg)) {
    return {
      ok: false,
      message:
        `--repo must be an absolute local path (got "${repoArg}"). ` +
        "Phase 1 supports local repo paths only; URL/git-remote onboarding lands later.",
    };
  }
  if (!fs.existsSync(repoArg)) {
    return { ok: false, message: `--repo path does not exist: ${repoArg}` };
  }
  if (!fs.statSync(repoArg).isDirectory()) {
    return { ok: false, message: `--repo path is not a directory: ${repoArg}` };
  }
  let resolved = repoArg;
  if (monorepoPath !== undefined) {
    resolved = path.resolve(repoArg, monorepoPath);
    if (!fs.existsSync(resolved)) {
      return {
        ok: false,
        message: `--monorepo-path does not exist: ${monorepoPath} inside ${repoArg}`,
      };
    }
  }
  return { ok: true, path: resolved };
}

async function loadDoc(
  source: string,
  fetcher: (url: string) => Promise<{ content: string; contentType?: string }>,
): Promise<AbsorbedDoc> {
  if (isUrl(source)) {
    const fetched = await fetcher(source);
    return {
      source,
      content: truncate(fetched.content, MAX_DOC_BYTES, source),
    };
  }
  if (!path.isAbsolute(source)) {
    throw new Error(
      `doc path must be absolute or a URL (got "${source}")`,
    );
  }
  if (!fs.existsSync(source)) {
    throw new Error(`doc not found: ${source}`);
  }
  const stat = fs.statSync(source);
  if (!stat.isFile()) {
    throw new Error(`doc is not a regular file: ${source}`);
  }
  const buf = fs.readFileSync(source);
  return {
    source,
    content: truncate(buf.toString("utf8"), MAX_DOC_BYTES, source),
  };
}

function truncate(text: string, max: number, source: string): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n[truncated at ${max} bytes; original ${text.length} bytes from ${source}]`
  );
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function docIdFromSource(source: string): string {
  const base = isUrl(source)
    ? new URL(source).hostname + new URL(source).pathname.replace(/\W+/g, "-")
    : path.basename(source);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function defaultFetchUrl(
  url: string,
): Promise<{ content: string; contentType?: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }
  const content = await response.text();
  const contentType = response.headers.get("content-type") ?? undefined;
  return contentType !== undefined ? { content, contentType } : { content };
}
