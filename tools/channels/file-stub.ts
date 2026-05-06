import fs from "node:fs";
import path from "node:path";
import { sandboxDir } from "../../cli/paths.ts";
import { SUPPORTED_CHANNELS } from "../../agents/marketer.ts";
import type { ChannelAdapter, PublishInput, PublishResult } from "./types.ts";

/**
 * Stub channel adapter — writes one JSONL line per "publish" to
 * `<dataDir>/sandbox/published-posts.jsonl`. Lets the daemon scheduler
 * tick run end-to-end without real platform tokens.
 *
 * The stub serves every supported channel by default. Real adapters
 * (FB, IG, etc.) can override individual channels via the
 * `buildAdapterMap` last-wins rule.
 *
 * Idempotent against re-publishes: each line's `published_id` is
 * `stub-<post-id>`. If the row gets re-published due to a crash mid-
 * tick, the line is appended a second time, but the `published_id`
 * is stable so audit consumers can dedupe.
 */

export interface FileStubOptions {
  dataDir: string;
  /** Defaults to all SUPPORTED_CHANNELS. */
  channels?: ReadonlyArray<string>;
  /** Test seam — fixed clock for the JSONL `published_at` field. */
  now?: () => Date;
}

export const STUB_OUTPUT_FILENAME = "published-posts.jsonl";

export function createFileStubAdapter(opts: FileStubOptions): ChannelAdapter {
  const channels = opts.channels ?? SUPPORTED_CHANNELS;
  const now = opts.now ?? ((): Date => new Date());

  return {
    channels,
    async publish(input: PublishInput): Promise<PublishResult> {
      const dir = sandboxDir(opts.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, STUB_OUTPUT_FILENAME);
      const publishedId = `stub-${input.postId}`;
      const line = JSON.stringify({
        publishedId,
        postId: input.postId,
        planId: input.planId,
        appId: input.appId,
        channel: input.channel,
        content: input.content,
        assets: [...input.assets],
        publishedAt: now().toISOString(),
      });
      fs.appendFileSync(file, line + "\n");
      return { ok: true, publishedId };
    },
  };
}
