import { z } from "zod";

/**
 * Umami metrics client + typed reader for `brain.connections.umami`.
 *
 * Tier 1 scope (per plan 2026-05-16-umami-metrics-collector-tier-1):
 *   - One endpoint: GET /api/websites/:id/stats?startAt&endAt → daily snapshot.
 *   - Bearer auth via UMAMI_API_TOKEN. URL via UMAMI_API_URL.
 *   - No bulk endpoints yet — the stats payload is small enough that
 *     sandbox-pattern (§13) isn't needed at this tier.
 *
 * The client throws `UmamiApiError` on any non-2xx or network failure
 * so callers (the Umami metrics collector) can catch + downgrade to a
 * low-severity signal without crashing the daemon's hourly sweep.
 *
 * Brain shape lives here too — `connections` in the brain schema is a
 * loose object (orchestrator/brain.ts) for forward-compat with ad-hoc
 * connection kinds. `readUmamiConnection(...)` Zod-validates the
 * umami-specific slot at use time. Mirrors the Facebook reader pattern
 * in `integrations/post-scheduler/service.ts`.
 */

const umamiConnectionStatusSchema = z.enum([
  "connected",
  "missing",
  "needs-refresh",
]);

const umamiConnectionSchema = z.object({
  status: umamiConnectionStatusSchema,
  scriptUrl: z.string().min(1),
  websiteId: z.string().min(1).optional(),
  appEnvVars: z.array(z.string()).optional(),
  wiredInRepoAt: z.string().optional(),
  wiredAtCommit: z.string().optional(),
  domainsAttribute: z.string().nullable().optional(),
  note: z.string().optional(),
  trackedEvents: z.array(z.string().min(1)).optional(),
});

export type UmamiConnection = z.infer<typeof umamiConnectionSchema>;

/**
 * Validates and returns the umami connection from a brain's `connections`
 * record, or null when absent or shape-invalid. Never throws — callers
 * (the collector, future post-merge observation paths) treat null as
 * "no umami wired for this app" and emit a degraded signal instead.
 */
