import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  IntakeError,
  makeStdioIntakeIO,
  runIntakeAgent,
  type IntakeIO,
} from "../../agents/intake.ts";
import {
  OnboardError,
  runOnboardAgent,
  type AbsorbedDoc,
  type CachedDocSummary,
} from "../../agents/onboard.ts";
import type { RunAgentTransport } from "../../orchestrator/agent-sdk-runtime.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import {
  cacheAbsolutePath,
  cacheRelativePath,
  defaultFetchUrl,
  docIdFromSource,
  isUrl,
  loadDocSource,
  saveDocsIndex,
  writeCachedDocContent,
  type DocEntry,
  type FetchUrl,
} from "../../orchestrator/docs.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  brainDir,
  brainFile,
  dbFile,
  envFile,
  getDataDir,
  planDir,
  vaultDir,
} from "../paths.ts";

export interface OnboardCommandDeps {
  /** Test injection — overrides the SDK transport for the brain-extraction agent. */
  transport?: RunAgentTransport;
  /** Test injection — overrides the SDK transport for the intake agent. */
  intakeTransport?: RunAgentTransport;
  /** Test injection — replaces the stdin/stdout interview IO. */
  intakeIO?: IntakeIO;
  /**
   * Test injection — overrides the TTY check that decides whether to run
   * the interview phase. Defaults to `process.stdin.isTTY`.
   */
  hasTty?: () => boolean;
  /** For tests: skip the network and return a stub for any URL doc fetch. */
  fetchUrl?: FetchUrl;
}

