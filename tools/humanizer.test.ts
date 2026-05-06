import { describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import {
  humanize,
  HumanizerError,
  parseHumanizerResponse,
} from "./humanizer.ts";

// ---------------------------------------------------------------------------
// parseHumanizerResponse
// ---------------------------------------------------------------------------

describe("parseHumanizerResponse", () => {
  it("extracts the rewritten text + bullet changes", () => {
    const raw = [
      "<humanized>",
      "We're shipping inline address validation on checkout.",
      "</humanized>",
      "",
      "<changes>",
      "- removed 'leverage' (replaced with 'use')",
      "- cut em-dash overuse in paragraph 1",
      "</changes>",
    ].join("\n");
    const r = parseHumanizerResponse(raw);
    expect(r.text).toBe(
      "We're shipping inline address validation on checkout.",
    );
    expect(r.changes).toEqual([
      "removed 'leverage' (replaced with 'use')",
      "cut em-dash overuse in paragraph 1",
    ]);
  });

  it("returns empty changes on '(none)'", () => {
    const raw = [
      "<humanized>",
      "Already clean.",
      "</humanized>",
      "<changes>",
      "(none)",
      "</changes>",
    ].join("\n");
    const r = parseHumanizerResponse(raw);
    expect(r.text).toBe("Already clean.");
    expect(r.changes).toEqual([]);
  });

  it("returns empty changes on empty body", () => {
    const raw = "<humanized>\nclean\n</humanized>\n<changes>\n\n</changes>";
    expect(parseHumanizerResponse(raw).changes).toEqual([]);
  });

  it("preserves multi-paragraph body", () => {
    const raw = [
      "<humanized>",
      "First paragraph.",
      "",
      "Second paragraph with **bold**.",
      "</humanized>",
      "<changes>",
      "(none)",
      "</changes>",
    ].join("\n");
    const r = parseHumanizerResponse(raw);
    expect(r.text).toBe(
      "First paragraph.\n\nSecond paragraph with **bold**.",
    );
  });

  it("preserves code blocks inside the body", () => {
    const raw = [
      "<humanized>",
      "Use the function:",
      "",
      "```ts",
      "humanize(text);",
      "```",
      "</humanized>",
      "<changes>",
      "- tightened intro line",
      "</changes>",
    ].join("\n");
    const r = parseHumanizerResponse(raw);
    expect(r.text).toContain("```ts");
    expect(r.text).toContain("humanize(text);");
  });

  it("handles `*` and `•` bullet markers", () => {
    const raw = [
      "<humanized>",
      "x",
      "</humanized>",
      "<changes>",
      "* one",
      "• two",
      "- three",
      "</changes>",
    ].join("\n");
    expect(parseHumanizerResponse(raw).changes).toEqual(["one", "two", "three"]);
  });

  it("treats unbulleted lines as continuations of the previous bullet", () => {
    const raw = [
      "<humanized>",
      "x",
      "</humanized>",
      "<changes>",
      "- removed 'leverage'",
      "  (third paragraph)",
      "- cut em-dash overuse",
      "</changes>",
    ].join("\n");
    const changes = parseHumanizerResponse(raw).changes;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain("leverage");
    expect(changes[0]).toContain("third paragraph");
  });

  it("throws when <humanized> is missing", () => {
    expect(() =>
      parseHumanizerResponse("<changes>(none)</changes>"),
    ).toThrow(HumanizerError);
  });

  it("throws when <changes> is missing", () => {
    expect(() =>
      parseHumanizerResponse("<humanized>x</humanized>"),
    ).toThrow(/changes/);
  });

  it("throws on empty <humanized>", () => {
    expect(() =>
      parseHumanizerResponse(
        "<humanized>\n\n</humanized>\n<changes>(none)</changes>",
      ),
    ).toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------
// humanize
// ---------------------------------------------------------------------------

function fakeClient(
  text: string,
): { client: AnthropicClient; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        const r: ChatResponse = {
          text,
          blocks: [{ type: "text", text }],
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
          },
          redactions: [],
        };
        return r;
      },
    },
  };
}

describe("humanize", () => {
  it("returns the rewritten text + changes + bytesDelta", async () => {
    const original = "We leverage cutting-edge solutions to empower users.";
    const rewritten = "We use the system to let users do X.";
    const { client } = fakeClient(
      [
        "<humanized>",
        rewritten,
        "</humanized>",
        "<changes>",
        "- replaced 'leverage' with 'use'",
        "- cut 'cutting-edge solutions'",
        "- replaced 'empower' with concrete action",
        "</changes>",
      ].join("\n"),
    );
    const result = await humanize({ text: original }, { client });
    expect(result.text).toBe(rewritten);
    expect(result.changes).toHaveLength(3);
    expect(result.unchanged).toBe(false);
    expect(result.bytesDelta).toBe(original.length - rewritten.length);
  });

  it("flags unchanged when changes is empty", async () => {
    const { client } = fakeClient(
      [
        "<humanized>",
        "tight already",
        "</humanized>",
        "<changes>",
        "(none)",
        "</changes>",
      ].join("\n"),
    );
    const r = await humanize({ text: "tight already" }, { client });
    expect(r.unchanged).toBe(true);
    expect(r.changes).toEqual([]);
    expect(r.bytesDelta).toBe(0);
  });

  it("short-circuits on empty input without calling the LLM", async () => {
    const { client, calls } = fakeClient("UNUSED");
    const r = await humanize({ text: "" }, { client });
    expect(calls).toHaveLength(0);
    expect(r.text).toBe("");
    expect(r.unchanged).toBe(true);
  });

  it("short-circuits on whitespace-only input", async () => {
    const { client, calls } = fakeClient("UNUSED");
    const r = await humanize({ text: "   \n\n  " }, { client });
    expect(calls).toHaveLength(0);
    expect(r.text).toBe("   \n\n  ");
    expect(r.unchanged).toBe(true);
  });

  it("forwards context tag into the user message", async () => {
    const { client, calls } = fakeClient(
      "<humanized>x</humanized>\n<changes>(none)</changes>",
    );
    await humanize(
      { text: "x", context: "social-post" },
      { client },
    );
    const userMsg = calls[0]?.messages[0];
    expect(userMsg?.role).toBe("user");
    expect(typeof userMsg?.content === "string" ? userMsg.content : "").toContain(
      "social-post",
    );
  });

  it("uses cacheSystem so the prompt stays warm across calls", async () => {
    const { client, calls } = fakeClient(
      "<humanized>x</humanized>\n<changes>(none)</changes>",
    );
    await humanize({ text: "anything" }, { client });
    expect(calls[0]?.cacheSystem).toBe(true);
    expect(typeof calls[0]?.system === "string").toBe(true);
    expect(calls[0]?.system).toContain("Humanizer");
  });

  it("propagates parse errors as HumanizerError", async () => {
    const { client } = fakeClient("just prose, no tags");
    await expect(
      humanize({ text: "anything" }, { client }),
    ).rejects.toThrow(HumanizerError);
  });
});
