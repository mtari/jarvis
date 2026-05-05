import { describe, expect, it } from "vitest";
import type { SetupTask } from "../../../orchestrator/setup-tasks.ts";
import {
  buildSetupTaskBlocks,
  buildSkipReasonModal,
} from "./setup-task.ts";

const SAMPLE: SetupTask = {
  id: "stripe-key",
  title: "Set the Stripe restricted key",
  detail: "Add `STRIPE_RESTRICTED_KEY` to `.env`. See onboarding doc.",
  createdAt: "2026-05-05T10:00:00Z",
  source: { kind: "onboard", refId: "erdei-fahazak" },
};

describe("buildSetupTaskBlocks", () => {
  it("emits header / summary / detail / actions / context blocks", () => {
    const blocks = buildSetupTaskBlocks({ task: SAMPLE });
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "header",
      "section",
      "section",
      "actions",
      "context",
    ]);
  });

  it("header carries the wrench emoji and the task title", () => {
    const blocks = buildSetupTaskBlocks({ task: SAMPLE });
    const header = blocks[0];
    if (header?.type !== "header") throw new Error("no header");
    expect(header.text.text).toContain("🛠");
    expect(header.text.text).toContain("Set the Stripe restricted key");
  });

  it("summary section includes id, createdAt, and source kind/refId", () => {
    const blocks = buildSetupTaskBlocks({ task: SAMPLE });
    const summary = blocks[1];
    if (!summary || summary.type !== "section" || !("text" in summary)) {
      throw new Error("no summary section");
    }
    const text =
      summary.text && "text" in summary.text ? summary.text.text : "";
    expect(text).toContain("`stripe-key`");
    expect(text).toContain("2026-05-05T10:00:00Z");
    expect(text).toContain("`onboard`");
    expect(text).toContain("`erdei-fahazak`");
  });

  it("omits the detail block when detail is missing or blank", () => {
    const { detail: _drop, ...rest } = SAMPLE;
    void _drop;
    const blocks = buildSetupTaskBlocks({ task: rest });
    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "actions",
      "context",
    ]);
  });

  it("emits Mark done + Skip… buttons with the task id as value", () => {
    const blocks = buildSetupTaskBlocks({ task: SAMPLE });
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const buttons = actions.elements
      .filter((e): e is Extract<typeof e, { action_id?: string }> =>
        "action_id" in e,
      )
      .map((e) => ({ id: e["action_id"], val: (e as { value?: string }).value }));
    expect(buttons).toEqual([
      { id: "setup_task_done", val: "stripe-key" },
      { id: "setup_task_skip", val: "stripe-key" },
    ]);
  });

  it("context block hints at the CLI fallback", () => {
    const blocks = buildSetupTaskBlocks({ task: SAMPLE });
    const ctx = blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const text =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(text).toContain("yarn jarvis setup --done stripe-key");
    expect(text).toContain("--skip stripe-key");
  });

  it("works without a source", () => {
    const { source: _drop, ...rest } = SAMPLE;
    void _drop;
    const blocks = buildSetupTaskBlocks({ task: rest });
    const summary = blocks[1];
    if (!summary || summary.type !== "section" || !("text" in summary)) {
      throw new Error("no summary section");
    }
    const text =
      summary.text && "text" in summary.text ? summary.text.text : "";
    expect(text).not.toContain("Source:");
  });
});

describe("buildSkipReasonModal", () => {
  it("returns a modal with the task id in private_metadata", () => {
    const modal = buildSkipReasonModal("task-x");
    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe("setup_task_skip_submit");
    expect(modal.private_metadata).toBe("task-x");
  });

  it("requires a 5+ character reason", () => {
    const modal = buildSkipReasonModal("task-x");
    const input = modal.blocks.find((b) => b.type === "input");
    if (!input || input.type !== "input") throw new Error("no input block");
    const el = input.element as { type: string; min_length?: number };
    expect(el.type).toBe("plain_text_input");
    expect(el.min_length).toBe(5);
  });
});