export function readUmamiConnection(
  connections: Record<string, unknown>,
): UmamiConnection | null {
  const raw = connections["umami"];
  if (raw === undefined || raw === null) return null;
  const parsed = umamiConnectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

export interface UmamiClientOptions {
  /** Base URL of the Umami deployment, e.g. "https://umami-self-seven.vercel.app". No trailing slash required. */
  apiUrl: string;
  /** API token. Sent as `Authorization: Bearer ${apiToken}`. */
  apiToken: string;
  /** Fetch implementation (test seam). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Request timeout, ms. Default 30000. */
  timeoutMs?: number;
}

export interface UmamiStatsWindow {
  /** Start of the window, epoch ms. */
  startAt: number;
  /** End of the window, epoch ms. */
  endAt: number;
}

/**
 * Umami v2 `/api/websites/:id/stats?startAt&endAt` returns a flat object of
 * numbers — one entry per metric, value scoped to the requested window. There
 * is no built-in prior-window comparison in this endpoint; getting deltas
 * requires a second call against the previous window. Tier 1 records the
 * current-window snapshot only; Tier 2 adds the comparison call + anomaly
 * thresholds.
 */
const umamiStatsResponseSchema = z.object({
  pageviews: z.number(),
  visitors: z.number(),
  visits: z.number(),
  bounces: z.number(),
  totaltime: z.number(),
});

export type UmamiStats = z.infer<typeof umamiStatsResponseSchema>;

export interface UmamiEventCount {
  eventName: string;
  total: number;
}

// Umami /metrics?type=event returns {x: eventName, y: count}[]
const umamiEventsResponseSchema = z
  .array(z.object({ x: z.string(), y: z.number() }))
  .transform((arr) => arr.map((e) => ({ eventName: e.x, total: e.y })));

export interface UmamiClient {
  getStats(
    websiteId: string,
    window: UmamiStatsWindow,
  ): Promise<UmamiStats>;
  getEvents(
    websiteId: string,
    window: UmamiStatsWindow,
  ): Promise<UmamiEventCount[]>;
}

export class UmamiApiError extends Error {
  /** HTTP status (0 when no response, e.g. network failure or abort). */
  readonly status: number;
  /** True when the caller should treat as retryable (5xx, 429, network). */
  readonly transient: boolean;
  constructor(message: string, opts: { status: number; transient: boolean }) {
    super(message);
    this.name = "UmamiApiError";
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

export function createUmamiClient(opts: UmamiClientOptions): UmamiClient {
  if (opts.apiUrl.trim().length === 0) {
    throw new UmamiApiError("apiUrl is required", {
      status: 0,
      transient: false,
    });
  }
  if (opts.apiToken.trim().length === 0) {
    throw new UmamiApiError("apiToken is required", {
      status: 0,
      transient: false,
    });
  }
  const fetcher = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = opts.apiUrl.replace(/\/+$/, "");

  return {
    async getStats(websiteId, window) {
      if (websiteId.trim().length === 0) {
        throw new UmamiApiError("websiteId is required", {
          status: 0,
          transient: false,
        });
      }
      const url =
        `${baseUrl}/api/websites/${encodeURIComponent(websiteId)}/stats` +
        `?startAt=${window.startAt}&endAt=${window.endAt}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
      } catch (err) {
        throw new UmamiApiError(
          `network error calling Umami: ${err instanceof Error ? err.message : String(err)}`,
          { status: 0, transient: true },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const transient = response.status >= 500 || response.status === 429;
        let detail = "";
        try {
          const text = await response.text();
          detail = text.slice(0, 500);
        } catch {
          // best-effort
        }
        const hint =
          response.status === 401 || response.status === 403
            ? " (unauthenticated — check UMAMI_API_TOKEN scope)"
            : "";
        throw new UmamiApiError(
          `Umami ${response.status} ${response.statusText}${hint}: ${detail}`,
          { status: response.status, transient },
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new UmamiApiError(
          `Umami 2xx but body wasn't JSON: ${err instanceof Error ? err.message : String(err)}`,
          { status: response.status, transient: false },
        );
      }
      const parsed = umamiStatsResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new UmamiApiError(
          `Umami stats response failed schema validation: ${parsed.error.message}`,
          { status: response.status, transient: false },
        );
      }
      return parsed.data;
    },

    async getEvents(websiteId, window) {
      if (websiteId.trim().length === 0) {
        throw new UmamiApiError("websiteId is required", {
          status: 0,
          transient: false,
        });
      }
      const url =
        `${baseUrl}/api/websites/${encodeURIComponent(websiteId)}/metrics` +
        `?type=event&startAt=${window.startAt}&endAt=${window.endAt}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
      } catch (err) {
        throw new UmamiApiError(
          `network error calling Umami events: ${err instanceof Error ? err.message : String(err)}`,
          { status: 0, transient: true },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const transient = response.status >= 500 || response.status === 429;
        let detail = "";
        try {
          const text = await response.text();
          detail = text.slice(0, 500);
        } catch {
          // best-effort
        }
        const hint =
          response.status === 401 || response.status === 403
            ? " (unauthenticated — check UMAMI_API_TOKEN scope)"
            : "";
        throw new UmamiApiError(
          `Umami events ${response.status} ${response.statusText}${hint}: ${detail}`,
          { status: response.status, transient },
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new UmamiApiError(
          `Umami events 2xx but body wasn't JSON: ${err instanceof Error ? err.message : String(err)}`,
          { status: response.status, transient: false },
        );
      }
      const parsed = umamiEventsResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new UmamiApiError(
          `Umami events response failed schema validation: ${parsed.error.message}`,
          { status: response.status, transient: false },
        );
      }
      return parsed.data;
    },
  };
}
