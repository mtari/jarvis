import Database from "better-sqlite3";
import { dbFile } from "../cli/paths.ts";
import {
  loadBusinessIdeas,
  type BusinessIdea,
} from "./business-ideas.ts";

/**
 * Read-only view of an idea, enriched with derived state pulled from
 * the event log (whether Strategist has auto-drafted a plan for it).
 */
export interface IdeaListing {
  idea: BusinessIdea;
  /** True when an `idea-drafted` event exists for this idea id. */
  drafted: boolean;
}

/**
 * Loads every idea from `Business_Ideas.md`, joins each with its
 * "drafted" flag from the event log, and returns the list **sorted**:
 * highest-scoring first, then unscored alphabetically by title.
 */
export function listIdeasWithStatus(dataDir: string): IdeaListing[] {
  const file = loadBusinessIdeas(dataDir);
  const draftedIds = readDraftedIdeaIds(dataDir);

  const enriched = file.ideas.map((idea) => ({
    idea,
    drafted: draftedIds.has(idea.id),
  }));

  // Sort: scored ideas first (high → low), then unscored ideas
  // alphabetically by title. Stable for equal scores via title fallback.
  enriched.sort((a, b) => {
    const sa = a.idea.score;
    const sb = b.idea.score;
    if (sa !== undefined && sb !== undefined) {
      if (sa !== sb) return sb - sa;
      return a.idea.title.localeCompare(b.idea.title);
    }
    if (sa !== undefined) return -1;
    if (sb !== undefined) return 1;
    return a.idea.title.localeCompare(b.idea.title);
  });
  return enriched;
}

function readDraftedIdeaIds(dataDir: string): Set<string> {
  const out = new Set<string>();
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'idea-drafted' ORDER BY id ASC",
      )
      .all() as Array<{ payload: string }>;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { ideaId?: string; id?: string };
        const id = p.ideaId ?? p.id;
        if (typeof id === "string" && id.length > 0) out.add(id);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // events table might not exist yet (fresh install) — treat as no drafts.
  } finally {
    db.close();
  }
  return out;
}

/**
 * Renders the listing as plain text suitable for both CLI stdout and
 * Slack message bodies. One block per idea, separated by a blank line.
 *
 * `markup` controls whether headings use Slack mrkdwn (`*bold*` and
 * `\`code\``) or terminal-friendly formatting (uppercase score tag).
 */
export function formatIdeaListing(
  rows: ReadonlyArray<IdeaListing>,
  markup: "plain" | "slack" = "plain",
): string {
  if (rows.length === 0) {
    return markup === "slack"
      ? "_No ideas yet. Run `/jarvis ideas add` to capture one._"
      : "No ideas yet. Run `yarn jarvis ideas add` to capture one.";
  }
  return rows.map((r) => formatOne(r, markup)).join("\n\n");
}

function formatOne(row: IdeaListing, markup: "plain" | "slack"): string {
  const { idea, drafted } = row;
  const lines: string[] = [];

  const scoreTag =
    idea.score !== undefined ? padScore(idea.score) : padScore(undefined);
  const draftedMark = drafted ? " ✓drafted" : "";
  const titleStart =
    markup === "slack" ? `*${idea.title}*` : idea.title;
  const appPart = markup === "slack" ? `\`${idea.app}\`` : `→ ${idea.app}`;

  lines.push(`[${scoreTag}] ${titleStart}  ${appPart}${draftedMark}`);

  if (idea.tags.length > 0) {
    const tagText = idea.tags.map((t) => `#${t}`).join(" ");
    lines.push(`        ${tagText}`);
  }
  lines.push(`        ${idea.brief}`);
  if (idea.rationale !== undefined && idea.rationale.length > 0) {
    lines.push(`        Why: ${idea.rationale}`);
  }
  return lines.join("\n");
}

function padScore(score: number | undefined): string {
  if (score === undefined) return " — ";
  const n = Math.max(0, Math.min(100, Math.round(score)));
  return n.toString().padStart(3, " ");
}
