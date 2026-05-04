import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
  SignalSeverity,
} from "./types.ts";

/**
 * Content-freshness collector. Walks Markdown files under the app's
 * cwd and emits one signal per file whose last-modified time exceeds
 * the configured staleness threshold.
 *
 * Last-modified time comes from `git log -1 --format=%ct` (commit time),
 * which is more meaningful than mtime — `git checkout` resets mtime to
 * checkout time, so an mtime-based scanner would always look fresh.
 * Fallback to fs.stat mtime if the file isn't tracked by git or git
 * isn't available.
 *
 * Scope (Phase 2):
 * - Only Markdown (`.md`, `.mdx`).
 * - Skips meta files (README, CHANGELOG, LICENSE, CONTRIBUTING, CLAUDE,
 *   AGENTS) at any depth — those are intentionally evergreen.
 * - Skips `.git/`, `node_modules/`, `dist/`, `build/`, `.next/`,
 *   `coverage/`, `.turbo/`, `jarvis-data/`, `.cache/`.
 * - Severity bands (relative to staleDays threshold, default 365):
 *     1x–2x  → low
 *     2x–3x  → medium
 *     >3x    → high
 *
 * dedupKey = `content-freshness:<relpath>` so a stale file dedupes
 * across hourly sweeps until it's touched.
 */

interface ContentFreshnessOptions {
  /** Days before content is considered stale. Default 365. */
  staleDays?: number;
  /**
   * Override the file walker. Tests inject a fixed file list; production
   * walks `cwd` recursively for content Markdown files.
   */
  walkFn?: (cwd: string) => Iterable<string>;
  /**
   * Override how last-modified time is read (epoch seconds). Tests inject
   * a fixed map; production uses `git log` with fs.stat fallback.
   */
  getLastModified?: (absPath: string, cwd: string) => number | null;
  /**
   * Override "now" for deterministic tests. Production uses real wall
   * clock at the start of each `collect()` call.
   */
  now?: () => Date;
}

const DEFAULT_STALE_DAYS = 365;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "jarvis-data",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
]);

const MARKDOWN_EXTS = new Set([".md", ".mdx"]);

const META_FILE_STEMS = new Set([
  "readme",
  "changelog",
  "license",
  "contributing",
  "claude",
  "agents",
  "code_of_conduct",
  "security",
]);

/** Test seam: build a configurable instance. Production uses the default below. */
export function createContentFreshnessCollector(
  opts: ContentFreshnessOptions = {},
): SignalCollector {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const walkFn = opts.walkFn ?? walkContentMarkdownFiles;
  const getLastModified = opts.getLastModified ?? gitOrFsLastModified;
  const now = opts.now ?? (() => new Date());

  return {
    kind: "content-freshness",
    description:
      "Flags Markdown files that haven't been updated within a staleness threshold.",
    async collect(ctx: CollectorContext): Promise<Signal[]> {
      const signals: Signal[] = [];
      const nowMs = now().getTime();

      for (const abs of walkFn(ctx.cwd)) {
        const epochSec = getLastModified(abs, ctx.cwd);
        if (epochSec === null) continue;
        const ageDays = Math.floor((nowMs - epochSec * 1000) / MS_PER_DAY);
        if (ageDays < staleDays) continue;
        const rel = path.relative(ctx.cwd, abs);
        signals.push({
          kind: "content-freshness",
          severity: severityForAge(ageDays, staleDays),
          summary: `${rel} not updated in ${ageDays}d (threshold ${staleDays}d)`,
          details: {
            file: rel,
            ageDays,
            lastModifiedEpochSec: epochSec,
            staleDays,
          },
          dedupKey: `content-freshness:${rel}`,
        });
      }
      return signals;
    },
  };
}

const contentFreshnessCollector: SignalCollector =
  createContentFreshnessCollector();
export default contentFreshnessCollector;

// ---------------------------------------------------------------------------
// Internals — exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * Walks `cwd` recursively and yields absolute paths of every Markdown
 * file that's a candidate for freshness checking. Skips build/vendor
 * directories and meta files (README, CHANGELOG, etc.).
 */
export function* walkContentMarkdownFiles(cwd: string): Iterable<string> {
  const stack: string[] = [cwd];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && isContentMarkdownFile(e.name)) {
        yield full;
      }
    }
  }
}

function isContentMarkdownFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (!MARKDOWN_EXTS.has(ext)) return false;
  const stem = path.basename(filename, ext).toLowerCase();
  if (META_FILE_STEMS.has(stem)) return false;
  return true;
}

/**
 * Last-modified epoch seconds. Tries `git log -1 --format=%ct` first;
 * falls back to fs.stat mtime if the file isn't tracked or git isn't
 * available. Returns null if the file can't be stat'd at all.
 */
export function gitOrFsLastModified(
  absPath: string,
  cwd: string,
): number | null {
  const gitTime = readGitCommitTime(absPath, cwd);
  if (gitTime !== null) return gitTime;
  try {
    const stat = fs.statSync(absPath);
    return Math.floor(stat.mtimeMs / 1000);
  } catch {
    return null;
  }
}

function readGitCommitTime(absPath: string, cwd: string): number | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", absPath],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out === "") return null;
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function severityForAge(
  ageDays: number,
  staleDays: number,
): SignalSeverity {
  const ratio = ageDays / staleDays;
  if (ratio >= 3) return "high";
  if (ratio >= 2) return "medium";
  return "low";
}
