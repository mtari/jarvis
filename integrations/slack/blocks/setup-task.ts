import type { KnownBlock } from "@slack/types";
import type { SetupTask } from "../../../orchestrator/setup-tasks.ts";

/**
 * Block Kit for surfacing a setup task in `#jarvis-inbox`. One task =
 * one message with two action buttons:
 *   - "Mark done" → resolves with status=done
 *   - "Skip…"     → opens a modal asking for a reason, then resolves
 *                   with status=skipped
 *
 * Both buttons carry the task id as `value`; the handler looks the
 * task up by id when the click arrives. Resolved tasks are rewritten
 * out of the queue file (per orchestrator/setup-tasks.ts) and the
 * Slack message gets stripped of its actions block to indicate the
 * task is closed.
 */

export interface SetupTaskBlocksInput {
  task: SetupTask;
}

export function buildSetupTaskBlocks(
  input: SetupTaskBlocksInput,
): KnownBlock[] {
  const { task } = input;
  const headerText = `🛠 Setup task: ${truncate(task.title, 110)}`;

  const summaryLines: string[] = [];
  summaryLines.push(`*\`${task.id}\`*  •  created ${task.createdAt}`);
  if (task.source) {
    const ref = task.source.refId ? ` \`${task.source.refId}\`` : "";
    summaryLines.push(`Source: \`${task.source.kind}\`${ref}`);
  }

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summaryLines.join("\n") },
    },
  ];

  if (task.detail && task.detail.trim().length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(task.detail.trim(), 2800),
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Mark done", emoji: true },
        style: "primary",
        action_id: "setup_task_done",
        value: task.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Skip…", emoji: true },
        action_id: "setup_task_skip",
        value: task.id,
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Resolve from CLI: \`yarn jarvis setup --done ${task.id}\` or \`--skip ${task.id}\``,
      },
    ],
  });

  return blocks;
}

/**
 * Modal asked when the user clicks "Skip…" on a setup-task surface.
 * The task id rides in `private_metadata`; the reason input is
 * required (5–500 chars).
 */
export function buildSkipReasonModal(taskId: string): {
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
    callback_id: "setup_task_skip_submit",
    private_metadata: taskId,
    title: { type: "plain_text", text: "Skip setup task" },
    submit: { type: "plain_text", text: "Skip task" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Skipping setup task \`${taskId}\`. Note the reason for the audit trail.`,
        },
      },
      {
        type: "input",
        block_id: "reason_block",
        label: { type: "plain_text", text: "Why are you skipping?" },
        element: {
          type: "plain_text_input",
          action_id: "reason_input",
          multiline: true,
          min_length: 5,
          max_length: 500,
          placeholder: {
            type: "plain_text",
            text: "Be specific — Analyst learns from skip patterns.",
          },
        },
      },
    ],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
