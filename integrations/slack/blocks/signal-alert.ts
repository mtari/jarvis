import type { KnownBlock } from "@slack/types";
import type { SignalSeverity } from "../../../tools/scanners/types.ts";

/**
 * Block Kit for surfacing high/critical Analyst signals in
 * `#jarvis-alerts`. The alert is read-only context with one optional
 * action — a "Suppress this signal" button that mutes the dedupKey
 * via the suppressions table (same machinery as `yarn jarvis suppress`).
 *
 * Signals without a `dedupKey` can't be suppressed at the pattern
 * level, so the button is omitted in that case.
 */

export interface SignalAlertBlocksInput {
  /** Auto-increment id of the `signal` event row — used as the suppress button's value. */
  signalEventId: number;
  app: string;
  vault: string;
  /** Collector kind: `yarn-audit`, `broken-links`, `content-freshness`, … */
  kind: string;
  severity: SignalSeverity;
  summary: string;
  dedupKey?: string;
  createdAt: string;
}

const SEVERITY_HEADER: Record<SignalSeverity, string> = {
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

export function buildSignalAlertBlocks(
  input: SignalAlertBlocksInput,
): KnownBlock[] {
  const emoji = SEVERITY_HEADER[input.severity];
  const label = SEVERITY_LABEL[input.severity];
  const headerText = `${emoji} ${label} signal — ${truncate(input.summary, 110)}`;

  const summaryLines: string[] = [];
  summaryLines.push(
    `*App* \`${input.app}\`  •  *Collector* \`${input.kind}\`  •  *Severity* ${label}`,
  );
  if (input.dedupKey) {
    summaryLines.push(`*Dedup key:* \`${input.dedupKey}\``);
  } else {
    summaryLines.push(`_No dedup key — pattern-level suppress unavailable._`);
  }
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

  if (input.dedupKey) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Suppress this signal", emoji: true },
          action_id: "signal_suppress",
          value: input.dedupKey,
          confirm: {
            title: { type: "plain_text", text: "Suppress this dedup key?" },
            text: {
              type: "mrkdwn",
              text: `Future occurrences of \`${input.dedupKey}\` will not auto-draft a plan or post here. Use \`yarn jarvis unsuppress ${input.dedupKey}\` to lift.`,
            },
            confirm: { type: "plain_text", text: "Suppress" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Vault \`${input.vault}\` • signal #${input.signalEventId} • ${input.createdAt} • full payload: \`yarn jarvis signals --kind ${input.kind}\``,
      },
    ],
  });
  return blocks;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
