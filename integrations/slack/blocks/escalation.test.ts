import { describe, expect, it } from "vitest";
import { buildEscalationBlocks } from "./escalation.ts";

const BASE = {
  escalationEventId: 99,
  kind: "rate-limit",
  severity: "high" as const,
  summary: "Claude Code subscription rate limit hit",
  recordedAt: "2026-05-05T12:00:00Z",
};

describe("buildEscalationBlocks", () => {
  it("emits header / summary / actions / context (no detail block when detail absent)", () => {
    const blocks = buildEscalationBlocks(BASE);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["header", "section", "actions", "context"]);
  });

  it("includes the detail block when detail is set", () => {
    const blocks = buildEscalationBlocks({
      ...BASE,
      detail: "stack trace here",
    });
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["header", "section", "section", "actions", "context"]);
    const details = blocks[2];
    if (!details || details.type !== "section") throw new Error("no detail");
    const text =
      "text" in details && details.text && "text" in details.text
        ? details.text.text
        : "";
    expect(text).toContain("stack trace here");
    expect(text).toContain("```");
  });

  it("header uses severity-specific emoji", () => {
    const variants = (["low", "medium", "high", "critical"] as const).map((sev) => {
      const blocks = buildEscalationBlocks({ ...BASE, severity: sev });
      const h = blocks[0];
      return h && h.type === "header" ? h.text.text : "";
    });
    expect(new Set(variants).size).toBe(4);
    expect(variants[3]).toContain("CRITICAL");
  });

  it("section block surfaces app and planId when set", () => {
    const blocks = buildEscalationBlocks({
      ...BASE,
      app: "erdei-fahazak",
      planId: "2026-04-30-foo",
    });
    const summary = blocks[1];
    if (!summary || summary.type !== "section") throw new Error("no summary");
    const text =
      "text" in summary && summary.text && "text" in summary.text
        ? summary.text.text
        : "";
    expect(text).toContain("erdei-fahazak");
    expect(text).toContain("2026-04-30-foo");
  });

  it("Acknowledge button carries the event id as value", () => {
    const blocks = buildEscalationBlocks(BASE);
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const btn = actions.elements[0];
    if (!btn || btn.type !== "button") throw new Error("no button");
    expect(btn.action_id).toBe("escalation_acknowledge");
    expect(btn.value).toBe("99");
  });

  it("context shows event id, recorded-at, and a CLI recipe", () => {
    const blocks = buildEscalationBlocks(BASE);
    const ctx = blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const text =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(text).toContain("escalation #99");
    expect(text).toContain("2026-05-05T12:00:00Z");
    expect(text).toContain("yarn jarvis logs tail");
  });

  it("truncates very long details to fit Slack's section limit", () => {
    const blocks = buildEscalationBlocks({
      ...BASE,
      detail: "x".repeat(5000),
    });
    const detail = blocks[2];
    if (!detail || detail.type !== "section") throw new Error("no detail");
    const text =
      "text" in detail && detail.text && "text" in detail.text
        ? detail.text.text
        : "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(2500);
  });
});
