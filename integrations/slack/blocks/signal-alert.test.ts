import { describe, expect, it } from "vitest";
import { buildSignalAlertBlocks } from "./signal-alert.ts";

const BASE = {
  signalEventId: 42,
  app: "erdei-fahazak",
  vault: "personal",
  kind: "yarn-audit",
  severity: "critical" as const,
  summary: "RCE in lodash via _.template",
  dedupKey: "yarn-audit:CVE-2026-1234",
  createdAt: "2026-05-05T11:00:00Z",
};

describe("buildSignalAlertBlocks", () => {
  it("emits a header with severity emoji + summary", () => {
    const blocks = buildSignalAlertBlocks(BASE);
    const header = blocks[0];
    expect(header?.type).toBe("header");
    if (header?.type === "header") {
      expect(header.text.text).toContain("CRITICAL");
      expect(header.text.text).toContain("RCE in lodash");
    }
  });

  it("includes app, collector, dedupKey, and the summary in the section", () => {
    const blocks = buildSignalAlertBlocks(BASE);
    const section = blocks.find((b) => b.type === "section");
    if (!section || section.type !== "section") throw new Error("no section");
    const text =
      "text" in section && section.text && "text" in section.text
        ? section.text.text
        : "";
    expect(text).toContain("erdei-fahazak");
    expect(text).toContain("yarn-audit");
    expect(text).toContain("yarn-audit:CVE-2026-1234");
    expect(text).toContain("RCE in lodash");
  });

  it("renders a Suppress button when dedupKey is present", () => {
    const blocks = buildSignalAlertBlocks(BASE);
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions || actions.type !== "actions") throw new Error("no actions");
    const ids = actions.elements
      .filter((e): e is Extract<typeof e, { action_id?: string }> =>
        "action_id" in e,
      )
      .map((e) => e["action_id"]);
    expect(ids).toEqual(["signal_suppress"]);
    const btn = actions.elements[0];
    if (btn && btn.type === "button") {
      expect(btn.value).toBe("yarn-audit:CVE-2026-1234");
      expect(btn.confirm).toBeDefined();
    }
  });

  it("omits the Suppress button when dedupKey is missing", () => {
    const { dedupKey: _drop, ...withoutDedup } = BASE;
    void _drop;
    const blocks = buildSignalAlertBlocks(withoutDedup);
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
    const section = blocks.find((b) => b.type === "section");
    const text =
      section && section.type === "section" && "text" in section && section.text
        ? section.text.text
        : "";
    expect(text).toContain("No dedup key");
  });

  it("uses different emoji per severity", () => {
    const high = buildSignalAlertBlocks({ ...BASE, severity: "high" });
    const medium = buildSignalAlertBlocks({ ...BASE, severity: "medium" });
    const headerText = (blocks: ReturnType<typeof buildSignalAlertBlocks>) => {
      const h = blocks[0];
      return h && h.type === "header" ? h.text.text : "";
    };
    expect(headerText(high)).toContain("HIGH");
    expect(headerText(medium)).toContain("MEDIUM");
    expect(headerText(high)).not.toBe(headerText(medium));
  });

  it("includes signal id + collector in the context block (debug-friendly)", () => {
    const blocks = buildSignalAlertBlocks(BASE);
    const ctx = blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const text =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(text).toContain("signal #42");
    expect(text).toContain("yarn-audit");
    expect(text).toContain("yarn jarvis signals");
  });
});
