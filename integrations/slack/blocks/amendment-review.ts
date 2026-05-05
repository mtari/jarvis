import type { KnownBlock } from "@slack/types";
import type { Plan } from "../../../orchestrator/plan.ts";

/**
 * Block Kit for surfacing a §12 amendment in `#jarvis-inbox`. Distinct
 * shape from the generic plan-review post — the user needs to see why
 * Developer paused, what's already on the branch, and the proposed
 * change before deciding approve / revise / reject.
 *
 * The same approve / revise / reject buttons fire the same handlers as
 * the generic plan-review (the lifecycle functions are amendment-agnostic).
 * The only behavioural difference downstream is that the Slack reject
 * handler also removes the saved checkpoint — same parity the CLI
 * `yarn jarvis reject` got in slice 4.
 */

export interface AmendmentEventData {
  /** id of the `amendment-proposed` event in the events table. */
  eventId: number;
  reason: string;
  proposal: string;
  /** Branch the previous Developer run was on when it amended. */
  branch?: string;
  /** HEAD sha at amendment time. */
  sha?: string;
  /** Number of files in `git status --porcelain` at amendment time. */
  modifiedFileCount?: number;
}

export interface AmendmentReviewBlocksInput {
  planId: string;
  plan: Plan;
  amendment: AmendmentEventData;
  /** Plan file path, shown in the context block for grep-ability. */
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

const MAX_PROPOSAL_CHARS = 1500;
const MAX_BODY_CHARS = 2800; // Slack section text cap is 3000

export function buildAmendmentReviewBlocks(
  input: AmendmentReviewBlocksInput,
): KnownBlock[] {
  const { planId, plan, amendment } = input;
  const meta = plan.metadata;
  const typeLabel = meta.subtype ? `${meta.type}/${meta.subtype}` : meta.type;
  const typeEmoji = TYPE_EMOJI[meta.type] ?? "📋";
  const priorityEmoji = PRIORITY_EMOJI[meta.priority] ?? "•";
  const destructiveTag = meta.destructive ? " *⚠ Destructive*" : "";

  const headerText = `${typeEmoji}🔁 Amendment review: ${meta.title}`;

  const summaryParts: string[] = [
    `*\`${planId}\`*  •  *${typeLabel}*  •  ${priorityEmoji} ${meta.priority}  •  app \`${meta.app}\`${destructiveTag}`,
  ];

  // Branch + modified-file context — tells the user what state Developer
  // left the working tree in when it paused.
  const stateBits: string[] = [];
  if (amendment.branch) stateBits.push(`Branch \`${amendment.branch}\``);
  if (amendment.sha) stateBits.push(`HEAD \`${amendment.sha.slice(0, 8)}\``);
  if (
    amendment.modifiedFileCount !== undefined &&
    amendment.modifiedFileCount > 0
  ) {
    stateBits.push(`${amendment.modifiedFileCount} modified file(s)`);
  }
  if (stateBits.length > 0) {
    summaryParts.push(stateBits.join("  •  "));
  }

  const reasonBlock = `*Why amended*\n${amendment.reason}`;
  const proposalBlock = `*Proposed amendment*\n${quote(
    truncate(amendment.proposal, MAX_PROPOSAL_CHARS),
  )}`;

  const fullSummary = [
    summaryParts.join("\n"),
    reasonBlock,
    proposalBlock,
  ].join("\n\n");

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
          text: {
            type: "plain_text",
            text: "Approve & resume",
            emoji: true,
          },
          style: "primary",
          action_id: "plan_approve",
          value: planId,
          ...(meta.destructive && {
            confirm: {
              title: { type: "plain_text", text: "Approve destructive amendment?" },
              text: {
                type: "mrkdwn",
                text: `Plan \`${planId}\` is marked *Destructive: true*. Approving the amendment resumes execution from the saved checkpoint.`,
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
          text: { type: "plain_text", text: "Reject (cancel)", emoji: true },
          style: "danger",
          action_id: "plan_reject",
          value: planId,
          confirm: {
            title: { type: "plain_text", text: "Reject this amendment?" },
            text: {
              type: "mrkdwn",
              text: `Plan \`${planId}\` will be terminal-rejected and the saved checkpoint deleted. Use *Revise* if you want a redraft instead.`,
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
          text: `Author: ${meta.author}  •  Status: \`${meta.status}\` (amendment)${input.path ? `  •  ${input.path}` : ""}`,
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

/** Prefix every line with `> ` so Slack renders the proposal as a quote. */
function quote(s: string): string {
  return s
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
