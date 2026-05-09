import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
  IdeaIntakeError,
  runIdeaIntakeAgent,
  type DraftIdea,
} from "../../agents/idea-intake.ts";
import { makeStdioIntakeIO, type IntakeIO } from "../../agents/intake.ts";
import type { RunAgentTransport } from "../../orchestrator/agent-sdk-runtime.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import {
  loadBusinessIdeas,
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
}

export async function runIdeas(
  rawArgs: string[],
  deps: IdeasDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === "add") return runIdeasAdd(rest, deps);
  if (subcommand === "list") return runIdeasList(rest);
  if (subcommand === undefined) {
    console.error(
      "ideas: missing subcommand. Usage: yarn jarvis ideas <add|list> [--vault <name>]",
    );
  } else {
    console.error(
      `ideas: unknown subcommand "${subcommand}". Available: add, list`,
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

function defaultHasTty(): boolean {
  return process.stdin.isTTY === true;
}
