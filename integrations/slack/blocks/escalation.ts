import type { KnownBlock } from "@slack/types";
import type { SignalSeverity } from "../../../tools/scanners/types.ts";

/**
 * Block Kit for runtime escalations posted to `#jarvis-alerts`. Each
 * escalation = one message with one optional action: Acknowledge,
 * which strips the button and notes who acknowledged. The kind +
 * severity emoji make the post scannable in a busy channel.
 */

export interface EscalationBlocksInput {
  /** Auto-increment id of the `escalation` event row. */
  escalationEventId: number;
  kind: string;
  severity: SignalSeverity;
  summary: string;
  detail?: string;
  planId?: string;
  app?: string;
  /** ISO datetime — created_at from the event row. */
  recordedAt: string;
}

const SEVERITY_EMOJI: Record<SignalSeverity, string> = {
  low: "ℹ️",
  medium: "⚡",
  high: "🔥",
  critical: "🚨",
};

const SEVERITY_LABEL: Record<SignalSeverity, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  critical: "CRITICAL",
};

const DETAIL_CAP = 2400; // leave headroom under the 3000 section limit

export function buildEscalationBlocks(
  input: EscalationBlocksInput,
): KnownBlock[] {
  const emoji = SEVERITY_EMOJI[input.severity];
  const label = SEVERITY_LABEL[input.severity];
  const headerText = `${emoji} ${label} escalation — ${truncate(input.summary, 100)}`;

  const summaryLines: string[] = [];
  summaryLines.push(`*Kind* \`${input.kind}\`  •  *Severity* ${label}`);
  if (input.app) summaryLines.push(`*App* \`${input.app}\``);
  if (input.planId) summaryLines.push(`*Plan* \`${input.planId}\``);
  summaryLines.push("");
  summaryLines.push(input.summary);

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
  ];

  if (input.detail && input.detail.trim().length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```\n" + truncate(input.detail.trim(), DETAIL_CAP) + "\n```",
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Acknowledge", emoji: true },
        action_id: "escalation_acknowledge",
        value: String(input.escalationEventId),
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `escalation #${input.escalationEventId} • ${input.recordedAt} • full event payload: \`yarn jarvis logs tail\``,
      },
    ],
  });

  return blocks;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
