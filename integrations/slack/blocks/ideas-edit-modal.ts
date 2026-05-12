import type { KnownBlock } from "@slack/types";
import type { BusinessIdea } from "../../../orchestrator/business-ideas.ts";

export interface BuildIdeasEditModalInput {
  idea: BusinessIdea;
  rescoreDefault: boolean;
}

export function buildIdeasEditModal(input: BuildIdeasEditModalInput): {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  blocks: KnownBlock[];
} {
  const { idea, rescoreDefault } = input;
  const rescoreOption = {
    value: "rescore",
    text: { type: "plain_text" as const, text: "Rescore after save" },
  };
  return {
    type: "modal",
    callback_id: "ideas_edit_submit",
    private_metadata: JSON.stringify({ ideaId: idea.id, rescoreDefault }),
    title: { type: "plain_text", text: "Edit idea" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Editing:* ${idea.title}\n\`${idea.id}\``,
        },
      },
      {
        type: "input",
        block_id: "body_block",
        optional: true,
        label: { type: "plain_text", text: "Body" },
        hint: {
          type: "plain_text",
          text: "Long bodies (>3000 chars): use `yarn jarvis ideas edit <id>` from the CLI.",
        },
        element: {
          type: "plain_text_input",
          action_id: "body_input",
          multiline: true,
          max_length: 3000,
          ...(idea.body.length > 0 && { initial_value: idea.body }),
        },
      },
      {
        type: "input",
        block_id: "rescore_block",
        optional: true,
        label: { type: "plain_text", text: "Options" },
        element: {
          type: "checkboxes",
          action_id: "rescore_checkbox",
          options: [rescoreOption],
          ...(rescoreDefault && { initial_options: [rescoreOption] }),
        },
      },
    ],
  };
}
