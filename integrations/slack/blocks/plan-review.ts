import type { KnownBlock } from "@slack/types";
import type { Plan } from "../../../orchestrator/plan.ts";

export interface PlanReviewBlocksInput {
  planId: string;
  plan: Plan;
  /** Path to the plan file on disk; included in the surface for reference. */
  path?: string;
}

const TYPE_EMOJI: Record<string, string> = {
  improvement: "🛠",
  implementation: "🔧",
  business: "📊",
  marketing: "📣",
};

const PRIORITY_EMOJI: Record<string, string> = {
  blocking: "🚨",
  high: "🔥",
  normal: "•",
  low: "·",
};

// Slack's per-section text cap is 3000 chars. We chunk long sections at
// paragraph (preferably double-newline) boundaries so the user sees the
// full plan rather than a truncated preview.
const MAX_SECTION_CHARS = 2900;
// Block Kit messages cap at 50 blocks. Header + summary + divider +
// actions + context account for 5; that leaves 45 for plan-body sections.
// In practice we soft-cap before that to keep messages reviewable.
const MAX_BODY_BLOCKS = 45;

export function buildPlanReviewBlocks(input: PlanReviewBlocksInput): KnownBlock[] {
  const { planId, plan } = input;
  const meta = plan.metadata;
  const typeLabel = meta.subtype ? `${meta.type}/${meta.subtype}` : meta.type;
  const typeEmoji = TYPE_EMOJI[meta.type] ?? "📋";
  const priorityEmoji = PRIORITY_EMOJI[meta.priority] ?? "•";
  const destructiveTag = meta.destructive ? " *⚠ Destructive*" : "";

  const headerText = `${typeEmoji} Plan to review: ${meta.title}`;
  const summaryLines: string[] = [];
  summaryLines.push(`*\`${planId}\`*  •  *${typeLabel}*  •  ${priorityEmoji} ${meta.priority}  •  app \`${meta.app}\`${destructiveTag}`);
  summaryLines.push(
    `Confidence: *${meta.confidence.score}*${meta.confidence.rationale ? ` — ${meta.confidence.rationale}` : ""}`,
  );

  // Every plan body section, in order, as its own section block (or
  // multiple consecutive blocks for long sections). No truncation — the
  // reviewer needs to see the whole plan.
  const bodyBlocks: KnownBlock[] = [];
  let bodyBlockCount = 0;
  let overflowed = false;
  for (const section of plan.sections) {
    if (!section.body.trim()) continue;
    const chunks = chunkSectionForSlack(section.body.trim(), MAX_SECTION_CHARS);
    for (let i = 0; i < chunks.length; i += 1) {
      if (bodyBlockCount >= MAX_BODY_BLOCKS) {
        overflowed = true;
        break;
      }
      const heading = i === 0 ? `*${section.title}*\n` : "";
      bodyBlocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${heading}${chunks[i]!}` },
      });
      bodyBlockCount += 1;
    }
    if (overflowed) break;
  }
  if (overflowed) {
    bodyBlocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Plan body exceeded Slack's block budget — full content at ${input.path ?? `\`${planId}.md\``}._`,
        },
      ],
    });
  }

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryLines.join("\n"),
      },
    },
    { type: "divider" },
    ...bodyBlocks,
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "plan_approve",
          value: planId,
          ...(meta.destructive && {
            confirm: {
              title: { type: "plain_text", text: "Approve destructive plan?" },
              text: {
                type: "mrkdwn",
                text: `Plan \`${planId}\` is marked *Destructive: true*. This is the second confirmation per §13.`,
              },
              confirm: { type: "plain_text", text: "Approve" },
              deny: { type: "plain_text", text: "Cancel" },
              style: "danger",
            },
          }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Revise…", emoji: true },
          action_id: "plan_revise",
          value: planId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          style: "danger",
          action_id: "plan_reject",
          value: planId,
          confirm: {
            title: { type: "plain_text", text: "Reject this plan?" },
            text: {
              type: "mrkdwn",
              text: `Plan \`${planId}\` will be terminal-rejected. Use *Revise* if you want a redraft instead.`,
            },
            confirm: { type: "plain_text", text: "Reject" },
            deny: { type: "plain_text", text: "Cancel" },
            style: "danger",
          },
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Author: ${meta.author}  •  Status: \`${meta.status}\`${input.path ? `  •  ${input.path}` : ""}`,
        },
      ],
    },
  ];
  return blocks;
}

/**
 * Splits a single plan section's body into Slack-section-sized chunks.
 * Prefers paragraph (blank-line) boundaries; falls back to line boundaries;
 * falls back to a hard split at the cap. Empty paragraphs are coalesced so
 * the chunks read naturally.
 */
export function chunkSectionForSlack(body: string, max: number): string[] {
  if (body.length <= max) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > max) {
    const minPos = Math.floor(max * 0.5);
    let split = -1;
    // Prefer paragraph break (`\n\n`). Look up to position `max + 2` so a
    // boundary landing exactly at the cap (chunk_end..chunk_end+1) is found.
    const paraCandidate = remaining.slice(0, max + 2);
    const doubleNl = paraCandidate.lastIndexOf("\n\n");
    if (doubleNl >= minPos && doubleNl <= max) split = doubleNl;
    if (split === -1) {
      // Fall back to single line break, search up to position `max + 1`.
      const lineCandidate = remaining.slice(0, max + 1);
      const singleNl = lineCandidate.lastIndexOf("\n");
      if (singleNl >= minPos && singleNl <= max) split = singleNl;
    }
    if (split === -1) split = max; // hard split
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).replace(/^\s+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function buildReviseModal(planId: string): {
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
    callback_id: "plan_revise_submit",
    private_metadata: planId,
    title: { type: "plain_text", text: "Revise plan" },
    submit: { type: "plain_text", text: "Send back" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Reviewing plan \`${planId}\`. Strategist will redraft using your feedback.`,
        },
      },
      {
        type: "input",
        block_id: "feedback_block",
        label: {
          type: "plain_text",
          text: "What needs to change?",
        },
        element: {
          type: "plain_text_input",
          action_id: "feedback_input",
          multiline: true,
          min_length: 5,
          max_length: 1500,
          placeholder: {
            type: "plain_text",
            text: "Be specific — Strategist addresses every point.",
          },
        },
      },
    ],
  };
}

export function buildOutcomeContext(message: string): KnownBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: message }],
  };
}
