import fs from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  editScheduledPost,
  findScheduledPost,
  listScheduledPosts,
  skipScheduledPost,
  ScheduledPostMutationError,
  type ListScheduledPostsFilter,
  type ScheduledPost,
  type ScheduledPostStatus,
} from "../../orchestrator/scheduled-posts.ts";
import { dbFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis posts <list|edit|skip>` — operate on rows in
 * `scheduled_posts`. Companion to `yarn jarvis marketer prepare`,
 * before the publishing path lands.
 *
 * Subcommands:
 *   list  — filter + print rows (table or JSON)
 *   edit  — replace a pending row's content; appends to edit_history
 *   skip  — mark a row as skipped so the scheduler won't publish it
 */

const VALID_STATUSES: ReadonlyArray<ScheduledPostStatus> = [
  "pending",
  "published",
  "failed",
  "skipped",
  "edited",
];

export interface PostsCommandDeps {
  /** Test seam — fixed clock for edit history. */
  now?: Date;
}

export async function runPosts(
  rawArgs: string[],
  deps: PostsCommandDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "list":
      return runPostsList(rest);
    case "edit":
      return runPostsEdit(rest, deps);
    case "skip":
      return runPostsSkip(rest);
    case undefined:
      console.error(
        "posts: missing subcommand. Usage: yarn jarvis posts <list|edit|skip> ...",
      );
      return 1;
    default:
      console.error(
        `posts: unknown subcommand "${subcommand}". Available: list, edit, skip.`,
      );
      return 1;
  }
}

// ---------------------------------------------------------------------------
// posts list
// ---------------------------------------------------------------------------

async function runPostsList(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        plan: { type: "string" },
        app: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
        format: { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`posts list: ${(err as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  const format = v.format ?? "table";
  if (format !== "table" && format !== "json") {
    console.error(
      `posts list: invalid --format "${format}" (expected table | json).`,
    );
    return 1;
  }
  const filter: ListScheduledPostsFilter = {};
  if (v.plan !== undefined) filter.planId = v.plan;
  if (v.app !== undefined) filter.appId = v.app;
  if (v.status !== undefined) {
    if (!isStatus(v.status)) {
      console.error(
        `posts list: invalid --status "${v.status}" (expected one of ${VALID_STATUSES.join(", ")}).`,
      );
      return 1;
    }
    filter.status = v.status;
  }
  if (v.limit !== undefined) {
    const n = Number.parseInt(v.limit, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`posts list: invalid --limit "${v.limit}".`);
      return 1;
    }
    filter.limit = n;
  }

  const dataDir = getDataDir();
  const db = new Database(dbFile(dataDir), { readonly: true });
  let rows: ScheduledPost[];
  try {
    rows = listScheduledPosts(db, filter);
  } finally {
    db.close();
  }

  if (format === "json") {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    console.log("No scheduled posts match.");
    return 0;
  }
  console.log(`Scheduled posts (${rows.length}):`);
  for (const r of rows) {
    const tags: string[] = [r.status, r.channel];
    if (r.editHistory.length > 0) tags.push(`edits:${r.editHistory.length}`);
    console.log(`  ${r.id}  [${tags.join(" ")}]  ${r.scheduledAt}`);
    console.log(`    plan: ${r.planId}  app: ${r.appId}`);
    const preview = r.content.replace(/\s+/g, " ").trim().slice(0, 120);
    console.log(`    text: ${preview}${r.content.length > 120 ? "…" : ""}`);
    if (r.failureReason) {
      console.log(`    note: ${r.failureReason}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// posts edit
// ---------------------------------------------------------------------------

async function runPostsEdit(
  rest: string[],
  deps: PostsCommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        inline: { type: "string" },
        file: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`posts edit: ${(err as Error).message}`);
    return 1;
  }
  const id = parsed.positionals[0];
  if (!id) {
    console.error(
      'posts edit: <post-id> required. Usage: yarn jarvis posts edit <post-id> [--inline "..." | --file <path>]',
    );
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `posts edit: unexpected extra positional: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }
  const inline = parsed.values.inline;
  const file = parsed.values.file;
  if (inline === undefined && file === undefined) {
    console.error(
      'posts edit: must pass --inline "<text>" or --file <path>',
    );
    return 1;
  }
  if (inline !== undefined && file !== undefined) {
    console.error("posts edit: --inline and --file are mutually exclusive");
    return 1;
  }
  let newContent: string;
  if (inline !== undefined) {
    newContent = inline;
  } else {
    if (!fs.existsSync(file!)) {
      console.error(`posts edit: --file path does not exist: ${file}`);
      return 1;
    }
    newContent = fs.readFileSync(file!, "utf8");
  }

  const dataDir = getDataDir();
  const db = new Database(dbFile(dataDir));
  try {
    const previous = findScheduledPost(db, id);
    if (!previous) {
      console.error(`posts edit: scheduled post "${id}" not found.`);
      return 1;
    }
    let updated: ScheduledPost;
    try {
      updated = editScheduledPost(db, id, {
        newContent,
        actor: "cli",
        ...(deps.now !== undefined && { now: deps.now }),
      });
    } catch (err) {
      if (err instanceof ScheduledPostMutationError) {
        console.error(`posts edit: ${err.message}`);
        return 1;
      }
      throw err;
    }
    if (updated.content === previous.content) {
      console.log(`posts edit: no change — content matches existing.`);
      return 0;
    }
    appendEvent(db, {
      appId: updated.appId,
      vaultId: "personal",
      kind: "post-edited",
      payload: {
        postId: id,
        planId: updated.planId,
        actor: "cli",
        previousLength: previous.content.length,
        newLength: updated.content.length,
      },
    });
    console.log(`✓ Updated ${id}`);
    console.log(`  Status: ${updated.status}`);
    console.log(`  Edits in history: ${updated.editHistory.length}`);
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// posts skip
// ---------------------------------------------------------------------------

async function runPostsSkip(rest: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        reason: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`posts skip: ${(err as Error).message}`);
    return 1;
  }
  const id = parsed.positionals[0];
  if (!id) {
    console.error(
      'posts skip: <post-id> required. Usage: yarn jarvis posts skip <post-id> --reason "..."',
    );
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `posts skip: unexpected extra positional: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }
  const reason = parsed.values.reason;
  if (!reason || reason.trim().length === 0) {
    console.error('posts skip: --reason "<text>" is required');
    return 1;
  }

  const dataDir = getDataDir();
  const db = new Database(dbFile(dataDir));
  try {
    let updated: ScheduledPost;
    try {
      updated = skipScheduledPost(db, id, { reason, actor: "cli" });
    } catch (err) {
      if (err instanceof ScheduledPostMutationError) {
        console.error(`posts skip: ${err.message}`);
        return 1;
      }
      throw err;
    }
    appendEvent(db, {
      appId: updated.appId,
      vaultId: "personal",
      kind: "post-skipped",
      payload: {
        postId: id,
        planId: updated.planId,
        actor: "cli",
        reason: reason.trim(),
      },
    });
    console.log(`✓ Skipped ${id}`);
    console.log(`  Reason: ${reason.trim()}`);
    return 0;
  } finally {
    db.close();
  }
}

function isStatus(s: string): s is ScheduledPostStatus {
  return (VALID_STATUSES as ReadonlyArray<string>).includes(s);
}
