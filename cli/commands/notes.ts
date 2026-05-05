import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { brainExists } from "../../orchestrator/brain.ts";
import { appendNote, readNotes } from "../../orchestrator/notes.ts";
import { brainFile, getDataDir, notesFile } from "../paths.ts";

/**
 * `yarn jarvis notes <app> [--vault <v>]`
 *   Open the app's `notes.md` in `$EDITOR`. Creates the file with a
 *   header line if it doesn't exist yet.
 *
 * `yarn jarvis notes <app> [--vault <v>] --append "<text>"`
 *   Append a timestamped entry to the file without opening the editor.
 *
 * Notes are read by Strategist / Scout / Developer when constructing
 * their context. The brain is the structured spec; notes are the
 * meeting whiteboard.
 */

export interface NotesDeps {
  /** Override $EDITOR. Tests inject a script that captures the call. */
  spawnEditor?: (editor: string, file: string) => { status: number | null };
  /** Override "now" — test seam. */
  now?: Date;
}

export async function runNotes(
  rawArgs: string[],
  deps: NotesDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        vault: { type: "string" },
        append: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`notes: ${(err as Error).message}`);
    return 1;
  }

  const app = parsed.positionals[0];
  if (!app) {
    console.error(
      'notes: app required. Usage: yarn jarvis notes <app> [--vault <v>] [--append "<text>"]',
    );
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `notes: unexpected extra positional: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const vault = parsed.values.vault ?? "personal";
  const dataDir = getDataDir();

  // Soft check: warn but don't refuse when the app has no brain. Notes
  // are useful pre-onboarding too — you can drop thoughts before the
  // brain takes shape.
  if (!brainExists(brainFile(dataDir, vault, app))) {
    console.log(
      `notes: app "${app}" in vault "${vault}" has no brain yet. Notes will still be saved alongside it for when you onboard.`,
    );
  }

  const filePath = notesFile(dataDir, vault, app);

  if (parsed.values.append !== undefined) {
    const text = parsed.values.append.trim();
    if (text.length === 0) {
      console.error("notes: --append text cannot be empty");
      return 1;
    }
    appendNote(dataDir, vault, app, {
      text,
      ...(deps.now !== undefined && { now: deps.now }),
      actor: "cli",
    });
    console.log(`✓ Appended note to ${filePath}`);
    return 0;
  }

  // Editor mode — ensure the file exists with a starter header so
  // first-time users see something rather than a blank file.
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const header = [
      `# Notes — ${app}`,
      "",
      "Free-text whiteboard for in-flight thoughts on this app. Strategist /",
      "Scout / Developer read this when building their context.",
      "",
      "## How to use",
      "",
      "Append timestamped entries with `yarn jarvis notes " +
        app +
        ' --append "..."`',
      "or edit this file directly. Anything goes.",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, header);
  }

  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
  const spawn = deps.spawnEditor ?? defaultSpawnEditor;
  const result = spawn(editor, filePath);
  if (result.status !== 0) {
    console.error(
      `notes: editor "${editor}" exited with status ${result.status ?? "unknown"}`,
    );
    return 1;
  }
  return 0;
}

function defaultSpawnEditor(
  editor: string,
  file: string,
): { status: number | null } {
  const result = spawnSync(editor, [file], { stdio: "inherit" });
  return { status: result.status };
}

/** Smoke helper exposed for tests / future Slack reuse. */
export function readNotesSummary(
  dataDir: string,
  vault: string,
  app: string,
): { exists: boolean; chars: number; preview: string } {
  const text = readNotes(dataDir, vault, app);
  return {
    exists: text.length > 0,
    chars: text.length,
    preview: text.slice(0, 200),
  };
}
