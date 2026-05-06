/**
 * Channel adapter contract — what the post-publisher uses to actually
 * push a post to an external surface (FB, IG, X, LinkedIn, newsletter,
 * blog). Each real adapter wraps the platform's API + auth; the
 * v1 stub (`tools/channels/file-stub.ts`) just appends to a JSONL
 * file under sandbox so the daemon scheduler tick can be exercised
 * end-to-end before the real wrappers ship.
 *
 * The publisher (`orchestrator/post-publisher.ts`) dispatches by
 * `(channel, appId)` via a `ChannelAdapterRegistry`. Per-app
 * registrations (a Facebook adapter scoped to a specific Page) win
 * over fallbacks (a legacy global FB env-var registration); fallbacks
 * win over nothing. Channels with no registered adapter at all cause
 * the row to be marked `failed` with a "no adapter" reason — fail
 * loud rather than silently dropping posts.
 */

export interface PublishInput {
  /** `scheduled_posts.id` — passed through for adapter audit logging. */
  postId: string;
  /** `scheduled_posts.plan_id` — likewise. */
  planId: string;
  /** `scheduled_posts.app_id`. */
  appId: string;
  /** Already-humanized post body. */
  content: string;
  /** Asset references (e.g. file paths or URLs the platform should attach). */
  assets: ReadonlyArray<string>;
  /** Channel id (e.g. "facebook") — useful for stub adapters that handle many. */
  channel: string;
}

export type PublishResult =
  | {
      ok: true;
      /** Platform-side post id (Facebook permalink id, Tweet id, etc.). */
      publishedId: string;
      /** Optional URL to the published post. */
      url?: string;
    }
  | {
      ok: false;
      /** Free-form failure description; persisted to `scheduled_posts.failure_reason`. */
      reason: string;
      /** True when the failure looks transient (retryable). */
      transient?: boolean;
    };

export interface ChannelAdapter {
  /**
   * Channels this adapter is registered for. The registry indexes by
   * channel (and optionally appId) — the same adapter can serve
   * multiple channels (e.g. the stub serves all of them).
   */
  channels: ReadonlyArray<string>;
  /**
   * Publishes one post. Adapters MUST be idempotent against the same
   * `postId` — the publisher only calls publish() for rows in
   * status=pending, but a crash mid-publish could re-enter, so the
   * adapter should detect "already published" if the platform
   * supports it and return the existing id.
   */
  publish(input: PublishInput): Promise<PublishResult>;
}

/**
 * One entry in the channel-adapter registry. `appId` undefined means
 * the entry is a *fallback* — used for any post on this adapter's
 * channels that doesn't have a per-app match. `appId` set scopes the
 * entry to that single app's posts.
 */
export interface RegisteredAdapter {
  adapter: ChannelAdapter;
  /** Undefined → fallback (catch-all). Set → only handles this app's posts. */
  appId?: string;
  /** Diagnostic name surfaced in start-up logs. e.g. "facebook:erdei". */
  name: string;
}

/** Read-only view of what's wired in the registry; used in start-up logs. */
export interface RegistryDescription {
  channel: string;
  /** Undefined when the entry is a fallback for the channel. */
  appId?: string;
  adapterName: string;
}

export interface ChannelAdapterRegistry {
  /**
   * Returns the adapter that should handle a `(channel, appId)` post,
   * or `null` when no adapter is registered. Lookup priority:
   *   1. per-app match
   *   2. fallback for the channel
   *   3. null
   */
  get(channel: string, appId: string): ChannelAdapter | null;
  /** Union of channels covered by per-app adapters and/or a fallback. */
  channels(): ReadonlySet<string>;
  /** Flat description of every registered entry. Stable for snapshots. */
  describe(): RegistryDescription[];
}

/**
 * Builds the registry. Within a priority tier, last-wins:
 *  - Two fallbacks for the same channel → the later one is used.
 *  - Two per-app entries for the same `(channel, appId)` → the later
 *    one is used.
 *
 * The split between fallback and per-app is by `appId` presence, not
 * by registration order — a fallback registered before a per-app
 * entry still loses to that per-app entry for the matching app.
 */
export function buildAdapterRegistry(
  registered: ReadonlyArray<RegisteredAdapter>,
): ChannelAdapterRegistry {
  const perApp = new Map<string, Map<string, RegisteredAdapter>>();
  const fallback = new Map<string, RegisteredAdapter>();
  for (const entry of registered) {
    for (const channel of entry.adapter.channels) {
      if (entry.appId !== undefined) {
        let byApp = perApp.get(channel);
        if (!byApp) {
          byApp = new Map();
          perApp.set(channel, byApp);
        }
        byApp.set(entry.appId, entry);
      } else {
        fallback.set(channel, entry);
      }
    }
  }
  return {
    get(channel, appId) {
      const direct = perApp.get(channel)?.get(appId)?.adapter;
      if (direct) return direct;
      return fallback.get(channel)?.adapter ?? null;
    },
    channels() {
      const set = new Set<string>();
      for (const c of perApp.keys()) set.add(c);
      for (const c of fallback.keys()) set.add(c);
      return set;
    },
    describe() {
      const out: RegistryDescription[] = [];
      for (const [channel, byApp] of perApp) {
        for (const [appId, entry] of byApp) {
          out.push({ channel, appId, adapterName: entry.name });
        }
      }
      for (const [channel, entry] of fallback) {
        out.push({ channel, adapterName: entry.name });
      }
      return out;
    },
  };
}
