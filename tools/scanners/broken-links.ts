import fs from "node:fs";
import path from "node:path";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
} from "./types.ts";

/**
 * Broken-links collector. Walks every Markdown file under the app's
 * cwd, extracts outbound HTTP(S) URLs, and emits one signal per URL
 * that responds with 4xx/5xx or fails to resolve.
 *
 * Scope (Phase 2 entry):
 * - Only Markdown (`.md`, `.mdx`) for now. Rendered HTML is out of scope
 *   without a browser; lighthouse covers that surface separately.
 * - Skips `.git/`, `node_modules/`, `dist/`, `build/`, `.next/`,
 *   `coverage/`, `.turbo/`, and `jarvis-data/`.
 * - Each URL is HEAD-checked once with a 5s timeout and a small
 *   concurrency cap; if HEAD returns 405 we retry with GET.
 * - Severity:
 *     5xx              → high
 *     4xx (404 / 410)  → medium
 *     other failure    → low (could be transient)
 *
 * dedupKey = `broken-links:<url>` so the same broken URL across many
 * files dedupes into one auto-drafted plan.
 */

interface BrokenLinksOptions {
  /** Per-request timeout. Default 5_000 ms. */
  timeoutMs?: number;
  /** Max concurrent requests. Default 5. */
  concurrency?: number;
  /**
   * Override the fetch implementation. Tests inject a fake; production
   * uses the global `fetch`.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Override the file walker. Tests inject a fixed file map; production
   * walks `cwd` recursively.
   */
  walkFn?: (cwd: string) => Iterable<string>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 5;

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

/** Test seam: build a configurable instance. Production uses the default below. */
export function createBrokenLinksCollector(
  opts: BrokenLinksOptions = {},
): SignalCollector {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const walkFn = opts.walkFn ?? walkMarkdownFiles;

  return {
    kind: "broken-links",
    description:
      "Walks Markdown for outbound URLs and reports 4xx/5xx/unreachable links.",
    async collect(ctx: CollectorContext): Promise<Signal[]> {
      const urls = collectUrls(ctx.cwd, walkFn);
      if (urls.size === 0) return [];

      const queue = [...urls];
      const signals: Signal[] = [];
      const workers: Promise<void>[] = [];
      const limit = Math.min(concurrency, queue.length);

      for (let i = 0; i < limit; i += 1) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              const url = queue.shift();
              if (url === undefined) break;
              const result = await checkUrl(url, fetchFn, timeoutMs);
              if (result !== null) signals.push(result);
            }
          })(),
        );
      }
      await Promise.all(workers);
      return signals;
    },
  };
}

const brokenLinksCollector: SignalCollector = createBrokenLinksCollector();
export default brokenLinksCollector;

// ---------------------------------------------------------------------------
// Internals — exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * Walks the given directory and yields paths of every Markdown file.
 * Skips known build / vendor / VCS directories.
 */
export function* walkMarkdownFiles(cwd: string): Iterable<string> {
  const stack: string[] = [cwd];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && MARKDOWN_EXTS.has(path.extname(e.name))) {
        yield full;
      }
    }
  }
}

/** Collects unique outbound URLs from every Markdown file under `cwd`. */
function collectUrls(
  cwd: string,
  walk: (cwd: string) => Iterable<string>,
): Set<string> {
  const urls = new Set<string>();
  for (const file of walk(cwd)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const url of extractUrls(text)) urls.add(url);
  }
  return urls;
}

/**
 * Extracts outbound HTTP(S) URLs from a Markdown chunk. Catches three
 * common shapes:
 *   1. `[label](https://example.com/path)`
 *   2. Bare `<https://example.com>`
 *   3. Plain inline URLs that aren't already inside `[…](…)` parens
 *      (e.g., a footnote line ending in a URL).
 *
 * Anchors (`#section`), relative paths, mailto:, javascript:, and URLs
 * with embedded localhost/127.x are skipped — they're either not
 * fetchable or not "outbound" in the way this collector cares about.
 */
export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  const linkPattern = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
  for (const match of text.matchAll(linkPattern)) {
    let url = match[0];
    // Strip trailing punctuation that often follows URLs in prose.
    url = url.replace(/[.,;:!?)\]]+$/, "");
    if (shouldSkipUrl(url)) continue;
    out.add(url);
  }
  return [...out];
}

function shouldSkipUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  // Loopback / private nets — not worth fetching from a daemon.
  const hostMatch = url.match(/^https?:\/\/([^/:?#]+)/i);
  const host = hostMatch?.[1]?.toLowerCase() ?? "";
  if (host === "localhost") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host === "0.0.0.0") return true;
  return false;
}

interface UrlCheckResult {
  status: number;
  /** Set when the network call itself failed (DNS, timeout, etc.). */
  networkError?: string;
}

/**
 * Issues a HEAD request (with one GET fallback for `405 Method Not Allowed`).
 * Returns a Signal when the URL is broken, null when it's fine.
 */
async function checkUrl(
  url: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Signal | null> {
  const head = await tryFetch(url, "HEAD", fetchFn, timeoutMs);
  let result = head;
  // Some servers (and CDN edges) return 405 for HEAD; retry with GET.
  if (head.status === 405) {
    result = await tryFetch(url, "GET", fetchFn, timeoutMs);
  }

  if (result.networkError !== undefined) {
    return {
      kind: "broken-links",
      severity: "low",
      summary: `unreachable: ${url}`,
      details: { url, error: result.networkError },
      dedupKey: `broken-links:${url}`,
    };
  }
  if (result.status >= 500) {
    return {
      kind: "broken-links",
      severity: "high",
      summary: `${result.status} server error: ${url}`,
      details: { url, status: result.status },
      dedupKey: `broken-links:${url}`,
    };
  }
  if (result.status >= 400) {
    return {
      kind: "broken-links",
      severity: "medium",
      summary: `${result.status} client error: ${url}`,
      details: { url, status: result.status },
      dedupKey: `broken-links:${url}`,
    };
  }
  return null;
}

async function tryFetch(
  url: string,
  method: "HEAD" | "GET",
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<UrlCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
    });
    return { status: response.status };
  } catch (err) {
    return {
      status: -1,
      networkError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
