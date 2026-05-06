/**
 * Channel adapter contract — what the post-publisher uses to actually
 * push a post to an external surface (FB, IG, X, LinkedIn, newsletter,
 * blog). Each real adapter wraps the platform's API + auth; the
 * v1 stub (`tools/channels/file-stub.ts`) just appends to a JSONL
 * file under sandbox so the daemon scheduler tick can be exercised
 * end-to-end before the real wrappers ship.
 *
 * The publisher (`orchestrator/post-publisher.ts`) looks up an
 * adapter by channel name. Channels with no registered adapter cause
 * the row to be marked `failed` with a "no adapter" reason — this is
 * how the system fails loud rather than silently dropping posts.
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
   * Channels this adapter is registered for. The publisher indexes a
   * `Map<channel, adapter>` from this list — the same adapter can
   * serve multiple channels (e.g. the stub serves all of them).
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

export type ChannelAdapterMap = ReadonlyMap<string, ChannelAdapter>;

/**
 * Helper: builds a `ChannelAdapterMap` from a list of adapters.
 * Last adapter wins on overlap — adapters earlier in the list act
 * as defaults that more-specific adapters can override.
 */
export function buildAdapterMap(
  adapters: ReadonlyArray<ChannelAdapter>,
): ChannelAdapterMap {
  const out = new Map<string, ChannelAdapter>();
  for (const adapter of adapters) {
    for (const channel of adapter.channels) {
      out.set(channel, adapter);
    }
  }
  return out;
}
