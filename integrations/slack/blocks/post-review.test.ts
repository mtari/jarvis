import { describe, expect, it } from "vitest";
import type { ScheduledPost } from "../../../orchestrator/scheduled-posts.ts";
import {
  buildPostOutcomeContext,
  buildPostReviewBlocks,
  buildPostSkipReasonModal,
} from "./post-review.ts";

function post(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "plan-x-post-01",
    planId: "plan-x",
    appId: "demo",
    channel: "facebook",
    content: "Hello world.",
    assets: [],
    scheduledAt: "2026-04-08T09:00:00.000Z",
    status: "awaiting-review",
    publishedAt: null,
    publishedId: null,
    failureReason: null,
    editHistory: [],
    ...overrides,
  };
}

describe("buildPostReviewBlocks", () => {
  it("includes Approve and Skip buttons with the post id as value", () => {
    const blocks = buildPostReviewBlocks({ post: post() });
    const actions = blocks.find((b) => b.type === "actions") as {
      type: "actions";
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions).toBeDefined();
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toContain("post_approve");
    expect(ids).toContain("post_skip");
    expect(actions.elements.every((e) => e.value === "plan-x-post-01")).toBe(
      true,
    );
  });

  it("renders the post content + scheduled time + channel in the body", () => {
    const blocks = buildPostReviewBlocks({
      post: post({ content: "Catchy line" }),
    });
    const section = blocks.find((b) => b.type === "section") as {
      text: { text: string };
    };
    expect(section.text.text).toContain("Catchy line");
    expect(section.text.text).toContain("facebook");
    expect(section.text.text).toContain("2026-04-08T09:00:00.000Z");
  });

  it("includes plan title in the header when provided", () => {
    const blocks = buildPostReviewBlocks({
      post: post(),
      planTitle: "April campaign",
    });
    const header = blocks.find((b) => b.type === "header") as {
      text: { text: string };
    };
    expect(header.text.text).toContain("April campaign");
  });

  it("falls back to a generic header when planTitle is omitted", () => {
    const blocks = buildPostReviewBlocks({ post: post() });
    const header = blocks.find((b) => b.type === "header") as {
      text: { text: string };
    };
    expect(header.text.text).toContain("Post to review");
  });

  it("renders assets when present", () => {
    const blocks = buildPostReviewBlocks({
      post: post({ assets: ["hero.jpg", "video.mp4"] }),
    });
    const section = blocks.find((b) => b.type === "section") as {
      text: { text: string };
    };
    expect(section.text.text).toContain("hero.jpg");
    expect(section.text.text).toContain("video.mp4");
  });

  it("truncates very long content under the Slack section cap", () => {
    const longContent = "x".repeat(5000);
    const blocks = buildPostReviewBlocks({
      post: post({ content: longContent }),
    });
    const section = blocks.find((b) => b.type === "section") as {
      text: { text: string };
    };
    expect(section.text.text.length).toBeLessThan(3000);
    expect(section.text.text).toContain("…");
  });
});

describe("buildPostSkipReasonModal", () => {
  it("carries the post id in private_metadata + has a single text input", () => {
    const modal = buildPostSkipReasonModal("plan-x-post-01");
    expect(modal.callback_id).toBe("post_skip_submit");
    expect(modal.private_metadata).toBe("plan-x-post-01");
    const input = modal.blocks.find((b) => b.type === "input") as {
      block_id: string;
      element: { action_id: string };
    };
    expect(input.block_id).toBe("skip_reason_block");
    expect(input.element.action_id).toBe("skip_reason_input");
  });
});

describe("buildPostOutcomeContext", () => {
  it("renders an mrkdwn context block", () => {
    const block = buildPostOutcomeContext("✓ Approved by <@U123>");
    expect(block.type).toBe("context");
    const ctx = block as {
      type: "context";
      elements: Array<{ type: string; text: string }>;
    };
    expect(ctx.elements[0]?.type).toBe("mrkdwn");
    expect(ctx.elements[0]?.text).toContain("Approved");
  });
});
