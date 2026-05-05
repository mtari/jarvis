import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { notesFile } from "../cli/paths.ts";

/**
 * Free-text project notes — the "meeting whiteboard" complement to
 * the structured brain (§7). Each app has a `notes.md` at
 * `<dataDir>/vaults/<vault>/brains/<app>/notes.md` that the user
 * appends to whenever, and that Strategist / Scout / Developer all
 * read into their context when constructing their prompts.
 *
 * The file isn't validated — anything goes. Append-only via the
 * helpers here is the recommended workflow (timestamps prepended);
 * direct editing via `$EDITOR` is supported (see CLI `notes` command).
 *
 * Mental model: the brain is the spec; notes are the in-flight
 * thoughts you'd write on a whiteboard between meetings.
 */

export interface AppendNoteInput {
  /** Free-text content. Newlines preserved. */
  text: string;
  /** Override "now" — test seam. Production uses real wall clock. */
  now?: Date;
  /** Optional actor tag — e.g. `slack:U-xyz`. Inlined after the timestamp. */
  actor?: string;
}

/**
 * Reads the notes file, returning empty string when missing.
 * Read errors propagate.
 */
export function readNotes(
  dataDir: string,
  vault: string,
  app: string,
): string {
  const filePath = notesFile(dataDir, vault, app);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

/**
 * True iff the notes file exists AND has non-whitespace content.
 * Used by agent context builders to decide whether to include a
 * "## Notes" section in the prompt.
 */
export function hasNotes(
  dataDir: string,
  vault: string,
  app: string,
): boolean {
  return readNotes(dataDir, vault, app).trim().length > 0;
}

/**
 * Appends a timestamped entry to the notes file. Format:
 *
 *     ## 2026-05-05T14:00:00Z [optional actor]
 *
 *     <text>
 *
 * Atomic-write semantics: existing content + new entry written via
 * `atomicWriteFileSync` (tempfile → fsync → rename). The brain
 * directory is created on demand if it doesn't exist yet — gives
 * agents a way to drop notes for not-yet-onboarded apps without
 * a separate seeding step (the directory is harmless empty).
 */
export function appendNote(
  dataDir: string,
  vault: string,
  app: string,
  input: AppendNoteInput,
): void {
  const filePath = notesFile(dataDir, vault, app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const trimmedText = input.text.replace(/\s+$/, "");
  if (trimmedText.length === 0) return;

  const stamp = (input.now ?? new Date()).toISOString();
  const heading =
    input.actor !== undefined
      ? `## ${stamp} — ${input.actor}`
      : `## ${stamp}`;
  const entry = `${heading}\n\n${trimmedText}\n`;

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8").replace(/\s+$/, "");
  }
  const next = existing.length > 0 ? `${existing}\n\n${entry}` : entry;
  atomicWriteFileSync(filePath, next);
}

/**
 * Convenience helper for agent context builders: when notes exist,
 * returns a labelled markdown block ready to splice into the prompt;
 * when absent, returns null so the caller can omit the section
 * entirely (saves tokens + reduces noise).
 */
export function notesContextBlock(
  dataDir: string,
  vault: string,
  app: string,
): string | null {
  const text = readNotes(dataDir, vault, app).trim();
  if (text.length === 0) return null;
  return [
    "## Free-text notes for this app",
    "",
    "These are the user's in-flight thoughts on the project — meeting whiteboard, not a structured spec. Read for context; the brain is still authoritative on the stable facts.",
    "",
    text,
  ].join("\n");
}
