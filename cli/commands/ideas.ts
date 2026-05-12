import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  IdeaIntakeError,
  runIdeaIntakeAgent,
  type DraftIdea,
} from "../../agents/idea-intake.ts";
import { scoreUnscoredIdeas } from "../../agents/scout.ts";
import { makeStdioIntakeIO, type IntakeIO } from "../../agents/intake.ts";
import {
  createSdkClient,
  type AnthropicClient,
  type RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import {
  IdeaSectionParseError,
  loadBusinessIdeas,
  parseIdeaSection,
  renderIdeaSection,
  saveBusinessIdeas,
  type BusinessIdea,
} from "../../orchestrator/business-ideas.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  formatIdeaListing,
  listIdeasWithStatus,
} from "../../orchestrator/idea-listing.ts";
import { businessIdeasFile, dbFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis ideas add [--vault <name>]`
 *   Conversational interview that captures one new idea and appends it
 *   to `Business_Ideas.md`. Records an `idea-added` event so the audit
 *   trail shows when each idea entered the queue.
 *
 *   Use `yarn jarvis scout score` afterwards to score it.
 */

export interface IdeasDeps {
  /** Test injection — overrides the SDK transport. */
  transport?: RunAgentTransport;
  /** Test injection — replaces the stdin/stdout interview IO. */
  io?: IntakeIO;
  /** Test injection — overrides the TTY check. */
  hasTty?: () => boolean;
  /** Test injection — replaces the $EDITOR spawn for `ideas edit`. */
  spawnEditor?: (editor: string, file: string) => { status: number | null };
  /** Test injection — supplies the Anthropic client for `ideas edit --rescore`. */
  buildScoutClient?: () => AnthropicClient;
}

export async function runIdeas(
  rawArgs: string[],
  deps: IdeasDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === "add") return runIdeasAdd(rest, deps);
  if (subcommand === "list") return runIdeasList(rest);
  if (subcommand === "edit") return runIdeasEdit(rest, deps);
  if (subcommand === undefined) {
    console.error(
      "ideas: missing subcommand. Usage: yarn jarvis ideas <add|list|edit> [--vault <name>]",
    );
  } else {
    console.error(
      `ideas: unknown subcommand "${subcommand}". Available: add, list, edit`,
    );
  }
  return 1;
}

async function runIdeasAdd(
  rest: string[],
  deps: IdeasDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { vault: { type: "string" } },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`ideas: ${(err as Error).message}`);
    return 1;
  }

  const dataDir = getDataDir();
  const vault = parsed.values.vault ?? "personal";

  // TTY check — same pattern as onboard. Refuse non-interactive runs since
  // the whole point of the command is the conversational interview.
  const hasTty = (deps.hasTty ?? defaultHasTty)();
  if (!hasTty && deps.io === undefined) {
    console.error(
      "ideas add: this command is interactive and needs a TTY. " +
        "Edit Business_Ideas.md directly if you can't run it interactively.",
    );
    return 1;
  }

  // Build the list of known apps so the agent can suggest them in question 1.
  const onboarded = listOnboardedApps(dataDir).filter((a) => a.vault === vault);
  const knownApps = onboarded.map((a) => a.app).sort();

  console.log("");
  console.log("Capture a new idea");
  console.log("  Type your answer; submit with a blank line.");
  console.log("  /skip  — skip the current question (agent infers)");
  console.log("  /end   — finish now (or press Ctrl-D)");
  console.log("");

  const io =
    deps.io ?? makeStdioIntakeIO({ stdin: process.stdin, stdout: process.stdout });

  let agentResult;
  try {
    agentResult = await runIdeaIntakeAgent({
      knownApps,
      io,
      ...(deps.transport !== undefined && { transport: deps.transport }),
    });
  } catch (err) {
    if (err instanceof IdeaIntakeError) {
      console.error(`ideas add: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Append to Business_Ideas.md. We re-load the file to round-trip any
  // existing preamble and avoid clobbering ideas added between the start
  // and end of this session.
  const file = loadBusinessIdeas(dataDir);
  const newIdea = toBusinessIdea(agentResult.idea, file.ideas);
  file.ideas.push(newIdea);
  saveBusinessIdeas(dataDir, file);

  // Audit-trail event.
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: newIdea.app,
      vaultId: vault,
      kind: "idea-added",
      payload: {
        ideaId: newIdea.id,
        title: newIdea.title,
        app: newIdea.app,
        brief: newIdea.brief,
        tags: newIdea.tags,
        rounds: agentResult.totalRounds,
        finishedCleanly: agentResult.finishedCleanly,
      },
    });
  } finally {
    db.close();
  }

  console.log("");
  console.log(`✓ Added "${newIdea.title}" to ${businessIdeasFile(dataDir)}`);
  console.log(`  App: ${newIdea.app}`);
  console.log(`  Brief: ${newIdea.brief}`);
  if (newIdea.tags.length > 0) {
    console.log(`  Tags: ${newIdea.tags.join(", ")}`);
  }
  console.log("");
  console.log("Next: yarn jarvis scout score   — score this and any other unscored ideas");
  return 0;
}

