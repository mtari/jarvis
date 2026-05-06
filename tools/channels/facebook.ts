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
 * Routing by asset count + type:
 *   - 0 assets       → POST /{page-id}/feed   { message }
 *   - 1 image URL    → POST /{page-id}/photos { url, caption }
 *   - 1 video URL    → POST /{page-id}/videos { file_url, description }
 *   - 1 unknown URL  → POST /{page-id}/photos (image is the FB default)
 *   - >1 asset       → fail loud (multi-image attached_media flow lands later)
 *   - non-URL asset  → fail loud (multipart upload of local files lands later)
 *
 * Errors map to `PublishResult`:
 *   - 2xx → `ok: true`, `publishedId: response.id`
 *   - 5xx, 429, network → `ok: false`, `transient: true` (caller may retry)
 *   - 4xx (token, permission, invalid Page id) → `ok: false`, `transient: false`
 */

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"] as const;
const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".m4v"] as const;

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
      const route = chooseEndpoint(input.assets);
      if (!route.ok) {
        return { ok: false, reason: route.reason };
      }
      if (opts.dryRun === true) {
        return {
          ok: true,
          publishedId: `fb-dryrun-${input.postId}`,
        };
      }
      const baseUrl = `https://graph.facebook.com/${version}/${encodeURIComponent(opts.pageId)}/${route.endpoint}`;
      const body = new URLSearchParams({
        access_token: opts.accessToken,
        ...route.fields,
      });
      // The user's authored caption / description / message goes on
      // the field that matches the endpoint. Keep the content trimmed
      // — Graph API rejects oversized URL-encoded posts.
      body.set(route.contentField, input.content);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(baseUrl, {
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
          const json = (await response.json()) as {
            id?: string;
            post_id?: string;
          };
          // /photos returns both `id` (photo id) and `post_id` (the
          // post the photo was attached to). Prefer `post_id` since
          // that's what the operator sees as a post in FB.
          const publishedId = json.post_id ?? json.id;
          if (typeof publishedId === "string") {
            return { ok: true, publishedId };
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

interface RouteOk {
  ok: true;
  /** Graph API endpoint suffix — `feed`, `photos`, or `videos`. */
  endpoint: "feed" | "photos" | "videos";
  /** Field name carrying the user's content (`message` / `caption` / `description`). */
  contentField: "message" | "caption" | "description";
  /** Extra fields to include in the POST body (e.g. `url`, `file_url`). */
  fields: Record<string, string>;
}
interface RouteFail {
  ok: false;
  reason: string;
}

/**
 * Pure routing: picks the Graph API endpoint + body fields based on
 * the asset list. See module header for the full table.
 */
export function chooseEndpoint(
  assets: ReadonlyArray<string>,
): RouteOk | RouteFail {
  if (assets.length === 0) {
    return { ok: true, endpoint: "feed", contentField: "message", fields: {} };
  }
  if (assets.length > 1) {
    return {
      ok: false,
      reason: `Facebook adapter v1 supports a single asset; got ${assets.length}. Multi-image attached_media lands in a follow-up.`,
    };
  }
  const asset = assets[0]!;
  if (!isHttpUrl(asset)) {
    return {
      ok: false,
      reason: `Facebook adapter v1 only accepts HTTP(S) asset URLs; got "${asset}". Multipart upload of local files lands in a follow-up.`,
    };
  }
  const kind = classifyAsset(asset);
  if (kind === "video") {
    return {
      ok: true,
      endpoint: "videos",
      contentField: "description",
      fields: { file_url: asset },
    };
  }
  // Default to image for known image extensions AND unknown extensions
  // (FB's default attachment is a photo; using /photos for an unknown
  // URL fails clean rather than silently dropping the asset).
  return {
    ok: true,
    endpoint: "photos",
    contentField: "caption",
    fields: { url: asset },
  };
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function classifyAsset(url: string): "image" | "video" | "unknown" {
  const lower = url.toLowerCase();
  // Strip query string + fragment before extension match.
  const cleaned = lower.split("?")[0]!.split("#")[0]!;
  if (VIDEO_EXTS.some((ext) => cleaned.endsWith(ext))) return "video";
  if (IMAGE_EXTS.some((ext) => cleaned.endsWith(ext))) return "image";
  return "unknown";
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
