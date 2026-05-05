import fs from "node:fs";
import { businessIdeasFile } from "../cli/paths.ts";

/**
 * `Business_Ideas.md` — user-authored input for Scout. A markdown file
 * at `<dataDir>/Business_Ideas.md` holding one idea per `## ` section.
 * Scout reads it, scores promising candidates, and writes the score +
 * rationale back into the same section so future runs can dedupe and
 * the user can see why each idea ranked where it did.
 *
 * Format:
 *
 *     # Business Ideas
 *
 *     (any preamble — ignored by the parser)
 *
 *     ## <title>
 *     App: <app-name | "new">
 *     Tags: <comma-separated>
 *     Brief: <one-line description>
 *     Score: <0-100>             # optional, set by Scout
 *     ScoredAt: <ISO datetime>   # optional, set by Scout
 *     Rationale: <one line>      # optional, set by Scout
 *
 *     <free-form prose body — optional>
 *
 *     ## <next title>
 *     ...
 *
 * Field rules:
 *   - `App` and `Brief` are required. Missing either → the section is
 *     skipped with an entry in `unparseable` so the user can fix it.
 *   - `Tags` is optional; comma-separated, whitespace-trimmed.
 *   - `Score` must parse as an integer in [0, 100] when present.
 *   - Order of meta fields doesn't matter.
 *   - The body starts after the first blank line that follows the meta
 *     block. Lines that look like `Key: value` inside the body are kept
 *     verbatim (we stop reading meta at the first blank line).
 */

export interface BusinessIdea {
  /** Slugified title — stable across runs. Used as a record id. */
  id: string;
  title: string;
  /** Target app name, or "new" for a not-yet-built app. */
  app: string;
  brief: string;
  tags: string[];
  /** Set after Scout scores it. */
  score?: number;
  scoredAt?: string;
  rationale?: string;
  /** Free-form prose after the meta block. Empty string if absent. */
  body: string;
}

export interface UnparseableIdea {
  /** The raw section heading (whatever followed `## `). */
  heading: string;
  reason: string;
}

export interface BusinessIdeasFile {
  ideas: BusinessIdea[];
  unparseable: UnparseableIdea[];
}

/**
 * Loads + parses `Business_Ideas.md`. If the file doesn't exist returns
 * `{ ideas: [], unparseable: [] }`. Read errors propagate.
 */
export function loadBusinessIdeas(dataDir: string): BusinessIdeasFile {
  const filePath = businessIdeasFile(dataDir);
  if (!fs.existsSync(filePath)) {
    return { ideas: [], unparseable: [] };
  }
  const text = fs.readFileSync(filePath, "utf8");
  return parseBusinessIdeas(text);
}

/**
 * Parses the markdown text directly. Exported for unit tests so we
 * don't need a temp file for every assertion.
 */
export function parseBusinessIdeas(text: string): BusinessIdeasFile {
  const sections = splitSections(text);
  const ideas: BusinessIdea[] = [];
  const unparseable: UnparseableIdea[] = [];
  const seenIds = new Set<string>();

  for (const section of sections) {
    const result = parseSection(section);
    if (result.kind === "error") {
      unparseable.push({ heading: section.heading, reason: result.reason });
      continue;
    }
    let id = result.idea.id;
    // Disambiguate duplicate slugs by suffixing -2, -3, ... so
    // dedup-by-id stays meaningful even when titles collide.
    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    seenIds.add(id);
    ideas.push({ ...result.idea, id });
  }

  return { ideas, unparseable };
}

interface RawSection {
  heading: string;
  body: string;
}

/**
 * Splits the document on `^## ` headings. Anything before the first
 * `## ` is the preamble and is dropped.
 */
function splitSections(text: string): RawSection[] {
  const lines = text.split(/\r?\n/);
  const sections: RawSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(/^##\s+(.*)$/);
    if (match) {
      if (current) {
        sections.push({
          heading: current.heading,
          body: current.lines.join("\n"),
        });
      }
      current = { heading: match[1]!.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push({
      heading: current.heading,
      body: current.lines.join("\n"),
    });
  }
  return sections;
}

type ParseSectionResult =
  | { kind: "ok"; idea: BusinessIdea }
  | { kind: "error"; reason: string };

function parseSection(section: RawSection): ParseSectionResult {
  if (section.heading.length === 0) {
    return { kind: "error", reason: "section heading is empty" };
  }
  // Any line through the first blank line is part of the meta block.
  const lines = section.body.split("\n");
  const metaLines: string[] = [];
  let bodyStartIdx = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "") {
      bodyStartIdx = i + 1;
      break;
    }
    metaLines.push(lines[i]!);
  }
  const body = lines.slice(bodyStartIdx).join("\n").trim();

  const meta = parseMeta(metaLines);
  if (meta.app === undefined) {
    return { kind: "error", reason: "missing required field: App" };
  }
  if (meta.brief === undefined) {
    return { kind: "error", reason: "missing required field: Brief" };
  }
  if (
    meta.scoreRaw !== undefined &&
    (meta.score === undefined || !isValidScore(meta.score))
  ) {
    return {
      kind: "error",
      reason: `Score must be an integer in [0, 100], got "${meta.scoreRaw}"`,
    };
  }

  const idea: BusinessIdea = {
    id: slugify(section.heading),
    title: section.heading,
    app: meta.app,
    brief: meta.brief,
    tags: meta.tags ?? [],
    body,
    ...(meta.score !== undefined && { score: meta.score }),
    ...(meta.scoredAt !== undefined && { scoredAt: meta.scoredAt }),
    ...(meta.rationale !== undefined && { rationale: meta.rationale }),
  };
  return { kind: "ok", idea };
}

interface ParsedMeta {
  app?: string;
  brief?: string;
  tags?: string[];
  score?: number;
  scoreRaw?: string;
  scoredAt?: string;
  rationale?: string;
}

function parseMeta(metaLines: ReadonlyArray<string>): ParsedMeta {
  const out: ParsedMeta = {};
  for (const raw of metaLines) {
    const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    switch (key) {
      case "app":
        out.app = value;
        break;
      case "brief":
        out.brief = value;
        break;
      case "tags":
        out.tags = value
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        break;
      case "score": {
        out.scoreRaw = value;
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.score = n;
        break;
      }
      case "scoredat":
        out.scoredAt = value;
        break;
      case "rationale":
        out.rationale = value;
        break;
      default:
        // Unknown keys are ignored — keeps the format forward-compatible.
        break;
    }
  }
  return out;
}

function isValidScore(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 100;
}

/**
 * Lowercase, replace non-alphanumerics with `-`, collapse runs, trim. A
 * stable id derived from the title — two ideas with the same title in
 * the same file get disambiguated at the caller (`-2`, `-3`, ...).
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
