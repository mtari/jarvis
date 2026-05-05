import type { KnownBlock } from "@slack/types";

/**
 * Block Kit for the weekly Monday-morning triage report. The triage
 * service writes a markdown file (PR #27); this surface posts that
 * content into `#jarvis-inbox` so the user reads it in Slack instead
 * of reaching for the file.
 *
 * Slack `mrkdwn` only partially overlaps with standard markdown:
 *   - `**bold**` doesn't render — Slack uses `*bold*`
 *   - `## headings` render as plain text
 *
 * `convertToMrkdwn` does a light conversion of the bits we actually
 * use in the triage report (the `**[HIGH]**`-style severity tags).
 * The rest stays readable as-is.
 */

export interface TriageReportBlocksInput {
  markdown: string;
  /** YYYY-MM-DD from the file basename. */
  date: string;
  /** Path to the file on disk; included in the context block. */
  filePath: string;
}

const SECTION_TEXT_CAP = 2800; // Slack hard-caps section text at 3000

export function buildTriageReportBlocks(
  input: TriageReportBlocksInput,
): KnownBlock[] {
  const converted = convertToMrkdwn(input.markdown);
  const truncated = converted.length > SECTION_TEXT_CAP;
  const body = truncated
    ? converted.slice(0, SECTION_TEXT_CAP - 1) + "…"
    : converted;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📋 Triage — ${input.date}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: body },
    },
  ];

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: truncated
          ? `Truncated. Full report: \`${input.filePath}\` • Re-run on demand: \`yarn jarvis triage\``
          : `Full report on disk: \`${input.filePath}\` • Re-run on demand: \`yarn jarvis triage\``,
      },
    ],
  });

  return blocks;
}

/**
 * Light conversion of the triage markdown to Slack `mrkdwn`. The only
 * material change is `**bold**` → `*bold*` (Slack's bold syntax).
 * Headings, lists, code spans, and links pass through unchanged —
 * Slack renders the heading marker as plain text but the content
 * stays readable.
 */
export function convertToMrkdwn(markdown: string): string {
  return markdown.replace(/\*\*([^*]+)\*\*/g, "*$1*");
}
