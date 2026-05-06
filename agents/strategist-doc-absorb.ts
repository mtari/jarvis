import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { loadBrain } from "../orchestrator/brain.ts";
import {
  cacheRelativePath,
  docIdFromSource,
  loadDocsIndex,
  saveDocsIndex,
  uniqueDocId,
  isUrl,
  type DocEntry,
} from "../orchestrator/docs.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { parsePlan, transitionPlan } from "../orchestrator/plan.ts";
import { savePlan } from "../orchestrator/plan-store.ts";
import {
  brainFile,
  dbFile,
  planDir,
  repoRoot,
} from "../cli/paths.ts";
import {
  dumpFailedDraft,
  generatePlanId,
  parseStrategistResponse,
  StrategistError,
} from "./strategist.ts";

/**
 * Doc-absorb agent — drafts an `improvement` plan with `subtype: meta`
 * proposing how a new project doc should change the app's brain.
 *
 * Single-shot: no clarify loop. The doc is the input; the plan is
 * the proposal. If the doc has nothing project-relevant, Strategist
 * is allowed to return `<clarify>` (we surface that as a hint).
 *
 * On success: writes the plan markdown to the plans dir AND adds a
 * `retention: absorbed` entry to `docs.json`. The brain itself is NOT
 * mutated here — application of the proposed changes is a follow-up
 * (user-driven manual edit in v1; orchestrator applier in a future PR).
 */

export interface AbsorbDocInput {
  client: AnthropicClient;
  app: string;
  vault: string;
  dataDir: string;
  /** Source path or URL — used for the docs.json entry id. */
  source: string;
  /** Already-loaded doc body. */
  docContent: string;
  /** Optional free-form tag passed to Strategist (e.g. "brand guidelines"). */
  contextTag?: string;
}

export interface AbsorbDocResult {
  planId: string;
  planPath: string;
  /** Slug used for the docs.json entry. */
  docId: string;
}

export class DocAbsorbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocAbsorbError";
  }
}

export async function absorbDoc(
  input: AbsorbDocInput,
): Promise<AbsorbDocResult> {
  const brain = loadBrain(brainFile(input.dataDir, input.vault, input.app));
  const systemPrompt = loadAbsorbPrompt();
  const userMessage = buildAbsorbContext({
    brain,
    docContent: input.docContent,
    source: input.source,
    ...(input.contextTag !== undefined && { contextTag: input.contextTag }),
  });

  const response = await input.client.chat({
    system: systemPrompt,
    cacheSystem: true,
    messages: [{ role: "user", content: userMessage }],
  });

  const action = parseStrategistResponse(response);
  if (action.kind !== "draft") {
    // Strategist may return <clarify> when the doc has nothing
    // project-relevant. Surface that to the caller so the CLI can hint
    // toward `--keep` instead.
    throw new DocAbsorbError(
      `doc has nothing project-relevant for the brain (Strategist asked: ${action.questions.join(" ")}). Try \`docs add --keep <source>\` to cache without absorbing.`,
    );
  }

  const plan = (() => {
    try {
      return parsePlan(action.markdown);
    } catch (err) {
      const dumpPath = dumpFailedDraft(input.dataDir, action.markdown);
      throw new DocAbsorbError(
        `Strategist's draft failed schema validation: ${err instanceof Error ? err.message : String(err)}` +
          (dumpPath ? `\n  Raw draft saved at ${dumpPath}` : ""),
      );
    }
  })();
  if (plan.metadata.type !== "improvement" || plan.metadata.subtype !== "meta") {
    throw new DocAbsorbError(
      `absorb plan must be improvement/meta, got ${plan.metadata.type}/${plan.metadata.subtype ?? "(none)"}`,
    );
  }
  if (plan.metadata.app !== input.app) {
    throw new DocAbsorbError(
      `absorb plan app "${plan.metadata.app}" doesn't match input app "${input.app}"`,
    );
  }
  const transitioned = transitionPlan(plan, "awaiting-review");

  const planId = generatePlanId(
    transitioned.metadata.title,
    input.app,
    input.dataDir,
    input.vault,
  );
  const folder = planDir(input.dataDir, input.vault, input.app);
  fs.mkdirSync(folder, { recursive: true });
  const planPath = path.join(folder, `${planId}.md`);

  const existingDocs = loadDocsIndex(input.dataDir, input.vault, input.app);
  const wantedDocId = docIdFromSource(input.source);
  const docId = uniqueDocId(
    wantedDocId,
    existingDocs.map((e) => e.id),
  );
  const summary = extractDocSummary(action.markdown);
  const addedAt = new Date().toISOString();
  const newDoc: DocEntry = {
    id: docId,
    kind: isUrl(input.source) ? "url" : "file",
    retention: "absorbed",
    source: input.source,
    title: docId,
    tags: [],
    addedAt,
    summary,
  };
  // We intentionally do NOT write a cached file — absorb-mode keeps no
  // copy of the original. The plan's "## Doc summary" section is the
  // record of what the doc said.
  void cacheRelativePath; // unused; kept imported for v1 type parity

  const db = new Database(dbFile(input.dataDir));
  try {
    db.transaction(() => {
      appendEvent(db, {
        appId: input.app,
        vaultId: input.vault,
        kind: "plan-drafted",
        payload: {
          planId,
          brief: `docs absorb: ${input.source}`,
          rounds: 0,
          author: "strategist",
        },
      });
      appendEvent(db, {
        appId: input.app,
        vaultId: input.vault,
        kind: "doc-absorb-proposed",
        payload: {
          docId,
          source: input.source,
          planId,
        },
      });
    })();
  } finally {
    db.close();
  }

  savePlan(planPath, transitioned);
  saveDocsIndex(input.dataDir, input.vault, input.app, [
    ...existingDocs,
    newDoc,
  ]);

  return { planId, planPath, docId };
}

interface BuildAbsorbContextArgs {
  brain: ReturnType<typeof loadBrain>;
  docContent: string;
  source: string;
  contextTag?: string;
}

function buildAbsorbContext(args: BuildAbsorbContextArgs): string {
  const lines: string[] = [];
  lines.push(`App: ${args.brain.projectName}`);
  if (args.contextTag) {
    lines.push(`Doc context: ${args.contextTag}`);
  }
  lines.push(`Doc source: ${args.source}`);
  lines.push("");
  lines.push("Current brain (canonical):");
  lines.push("```json");
  lines.push(JSON.stringify(args.brain, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Doc body:");
  lines.push("```");
  lines.push(args.docContent.trim());
  lines.push("```");
  return lines.join("\n");
}

/**
 * Pulls the `## Doc summary` section out of the drafted plan markdown
 * for the docs.json entry. Falls back to a generic note if Strategist
 * omitted the section (the prompt requires it, but be lenient).
 */
function extractDocSummary(planMarkdown: string): string {
  const m = planMarkdown.match(
    /^##\s+Doc summary\s*\n([\s\S]*?)(?=\n##\s|\n*$)/m,
  );
  if (!m || !m[1]) {
    return "Absorbed; see plan body for proposed brain changes.";
  }
  return m[1].trim();
}

let cachedPrompt: string | undefined;
function loadAbsorbPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(repoRoot(), "prompts", "strategist-doc-absorb.md"),
    "utf8",
  );
  return cachedPrompt;
}