function toBusinessIdea(
  draft: DraftIdea,
  existing: ReadonlyArray<BusinessIdea>,
): BusinessIdea {
  const baseId = slugify(draft.title);
  const id = uniqueId(
    baseId.length > 0 ? baseId : "idea",
    existing.map((e) => e.id),
  );
  return {
    id,
    title: draft.title,
    app: draft.app,
    brief: draft.brief,
    tags: draft.tags,
    body: draft.body,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueId(base: string, existing: ReadonlyArray<string>): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function runIdeasList(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`ideas list: ${(err as Error).message}`);
    return 1;
  }
  const format = parsed.values.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(
      `ideas list: invalid --format "${format}" (expected table or json)`,
    );
    return 1;
  }

  const dataDir = getDataDir();
  const rows = listIdeasWithStatus(dataDir);

  if (format === "json") {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          ...r.idea,
          drafted: r.drafted,
        })),
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(formatIdeaListing(rows, "plain"));
  console.log("");
  console.log(
    `${rows.length} idea(s). yarn jarvis scout score → score unscored. yarn jarvis scout draft → auto-draft high scorers.`,
  );
  return 0;
}

async function runIdeasEdit(
  rest: string[],
  deps: IdeasDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        vault: { type: "string" },
        rescore: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`ideas edit: ${(err as Error).message}`);
    return 1;
  }

  if (parsed.positionals.length === 0) {
    console.error("ideas edit: missing <id>. Usage: yarn jarvis ideas edit <id> [--rescore] [--vault <v>]");
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(`ideas edit: unexpected extra positional: ${parsed.positionals.slice(1).join(" ")}`);
    return 1;
  }

  const id = parsed.positionals[0]!;
  const vault = parsed.values.vault ?? "personal";
  const rescore = parsed.values.rescore ?? false;
  const dataDir = getDataDir();

  const file = loadBusinessIdeas(dataDir);
  const ideaIdx = file.ideas.findIndex((i) => i.id === id);
  if (ideaIdx === -1) {
    console.error(`idea "${id}" not found; run yarn jarvis ideas list to see available ids`);
    return 1;
  }

  const idea = file.ideas[ideaIdx]!;
  const stripped: BusinessIdea = {
    id: idea.id,
    title: idea.title,
    app: idea.app,
    brief: idea.brief,
    tags: idea.tags,
    body: idea.body,
  };
  const seedText = renderIdeaSection(stripped);

  const tmpFile = path.join(os.tmpdir(), `jarvis-idea-${id}-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpFile, seedText, "utf8");

    const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
    const spawn = deps.spawnEditor ?? defaultSpawnEditor;
    const result = spawn(editor, tmpFile);
    if (result.status !== 0) {
      console.error(`ideas edit: editor "${editor}" exited with status ${result.status ?? "unknown"}`);
      return 1;
    }

    const editedText = fs.readFileSync(tmpFile, "utf8");

    if (editedText === seedText) {
      console.log("No changes.");
      return 0;
    }

    let newIdea: BusinessIdea;
    try {
      newIdea = parseIdeaSection(editedText);
    } catch (err) {
      if (err instanceof IdeaSectionParseError) {
        console.error(`ideas edit: parse error — ${err.message}`);
        return 1;
      }
      throw err;
    }

    // Strip any scoring fields the editor may have reintroduced.
    delete newIdea.score;
    delete newIdea.scoredAt;
    delete newIdea.rationale;

    // Resolve id collision after a title change.
    const oldId = idea.id;
    const otherIds = file.ideas.filter((i) => i.id !== oldId).map((i) => i.id);
    if (otherIds.includes(newIdea.id)) {
      let suffix = 2;
      while (otherIds.includes(`${newIdea.id}-${suffix}`)) suffix += 1;
      newIdea = { ...newIdea, id: `${newIdea.id}-${suffix}` };
    }

    file.ideas[ideaIdx] = newIdea;
    saveBusinessIdeas(dataDir, file);

    const db = new Database(dbFile(dataDir));
    try {
      appendEvent(db, {
        appId: newIdea.app,
        vaultId: vault,
        kind: "idea-edited",
        payload: {
          ideaId: oldId,
          ...(newIdea.id !== oldId && { newId: newIdea.id }),
          titleChanged: newIdea.title !== idea.title,
          bodyDelta: { from: idea.body, to: newIdea.body },
        },
      });
    } finally {
      db.close();
    }

    console.log(`✓ Updated "${newIdea.title}" in ${businessIdeasFile(dataDir)}`);

    if (rescore) {
      const client = deps.buildScoutClient ? deps.buildScoutClient() : createSdkClient();
      const scoreResult = await scoreUnscoredIdeas({ dataDir, client, vault });
      for (const entry of scoreResult.entries) {
        if (entry.error !== undefined) {
          console.log(`✗ ${entry.ideaId} — ${entry.error}`);
        } else {
          console.log(`✓ ${entry.ideaId} — score ${entry.score ?? "?"}`);
        }
      }
      return scoreResult.errorCount > 0 ? 1 : 0;
    }

    return 0;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function defaultSpawnEditor(
  editor: string,
  file: string,
): { status: number | null } {
  const result = spawnSync(editor, [file], { stdio: "inherit" });
  return { status: result.status };
}

function defaultHasTty(): boolean {
  return process.stdin.isTTY === true;
}
