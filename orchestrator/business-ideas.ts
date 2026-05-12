import fs from "node:fs";
import { businessIdeasFile } from "../cli/paths.ts";
import { atomicWriteFileSync } from "./atomic-write.ts";

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
  /**
   * Text before the first `## ` heading. Captured on parse so we can
   * round-trip user-authored intro / instructions / docs.
   */
  preamble: string;
}

/**
 * Loads + parses `Business_Ideas.md`. If the file doesn't exist returns
 * `{ ideas: [], unparseable: [] }`. Read errors propagate.
 */
export function loadBusinessIdeas(dataDir: string): BusinessIdeasFile {
  const filePath = businessIdeasFile(dataDir);
  if (!fs.existsSync(filePath)) {
    return { ideas: [], unparseable: [], preamble: "" };
  }
  const text = fs.readFileSync(filePath, "utf8");
  return parseBusinessIdeas(text);
}

/**
 * Atomic-writes the file back, preserving the original preamble.
 * Drops `unparseable` entries — those came from sections we couldn't
 * parse, and re-emitting their headings without context would be
 * worse than leaving them out. The user sees them via the load result.
 */
export function saveBusinessIdeas(
  dataDir: string,
  file: BusinessIdeasFile,
): void {
  atomicWriteFileSync(businessIdeasFile(dataDir), formatBusinessIdeas(file));
}

export function formatBusinessIdeas(file: BusinessIdeasFile): string {
  let out = "";
  if (file.preamble.length > 0) {
    out += file.preamble.replace(/\n+$/, "") + "\n\n";
  }
  for (const idea of file.ideas) {
    out += renderIdeaSection(idea);
  }
  return out;
}

/** Renders one section, including its trailing blank-line separator. */
export function renderIdeaSection(idea: BusinessIdea): string {
  const lines: string[] = [];
  lines.push(`## ${idea.title}`);
  lines.push(`App: ${idea.app}`);
  lines.push(`Brief: ${idea.brief}`);
  if (idea.tags.length > 0) {
    lines.push(`Tags: ${idea.tags.join(", ")}`);
  }
  if (idea.score !== undefined) {
    lines.push(`Score: ${idea.score}`);
  }
  if (idea.scoredAt !== undefined) {
    lines.push(`ScoredAt: ${idea.scoredAt}`);
  }
  if (idea.rationale !== undefined) {
    lines.push(`Rationale: ${idea.rationale}`);
  }
  if (idea.body.length > 0) {
    lines.push("");
    lines.push(idea.body);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Parses the markdown text directly. Exported for unit tests so we
 * don't need a temp file for every assertion.
 */
export function parseBusinessIdeas(text: string): BusinessIdeasFile {
  const { preamble, sections } = splitSections(text);
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

  return { ideas, unparseable, preamble };
}

interface RawSection {
  heading: string;
  body: string;
}

/**
 * Splits the document on `^## ` headings. Lines before the first
 * `## ` become the preamble (preserved verbatim for round-tripping).
 */
function splitSections(text: string): {
  preamble: string;
  sections: RawSection[];
} {
  const lines = text.split(/\r?\n/);
  const preambleLines: string[] = [];
  const sections: RawSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let inPreamble = true;
  for (const line of lines) {
    const match = line.match(/^##\s+(.*)$/);
    if (match) {
      inPreamble = false;
      if (current) {
        sections.push({
          heading: current.heading,
          body: current.lines.join("\n"),
        });
      }
      current = { heading: match[1]!.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (inPreamble) {
      preambleLines.push(line);
    }
  }
  if (current) {
    sections.push({
      heading: current.heading,
      body: current.lines.join("\n"),
    });
  }
  return { preamble: preambleLines.join("\n"), sections };
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

export type FindIdeaByQueryResult =
  | { kind: "exact"; idea: BusinessIdea }
  | { kind: "multiple"; candidates: BusinessIdea[] }
  | { kind: "none" };

export function findIdeaByQuery(
  file: BusinessIdeasFile,
  rawQuery: string,
): FindIdeaByQueryResult {
  const query = rawQuery.replace(/["“”‘’]/g, "").trim();
  if (query.length === 0) return { kind: "none" };

  const exactId = file.ideas.find((i) => i.id === query);
  if (exactId) return { kind: "exact", idea: exactId };

  const ciId = file.ideas.find((i) => i.id.toLowerCase() === query.toLowerCase());
  if (ciId) return { kind: "exact", idea: ciId };

  const q = query.toLowerCase();
  const matches = file.ideas.filter((i) => i.title.toLowerCase().includes(q));
  if (matches.length === 1) return { kind: "exact", idea: matches[0]! };
  if (matches.length > 1) return { kind: "multiple", candidates: matches.slice(0, 10) };
  return { kind: "none" };
}

export class IdeaSectionParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "IdeaSectionParseError";
  }
}

/**
 * Parses a single `## <title>` section from `text` and returns the
 * `BusinessIdea`. Throws `IdeaSectionParseError` if the text cannot be
 * parsed (missing heading, missing required field, bad Score, etc.).
 *
 * Delegates to `parseBusinessIdeas` so the same field rules apply.
 */
export function parseIdeaSection(text: string): BusinessIdea {
  const { ideas, unparseable } = parseBusinessIdeas(text);
  if (ideas[0] !== undefined) return ideas[0];
  if (unparseable[0] !== undefined) throw new IdeaSectionParseError(unparseable[0].reason);
  throw new IdeaSectionParseError(
    'no idea section found — ensure the text starts with a ## heading',
  );
}