const INTAKE_DOC_ID = "intake";

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

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
        "skip-interview": { type: "boolean" },
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
      docsArgs.absorb.map(async (src) => {
        const doc = await loadDocSource(src, fetchUrl);
        return { source: doc.source, content: doc.content };
      }),
    );
    cachedDocs = await Promise.all(
      docsArgs.keep.map(async (src) => {
        const doc = await loadDocSource(src, fetchUrl);
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

  // ---------------------------------------------------------------------
  // Phase 1 — Interactive interview (intake.md).
  // Skipped when --skip-interview is set or when stdin isn't a TTY (e.g.
  // CI, tests, daemon). The intake doc is registered as a cached doc and
  // fed into Phase 2 alongside any user-provided absorbed docs.
  // ---------------------------------------------------------------------
  const skipFlag = v["skip-interview"] === true;
  const hasTty = (deps.hasTty ?? defaultHasTty)();
  const runInterview = !skipFlag && hasTty;

  // Pre-create the brain folders so the intake file has a stable home.
  const brainFolder = brainDir(dataDir, vault, app);
  fs.mkdirSync(path.join(brainFolder, "docs"), { recursive: true });
  fs.mkdirSync(path.join(brainFolder, "research"), { recursive: true });
  fs.mkdirSync(planDir(dataDir, vault, app), { recursive: true });

  let intakeContent: string | undefined;
  if (runInterview) {
    const intakeFilePath = cacheAbsolutePath(dataDir, vault, app, INTAKE_DOC_ID);
    fs.mkdirSync(path.dirname(intakeFilePath), { recursive: true });

    console.log("");
    console.log("Phase 1 — Interview");
    console.log("  Type your answer; submit with a blank line.");
    console.log("  /skip  — skip the current section");
    console.log("  /end   — finish the interview now (or press Ctrl-D)");
    console.log("  --skip-interview bypasses Phase 1 entirely next time.");

    const io =
      deps.intakeIO ??
      makeStdioIntakeIO({ stdin: process.stdin, stdout: process.stdout });

    try {
      const intakeResult = await runIntakeAgent({
        app,
        repoRoot: repoRoot.path,
        io,
        intakeFilePath,
        ...(deps.intakeTransport !== undefined && {
          transport: deps.intakeTransport,
        }),
      });
      intakeContent = intakeResult.content;
      console.log(
        `\n  Intake captured: ${intakeResult.sections.length} section(s), ${intakeResult.totalRounds} turn(s).`,
      );
    } catch (err) {
      if (err instanceof IntakeError) {
        console.error(`onboard: intake failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  } else {
    const reason = skipFlag ? "--skip-interview set" : "no TTY detected";
    console.log(`  Skipping intake interview (${reason}).`);
  }

  // ---------------------------------------------------------------------
  // Phase 2 — Brain extraction. Strategist sees the user-provided absorbed
  // docs PLUS the intake markdown (if captured). The cached intake doc is
  // listed as a cached doc reference so Strategist knows it exists, and
  // also passed inline as an absorbed doc so its contents land in scope.
  // ---------------------------------------------------------------------
  const phase2AbsorbedDocs: AbsorbedDoc[] = [...absorbedDocs];
  const phase2CachedSummaries: CachedDocSummary[] = cachedDocs.map((c) => c.summary);
  if (intakeContent !== undefined) {
    const intakeSource = cacheAbsolutePath(dataDir, vault, app, INTAKE_DOC_ID);
    phase2AbsorbedDocs.push({
      source: intakeSource,
      content: intakeContent,
    });
    phase2CachedSummaries.push({
      id: INTAKE_DOC_ID,
      source: intakeSource,
      summary: "Onboarding interview transcript captured at intake time.",
    });
  }

  let agentResult;
  try {
    agentResult = await runOnboardAgent({
      app,
      repoRoot: repoRoot.path,
      absorbedDocs: phase2AbsorbedDocs,
      cachedDocs: phase2CachedSummaries,
      ...(deps.transport !== undefined && { transport: deps.transport }),
    });
  } catch (err) {
    if (err instanceof OnboardError) {
      console.error(`onboard: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const addedAt = new Date().toISOString();
  const docsIndex: DocEntry[] = [];

  // Register the intake doc in docs.json as a cached doc.
  if (intakeContent !== undefined) {
    docsIndex.push({
      id: INTAKE_DOC_ID,
      kind: "file",
      retention: "cached",
      source: cacheAbsolutePath(dataDir, vault, app, INTAKE_DOC_ID),
      title: "Onboarding intake",
      tags: ["intake"],
      addedAt,
      summary: "Onboarding interview transcript captured at intake time.",
      cachedFile: cacheRelativePath(INTAKE_DOC_ID),
    });
  }

  // Cache the kept docs to brains/<app>/docs/<id>/
  for (const c of cachedDocs) {
    writeCachedDocContent(dataDir, vault, app, c.summary.id, c.content);
    docsIndex.push({
      id: c.summary.id,
      kind: isUrl(c.summary.source) ? "url" : "file",
      retention: "cached",
      source: c.summary.source,
      title: c.summary.id,
      tags: [],
      addedAt,
      summary: c.summary.summary ?? "",
      cachedFile: cacheRelativePath(c.summary.id),
      ...(isUrl(c.summary.source) ? { refreshedAt: addedAt } : {}),
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
      addedAt,
      summary: "Absorbed at onboard; content extracted into brain.",
    });
  }
  saveDocsIndex(dataDir, vault, app, docsIndex);

  // Force `repo` onto the brain from the user's --repo + --monorepo-path
  // flags. The agent's prompt doesn't compose this (the SDK isn't told the
  // repo path), and we want it grounded in the user's intent regardless of
  // what the agent emits. The plan-executor's resolveAppCwd joins these to
  // derive the SDK cwd. See multi-repo plan + §15.
  const onboardedBrain = {
    ...agentResult.brain,
    repo: {
      rootPath: repoArg,
      ...(v["monorepo-path"] !== undefined && {
        monorepoPath: v["monorepo-path"],
      }),
    },
  };
  saveBrain(targetBrain, onboardedBrain);

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
        intakeCaptured: intakeContent !== undefined,
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
  if (intakeContent !== undefined) {
    console.log(
      `  Intake: ${cacheAbsolutePath(dataDir, vault, app, INTAKE_DOC_ID)}`,
    );
  }
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

function defaultHasTty(): boolean {
  return process.stdin.isTTY === true;
}
