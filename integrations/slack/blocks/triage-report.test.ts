import { describe, expect, it } from "vitest";
import {
  buildTriageReportBlocks,
  convertToMrkdwn,
} from "./triage-report.ts";

describe("convertToMrkdwn", () => {
  it("converts **bold** to *bold*", () => {
    expect(convertToMrkdwn("**HIGH** signal")).toBe("*HIGH* signal");
  });

  it("leaves text without bold markers untouched", () => {
    expect(convertToMrkdwn("plain prose with `code` and links")).toBe(
      "plain prose with `code` and links",
    );
  });

  it("handles multiple bold spans on the same line", () => {
    expect(convertToMrkdwn("**A** and **B**")).toBe("*A* and *B*");
  });

  it("doesn't touch single-asterisk emphasis", () => {
    // Intentional: standard markdown italic vs Slack mrkdwn bold.
    // The triage report doesn't use single-star emphasis, so we
    // leave it as-is.
    expect(convertToMrkdwn("*emphasis*")).toBe("*emphasis*");
  });
});

describe("buildTriageReportBlocks", () => {
  it("emits header / section / context blocks", () => {
    const blocks = buildTriageReportBlocks({
      markdown: "# Triage — 2026-05-04\n\nSome content.",
      date: "2026-05-04",
      filePath: "/data/triage/2026-05-04.md",
    });
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["header", "section", "context"]);
  });

  it("header carries the date and a clipboard emoji marker", () => {
    const blocks = buildTriageReportBlocks({
      markdown: "x",
      date: "2026-05-04",
      filePath: "/x.md",
    });
    const header = blocks[0];
    if (header?.type !== "header") throw new Error("no header");
    expect(header.text.text).toContain("2026-05-04");
    expect(header.text.text).toContain("📋");
  });

  it("converts **bold** in the markdown body to *bold*", () => {
    const blocks = buildTriageReportBlocks({
      markdown:
        "## Critical signals\n- **[HIGH]** demo/yarn-audit — RCE",
      date: "2026-05-04",
      filePath: "/x.md",
    });
    const section = blocks.find((b) => b.type === "section");
    if (!section || section.type !== "section") throw new Error("no section");
    const text =
      "text" in section && section.text && "text" in section.text
        ? section.text.text
        : "";
    expect(text).toContain("*[HIGH]*");
    expect(text).not.toContain("**[HIGH]**");
  });

  it("includes the file path in the context block", () => {
    const blocks = buildTriageReportBlocks({
      markdown: "x",
      date: "2026-05-04",
      filePath: "/Users/me/data/triage/2026-05-04.md",
    });
    const ctx = blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const text =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(text).toContain("/Users/me/data/triage/2026-05-04.md");
    expect(text).toContain("yarn jarvis triage");
  });

  it("truncates a very long body and notes truncation in context", () => {
    const longBody = "x".repeat(5000);
    const blocks = buildTriageReportBlocks({
      markdown: longBody,
      date: "2026-05-04",
      filePath: "/x.md",
    });
    const section = blocks.find((b) => b.type === "section");
    if (!section || section.type !== "section") throw new Error("no section");
    const text =
      "text" in section && section.text && "text" in section.text
        ? section.text.text
        : "";
    expect(text.length).toBeLessThanOrEqual(2800);
    expect(text).toContain("…");

    const ctx = blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const ctxText =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(ctxText).toContain("Truncated");
  });
});
