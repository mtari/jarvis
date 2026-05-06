import type { KnownBlock } from "@slack/types";
import type { ScheduledPost } from "../../../orchestrator/scheduled-posts.ts";

/**
 * Block Kit surface for one `awaiting-review` scheduled post (single-
 * post plan). Buttons: Approve (primary), Skip… (opens reason modal).
 * Edit-via-modal lands later — operators use `posts edit <id>` for now.
 */

export interface PostReviewBlocksInput {
  post: ScheduledPost;
  /** Plan title for context — pulled from the source plan record by the caller. */
  planTitle?: string;
}

const CHANNEL_EMOJI: Record<string, string> = {
  facebook: "📘",
  instagram: "📷",
  twitter: "𝕏",
  linkedin: "🔗",
  newsletter: "📧",
  blog: "📝",
};

const MAX_BODY_CHARS = 2800; // Slack section text cap is 3000.

export function buildPostReviewBlocks(
  input: PostReviewBlocksInput,
): KnownBlock[] {
  const { post } = input;
  const channelEmoji = CHANNEL_EMOJI[post.channel] ?? "📬";
  const titleLine = input.planTitle
    ? `${channelEmoji} Post to review: ${input.planTitle}`
    : `${channelEmoji} Post to review`;

  const summaryLines: string[] = [];
  summaryLines.push(
    `*\`${post.id}\`*  •  *${post.channel}*  •  scheduled \`${post.scheduledAt}\`  •  app \`${post.appId}\``,
  );
  if (post.assets.length > 0) {
    summaryLines.push(`Assets: ${post.assets.join(", ")}`);
  }
  const body = `${summaryLines.join("\n")}\n\n*Content*\n${truncate(post.content.trim(), MAX_BODY_CHARS - summaryLines.join("\n").length - 30)}`;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: titleLine, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(body, MAX_BODY_CHARS) },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "post_approve",
          value: post.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip…", emoji: true },
          style: "danger",
          action_id: "post_skip",
          value: post.id,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Plan: \`${post.planId}\`  •  Status: \`${post.status}\`  •  Edit via CLI: \`yarn jarvis posts edit ${post.id}\``,
        },
      ],
    },
  ];
  return blocks;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function buildPostSkipReasonModal(postId: string): {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  blocks: KnownBlock[];
} {
  return {
    type: "modal",
    callback_id: "post_skip_submit",
    private_metadata: postId,
    title: { type: "plain_text", text: "Skip post" },
    submit: { type: "plain_text", text: "Skip" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Skipping post \`${postId}\`. The daemon won't publish it.`,
        },
      },
      {
        type: "input",
        block_id: "skip_reason_block",
        label: { type: "plain_text", text: "Why are you skipping?" },
        element: {
          type: "plain_text_input",
          action_id: "skip_reason_input",
          multiline: true,
          min_length: 3,
          max_length: 500,
          placeholder: {
            type: "plain_text",
            text: "off-brand, redundant, bad timing, …",
          },
        },
      },
    ],
  };
}

export function buildPostOutcomeContext(message: string): KnownBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: message }],
  };
}
