import type { ChannelAdapter, PublishInput, PublishResult } from "./types.ts";

/**
 * Facebook channel adapter — posts to a Facebook Page via the Graph API.
 *
 * Auth model: a long-lived **Page Access Token** (60 days, renewable)
 * scoped to one Page. The user generates it once via the Meta
 * Developer console (or the Graph API Explorer) and drops it in
 * `<dataDir>/.env` as `FB_PAGE_ACCESS_TOKEN` plus `FB_PAGE_ID` for
 * the target Page id. See `tools/channels/README.md` for the
 * step-by-step setup.
 *
 * v1 publishes text-only posts via `POST /{page-id}/feed`. Image/video
 * uploads (separate `/photos` / `/videos` endpoints with attached
 * binary) land when the first plan needs them — the parser already
 * captures `Assets:` so the adapter can read them.
 *
 * Errors map to `PublishResult`:
 *   - 2xx → `ok: true`, `publishedId: response.id`
 *   - 5xx, 429, network → `ok: false`, `transient: true` (caller may retry)
 *   - 4xx (token, permission, invalid Page id) → `ok: false`, `transient: false`
 */

export const DEFAULT_GRAPH_API_VERSION = "v19.0";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FacebookAdapterOptions {
  /** Page id Jarvis posts to (e.g. "1234567890" or "yourpagename"). */
  pageId: string;
  /** Long-lived Page Access Token. Read from FB_PAGE_ACCESS_TOKEN. */
  accessToken: string;
  /** Override Graph API version. Defaults to v19.0. */
  graphApiVersion?: string;
  /** Override fetch (test seam). Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Override request timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** When true, never POSTs — returns ok:true with a synthetic id. */
  dryRun?: boolean;
}

export class FacebookAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacebookAdapterError";
  }
}

export function createFacebookAdapter(
  opts: FacebookAdapterOptions,
): ChannelAdapter {
  if (opts.pageId.trim().length === 0) {
    throw new FacebookAdapterError("pageId is required");
  }
  if (opts.accessToken.trim().length === 0) {
    throw new FacebookAdapterError("accessToken is required");
  }
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = opts.fetcher ?? fetch;

  return {
    channels: ["facebook"],
    async publish(input: PublishInput): Promise<PublishResult> {
      if (input.assets.length > 0) {
        // v1 doesn't yet upload assets. Fail loud rather than silently
        // posting a text-only version of something that should have
        // images.
        return {
          ok: false,
          reason: `Facebook adapter v1 supports text-only posts; got ${input.assets.length} asset(s). Image/video upload lands in a follow-up.`,
        };
      }
      if (opts.dryRun === true) {
        return {
          ok: true,
          publishedId: `fb-dryrun-${input.postId}`,
        };
      }
      const url = `https://graph.facebook.com/${version}/${encodeURIComponent(opts.pageId)}/feed`;
      const body = new URLSearchParams({
        message: input.content,
        access_token: opts.accessToken,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          body,
          signal: controller.signal,
        });
      } catch (err) {
        return {
          ok: false,
          reason: `network error posting to FB: ${err instanceof Error ? err.message : String(err)}`,
          transient: true,
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        try {
          const json = (await response.json()) as { id?: string };
          if (typeof json.id === "string") {
            return { ok: true, publishedId: json.id };
          }
          return {
            ok: false,
            reason: `FB returned 2xx but no post id in body: ${JSON.stringify(json).slice(0, 200)}`,
          };
        } catch (err) {
          return {
            ok: false,
            reason: `FB 2xx but body wasn't JSON: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      // Map status to transient flag. 5xx + 429 retryable; 4xx not.
      const transient = response.status >= 500 || response.status === 429;
      let detail = "";
      try {
        const text = await response.text();
        detail = text.slice(0, 500);
      } catch {
        // best-effort
      }
      return {
        ok: false,
        reason: `FB ${response.status} ${response.statusText}: ${detail}`,
        transient,
      };
    },
  };
}

/**
 * Reads FB credentials from process.env. Returns `null` when either
 * variable is missing, so callers can register the adapter only when
 * both are present.
 */
export interface FacebookEnvConfig {
  pageId: string;
  accessToken: string;
}

export function readFacebookEnv(
  env: NodeJS.ProcessEnv = process.env,
): FacebookEnvConfig | null {
  const pageId = env["FB_PAGE_ID"];
  const accessToken = env["FB_PAGE_ACCESS_TOKEN"];
  if (
    pageId === undefined ||
    pageId.trim().length === 0 ||
    accessToken === undefined ||
    accessToken.trim().length === 0
  ) {
    return null;
  }
  return { pageId: pageId.trim(), accessToken: accessToken.trim() };
}
