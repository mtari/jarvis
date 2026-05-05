import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { brainDir, brainDocsFile } from "../cli/paths.ts";

/**
 * Per-app project docs registry — `<dataDir>/vaults/<v>/brains/<app>/docs/docs.json`
 * is a JSON array of doc entries. Each entry tracks where the doc came from,
 * how it's retained (cached vs absorbed — see §7 of MASTER_PLAN), and the
 * minimal metadata agents need to reason about it.
 *
 * Two retention modes are supported by the schema:
 *   - `cached` — full content stored on disk under `docs/<id>/content.txt`.
 *     Re-loaded on demand for prompts. The reference stays useful as the doc
 *     evolves (you can `docs refresh` to re-fetch URL kinds).
 *   - `absorbed` — content extracted into the brain at the moment of add;
 *     the original is not retained. Only a stub entry remains so the audit
 *     trail records that the doc once contributed.
 *
 * The doc-system v1 (Phase 2.5 docs slice) ships cache-mode add/list/remove.
 * Absorb-mode promotion (`docs add` without `--keep`, `docs absorb`,
 * `docs reabsorb`) drafts a brain-update plan and lands in a follow-up PR.
 */

export type DocKind = "file" | "url";
export type DocRetention = "cached" | "absorbed";

const docEntrySchema = z.object({
  /** Stable slug — used for cache directory + cross-references. */
  id: z.string().min(1),
  kind: z.enum(["file", "url"]),
  retention: z.enum(["cached", "absorbed"]),
  /** Original source — absolute file path or URL. */
  source: z.string().min(1),
  /** Human-readable label. Defaults to the id at add time. */
  title: z.string(),
  tags: z.array(z.string()).default([]),
  addedAt: z.string(),
  /** One-line note. For absorbed docs, written by the absorbing flow. */
  summary: z.string().default(""),
  /** Path relative to the app's brain dir; only set for cached docs. */
  cachedFile: z.string().optional(),
  /** ISO datetime of the most recent successful refresh (cached URL docs). */
  refreshedAt: z.string().optional(),
});

export type DocEntry = z.infer<typeof docEntrySchema>;

const docIndexSchema = z.array(docEntrySchema);

export class DocsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsError";
  }
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

/**
 * Loads the doc index. Treats a missing file as an empty index — onboarding
 * always writes one, but apps brought up before the docs slice may have a
 * brain dir without `docs/docs.json`.
 *
 * Schema-invalid rows are dropped (best-effort) so a single corrupt entry
 * doesn't take the whole index offline. The valid count surfaces in any
 * caller that wants to warn.
 */
