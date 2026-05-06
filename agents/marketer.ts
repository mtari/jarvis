import Database from "better-sqlite3";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { loadBrain } from "../orchestrator/brain.ts";
import type { ScheduleRule } from "../orchestrator/brain.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { resolveScheduledAt } from "../orchestrator/marketing-schedule.ts";
import { findPlan } from "../orchestrator/plan-store.ts";
import type { Plan, PlanSection } from "../orchestrator/plan.ts";
import {
  countScheduledPosts,
  insertScheduledPost,
  type ScheduledPostInput,
} from "../orchestrator/scheduled-posts.ts";
import { humanize } from "../tools/humanizer.ts";
import { brainFile, dbFile } from "../cli/paths.ts";

/**
 * Marketer agent — Phase 3 v1.
 *
 * One job in this slice: take an approved marketing plan, parse the
 * `## Content calendar` section into typed entries, run the humanizer
 * pass on each, and persist `pending` rows to `scheduled_posts`. The
 * daemon scheduler tick + actual publishing (FB/IG tools) land in
 * follow-ups.
 *
 * Idempotency: if any row already exists for the plan's id, prepare
 * is a no-op — re-running surfaces the existing count rather than
 * appending duplicates. The user can use `yarn jarvis post edit` (a
 * future surface) to mutate individual rows; the bulk operation
 * stays one-shot per plan.
 */

export const SUPPORTED_CHANNELS = [
  "facebook",
  "instagram",
  "twitter",
  "linkedin",
  "newsletter",
  "blog",
] as const;
export type MarketerChannel = (typeof SUPPORTED_CHANNELS)[number];

export interface ContentCalendarEntry {
  /** 1-based index from the plan's `### Post N` heading. */
  index: number;
  date: string;
  channel: MarketerChannel;
  assets: string[];
  /** Verbatim post text from the plan, before humanizer pass. */
  text: string;
}

export interface PreparedPost {
  postId: string;
  entry: ContentCalendarEntry;
  /** Humanized text — what gets stored in `scheduled_posts.content`. */
  humanizedText: string;
  /** ISO datetime the row was scheduled for. */
  scheduledAt: string;
  /** True when humanizer reported no edits. */
  unchanged: boolean;
  /**
   * Initial row status. `pending` for campaign plans (publisher
   * picks up directly); `awaiting-review` for single-post plans
   * (operator runs `posts approve <id>` to gate publishing).
   */
  status: "pending" | "awaiting-review";
}

export interface PrepareMarketingPlanInput {
  client: AnthropicClient;
  planId: string;
  dataDir: string;
}

export interface PrepareMarketingPlanResult {
  planId: string;
  app: string;
  vault: string;
  prepared: PreparedPost[];
  /** True when the plan was already prepared and we no-oped. */
  alreadyPrepared: boolean;
  /** Existing row count when alreadyPrepared is true; else 0. */
  existingCount: number;
}

export class MarketerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketerError";
  }
}

