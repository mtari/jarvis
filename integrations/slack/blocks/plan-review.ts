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

const MAX_BODY_CHARS = 2800; // Slack section text cap is 3000

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

  // First two sections of the body for at-a-glance context
  const bodyExcerpts: string[] = [];
  for (const section of plan.sections.slice(0, 2)) {
    if (!section.body.trim()) continue;
    bodyExcerpts.push(`*${section.title}*\n${truncate(section.body.trim(), 600)}`);
  }
  const fullSummary = [summaryLines.join("\n"), ...bodyExcerpts].join("\n\n");

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(fullSummary, MAX_BODY_CHARS),
      },
    },
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
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