export function loadDocsIndex(
  dataDir: string,
  vault: string,
  app: string,
): DocEntry[] {
  const filePath = brainDocsFile(dataDir, vault, app);
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new DocsError(`docs.json is not valid JSON: ${filePath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new DocsError(`docs.json must be a JSON array, got ${typeof parsed}`);
  }
  const out: DocEntry[] = [];
  for (const raw of parsed) {
    const result = docEntrySchema.safeParse(raw);
    if (result.success) out.push(result.data);
    // Else drop silently — caller can re-validate via raw JSON if it cares.
  }
  return out;
}

export function saveDocsIndex(
  dataDir: string,
  vault: string,
  app: string,
  entries: ReadonlyArray<DocEntry>,
): void {
  const filePath = brainDocsFile(dataDir, vault, app);
  const validated = docIndexSchema.parse(entries);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(validated, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Cache layout
// ---------------------------------------------------------------------------

const CACHE_FILE_NAME = "content.txt";

export function cacheRelativePath(id: string): string {
  return path.posix.join("docs", id, CACHE_FILE_NAME);
}

export function cacheAbsolutePath(
  dataDir: string,
  vault: string,
  app: string,
  id: string,
): string {
  return path.join(brainDir(dataDir, vault, app), "docs", id, CACHE_FILE_NAME);
}

export function cacheDirectoryPath(
  dataDir: string,
  vault: string,
  app: string,
  id: string,
): string {
  return path.join(brainDir(dataDir, vault, app), "docs", id);
}

/**
 * Writes `content.txt` for a cached doc. Creates the per-doc directory if
 * needed. Does not write to the index — callers are responsible for
 * appending the entry afterwards (so a single transactional rewrite of
 * `docs.json` covers the new entry).
 */
export function writeCachedDocContent(
  dataDir: string,
  vault: string,
  app: string,
  id: string,
  content: string,
): void {
  const dir = cacheDirectoryPath(dataDir, vault, app, id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, CACHE_FILE_NAME), content);
}

export function readCachedDocContent(
  dataDir: string,
  vault: string,
  app: string,
  id: string,
): string | null {
  const filePath = cacheAbsolutePath(dataDir, vault, app, id);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/** Removes the per-doc cache directory if it exists. Idempotent. */
export function removeCachedDocDir(
  dataDir: string,
  vault: string,
  app: string,
  id: string,
): void {
  const dir = cacheDirectoryPath(dataDir, vault, app, id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Source loading — file + URL helpers shared with `onboard`
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DOC_BYTES = 256 * 1024;

export interface FetchedDoc {
  content: string;
  contentType?: string;
}

export type FetchUrl = (url: string) => Promise<FetchedDoc>;

export interface LoadedDoc {
  source: string;
  content: string;
  /** "file" or "url" — derived from the source. */
  kind: DocKind;
}

/**
 * Loads a doc body from a local absolute path or URL, truncated to
 * `maxBytes`. URLs go through the injected fetcher (test seam).
 */
export async function loadDocSource(
  source: string,
  fetcher: FetchUrl,
  maxBytes: number = DEFAULT_MAX_DOC_BYTES,
): Promise<LoadedDoc> {
  if (isUrl(source)) {
    const fetched = await fetcher(source);
    return {
      source,
      content: truncate(fetched.content, maxBytes, source),
      kind: "url",
    };
  }
  if (!path.isAbsolute(source)) {
    throw new DocsError(`doc path must be absolute or a URL (got "${source}")`);
  }
  if (!fs.existsSync(source)) {
    throw new DocsError(`doc not found: ${source}`);
  }
  const stat = fs.statSync(source);
  if (!stat.isFile()) {
    throw new DocsError(`doc is not a regular file: ${source}`);
  }
  const buf = fs.readFileSync(source);
  return {
    source,
    content: truncate(buf.toString("utf8"), maxBytes, source),
    kind: "file",
  };
}

export const defaultFetchUrl: FetchUrl = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new DocsError(`fetch ${url} failed: HTTP ${response.status}`);
  }
  const content = await response.text();
  const contentType = response.headers.get("content-type") ?? undefined;
  return contentType !== undefined ? { content, contentType } : { content };
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Slug derived from the source — stable across runs so re-adding the same
 * doc resolves to the same id (and the caller can detect duplicates).
 * URLs collapse to `<host>-<path>` slug; files use the basename.
 */
export function docIdFromSource(source: string): string {
  let base: string;
  if (isUrl(source)) {
    try {
      const u = new URL(source);
      base = u.hostname + u.pathname.replace(/\W+/g, "-");
    } catch {
      base = source;
    }
  } else {
    base = path.basename(source);
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "doc";
}

/**
 * Disambiguates `id` against `existing` ids by suffixing `-2`, `-3`, ...
 * Returns `id` unchanged when the slug is free.
 */
export function uniqueDocId(id: string, existing: ReadonlyArray<string>): string {
  if (!existing.includes(id)) return id;
  let suffix = 2;
  while (existing.includes(`${id}-${suffix}`)) suffix += 1;
  return `${id}-${suffix}`;
}

export function truncate(text: string, max: number, source: string): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n[truncated at ${max} bytes; original ${text.length} bytes from ${source}]`
  );
}