export async function prepareMarketingPlan(
  input: PrepareMarketingPlanInput,
): Promise<PrepareMarketingPlanResult> {
  const record = findPlan(input.dataDir, input.planId);
  if (!record) {
    throw new MarketerError(`plan ${input.planId} not found`);
  }
  const plan = record.plan;
  if (plan.metadata.type !== "marketing") {
    throw new MarketerError(
      `plan ${input.planId} is type "${plan.metadata.type}", not "marketing"`,
    );
  }
  if (
    plan.metadata.status !== "approved" &&
    plan.metadata.status !== "executing"
  ) {
    throw new MarketerError(
      `plan ${input.planId} must be in status "approved" or "executing" to prepare; got "${plan.metadata.status}"`,
    );
  }

  const entries = parseContentCalendar(plan);
  if (entries.length === 0) {
    throw new MarketerError(
      `plan ${input.planId} has no parseable Content calendar entries`,
    );
  }

  // Pull the optional scheduling rule from the brain. When present,
  // resolveScheduledAt applies preferredHours / timezone / allowedDays
  // / blackoutDates per §10. When absent, every post defaults to
  // 09:00 UTC on its declared Date.
  let scheduleRule: ScheduleRule | undefined;
  try {
    const brain = loadBrain(brainFile(input.dataDir, record.vault, record.app));
    scheduleRule = brain.marketing?.scheduleRules?.default;
  } catch {
    // No brain or unreadable — fall through to default scheduling.
  }

  const db = new Database(dbFile(input.dataDir));
  try {
    const existingCount = countScheduledPosts(db, { planId: input.planId });
    if (existingCount > 0) {
      return {
        planId: input.planId,
        app: record.app,
        vault: record.vault,
        prepared: [],
        alreadyPrepared: true,
        existingCount,
      };
    }

    // §10: campaign posts publish without per-post review (the user reviews
    // the plan once); single-post plans need a per-post review gate. We
    // express that here: campaign rows land "pending" (publisher picks them
    // up); single-post rows land "awaiting-review" (operator runs `posts
    // approve <id>` to flip them to pending).
    const isSinglePost = plan.metadata.subtype === "single-post";
    const initialStatus = isSinglePost ? "awaiting-review" : "pending";

    const prepared: PreparedPost[] = [];
    for (const entry of entries) {
      const result = await humanize(
        { text: entry.text, context: `marketing-${entry.channel}` },
        { client: input.client },
      );
      const postId = makePostId(input.planId, entry.index);
      const resolved = resolveScheduledAt({
        date: entry.date,
        ...(scheduleRule !== undefined && { rule: scheduleRule }),
      });
      const scheduledAt = resolved.scheduledAt;

      const row: ScheduledPostInput = {
        id: postId,
        planId: input.planId,
        appId: record.app,
        channel: entry.channel,
        content: result.text,
        assets: entry.assets,
        scheduledAt,
        status: initialStatus,
      };
      db.transaction(() => {
        insertScheduledPost(db, row);
        appendEvent(db, {
          appId: record.app,
          vaultId: record.vault,
          kind: "post-prepared",
          payload: {
            postId,
            planId: input.planId,
            channel: entry.channel,
            scheduledAt,
            status: initialStatus,
            humanizerChangeCount: result.changes.length,
            humanizerUnchanged: result.unchanged,
          },
        });
      })();

      prepared.push({
        postId,
        entry,
        humanizedText: result.text,
        scheduledAt,
        unchanged: result.unchanged,
        status: initialStatus,
      });
    }

    return {
      planId: input.planId,
      app: record.app,
      vault: record.vault,
      prepared,
      alreadyPrepared: false,
      existingCount: 0,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Content calendar parser
// ---------------------------------------------------------------------------

const POST_HEADER_PATTERN = /^###\s+Post\s+(\d+)\s*$/i;
const META_LINE_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pulls `ContentCalendarEntry[]` out of a parsed plan's content
 * calendar section. Returns `[]` when the section is missing or has
 * no `### Post` blocks.
 *
 * Expected entry shape (enforced by `prompts/strategist-marketing.md`):
 *
 *   ### Post N
 *   Date: YYYY-MM-DD
 *   Channel: <facebook | instagram | ...>
 *   Assets: <comma-separated, or `-`>
 *   Text:
 *   <body lines until the next `### ` or `## `>
 *
 * Any `### Post N` block missing required fields raises
 * `MarketerError` so the caller can fix the plan and retry rather
 * than silently dropping posts.
 */
export function parseContentCalendar(
  plan: Plan,
): ContentCalendarEntry[] {
  const section = findContentCalendarSection(plan);
  if (!section) return [];

  const lines = section.body.split("\n");
  const blocks = splitIntoPostBlocks(lines);
  return blocks.map((block) => parsePostBlock(block));
}

function findContentCalendarSection(
  plan: Plan,
): PlanSection | null {
  return (
    plan.sections.find(
      (s) => s.title.trim().toLowerCase() === "content calendar",
    ) ?? null
  );
}

interface RawPostBlock {
  index: number;
  body: string[];
}

function splitIntoPostBlocks(lines: ReadonlyArray<string>): RawPostBlock[] {
  const out: RawPostBlock[] = [];
  let current: RawPostBlock | null = null;
  for (const raw of lines) {
    const m = raw.match(POST_HEADER_PATTERN);
    if (m) {
      if (current) out.push(current);
      current = { index: parseInt(m[1]!, 10), body: [] };
    } else if (current) {
      current.body.push(raw);
    }
    // Lines before the first `### Post N` (e.g. an intro paragraph) are ignored.
  }
  if (current) out.push(current);
  return out;
}

function parsePostBlock(block: RawPostBlock): ContentCalendarEntry {
  const fields: Record<string, string> = {};
  let textStartIdx = -1;
  for (let i = 0; i < block.body.length; i += 1) {
    const line = block.body[i]!;
    const trimmed = line.trim();
    if (trimmed.length === 0 && textStartIdx === -1) continue;
    const match = trimmed.match(META_LINE_PATTERN);
    if (!match) {
      // First non-meta line ends the meta block; if we haven't hit
      // `Text:` yet, this is malformed.
      break;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "text") {
      textStartIdx = i + 1;
      break;
    }
    fields[key] = value;
  }

  const date = fields["date"];
  if (!date) {
    throw new MarketerError(
      `Post ${block.index}: missing required "Date:" field`,
    );
  }
  if (!ISO_DATE_PATTERN.test(date)) {
    throw new MarketerError(
      `Post ${block.index}: Date "${date}" must be ISO YYYY-MM-DD`,
    );
  }
  const channelRaw = fields["channel"];
  if (!channelRaw) {
    throw new MarketerError(
      `Post ${block.index}: missing required "Channel:" field`,
    );
  }
  const channel = channelRaw.toLowerCase();
  if (!isSupportedChannel(channel)) {
    throw new MarketerError(
      `Post ${block.index}: channel "${channelRaw}" not in ${SUPPORTED_CHANNELS.join(", ")}`,
    );
  }
  const assets = parseAssets(fields["assets"]);
  if (textStartIdx === -1) {
    throw new MarketerError(
      `Post ${block.index}: missing "Text:" marker — body starts on the line AFTER "Text:"`,
    );
  }
  const text = block.body.slice(textStartIdx).join("\n").trim();
  if (text.length === 0) {
    throw new MarketerError(`Post ${block.index}: empty post body`);
  }

  return {
    index: block.index,
    date,
    channel,
    assets,
    text,
  };
}

function isSupportedChannel(s: string): s is MarketerChannel {
  return (SUPPORTED_CHANNELS as ReadonlyArray<string>).includes(s);
}

function parseAssets(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "" || raw.trim() === "-") return [];
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

function makePostId(planId: string, index: number): string {
  return `${planId}-post-${index.toString().padStart(2, "0")}`;
}
