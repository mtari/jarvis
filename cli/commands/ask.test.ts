import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicClient } from "../../orchestrator/agent-sdk-runtime.ts";
import {
  AskParseError,
  interpretAsk,
  parseAskResponse,
  runAsk,
  tokenizeArgs,
} from "./ask.ts";

// ---------------------------------------------------------------------------
// parseAskResponse — pure parser
// ---------------------------------------------------------------------------

describe("parseAskResponse", () => {
  it("parses a well-formed <run> block", () => {
    const text = [
      "<run>",
      "command: triage",
      "args:",
      "explanation: Show what's on fire across the portfolio.",
      "</run>",
    ].join("\n");
    const result = parseAskResponse(text);
    expect(result).toEqual({
      kind: "run",
      command: "triage",
      argv: ["triage"],
      explanation: "Show what's on fire across the portfolio.",
    });
  });

  it("tokenizes args with quoted strings", () => {
    const text = [
      "<run>",
      "command: notes",
      'args: erdei-fahazak --append "address-step is the funnel killer"',
      "explanation: Add a note to erdei-fahazak.",
      "</run>",
    ].join("\n");
    const result = parseAskResponse(text);
    if (result.kind !== "run") throw new Error("expected run");
    expect(result.argv).toEqual([
      "notes",
      "erdei-fahazak",
      "--append",
      "address-step is the funnel killer",
    ]);
  });

  it("parses a <clarify> block", () => {
    const text = "<clarify>\nWhich app do you mean?\n</clarify>";
    expect(parseAskResponse(text)).toEqual({
      kind: "clarify",
      question: "Which app do you mean?",
    });
  });

  it("parses a <refuse> block", () => {
    const text =
      "<refuse>\nPlan approvals must be explicit. Run `yarn jarvis approve <id>` directly.\n</refuse>";
    const result = parseAskResponse(text);
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toContain("yarn jarvis approve");
    }
  });

  it("throws AskParseError when no recognized block is present", () => {
    expect(() => parseAskResponse("just prose")).toThrow(AskParseError);
  });

  it("throws when <run> block is missing the command line", () => {
    const text = ["<run>", "args: --vault personal", "explanation: x", "</run>"].join("\n");
    expect(() => parseAskResponse(text)).toThrow(/missing.*command/);
  });

  it("throws when <run> block is missing the explanation line", () => {
    const text = ["<run>", "command: triage", "args:", "</run>"].join("\n");
    expect(() => parseAskResponse(text)).toThrow(/missing.*explanation/);
  });

  it("refuses recursive ask at parse time (defense in depth)", () => {
    const text = [
      "<run>",
      "command: ask",
      'args: "what does this do"',
      "explanation: route again",
      "</run>",
    ].join("\n");
    const result = parseAskResponse(text);
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toContain("recursively");
    }
  });

  it("refuse takes precedence when multiple blocks appear (defensive)", () => {
    const text = [
      "<refuse>x</refuse>",
      "<run>command: triage\nargs:\nexplanation: y</run>",
    ].join("\n");
    expect(parseAskResponse(text).kind).toBe("refuse");
  });

  it("throws on empty <clarify> block", () => {
    expect(() => parseAskResponse("<clarify>\n\n</clarify>")).toThrow(
      /empty clarify/,
    );
  });
});

// ---------------------------------------------------------------------------
// tokenizeArgs — argv-shaped split
// ---------------------------------------------------------------------------

describe("tokenizeArgs", () => {
  it("splits on whitespace", () => {
    expect(tokenizeArgs("--app demo --severity high")).toEqual([
      "--app",
      "demo",
      "--severity",
      "high",
    ]);
  });

  it("preserves quoted strings", () => {
    expect(tokenizeArgs('--reason "test reason"')).toEqual([
      "--reason",
      "test reason",
    ]);
  });

  it("handles single quotes too", () => {
    expect(tokenizeArgs("--reason 'another reason'")).toEqual([
      "--reason",
      "another reason",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
  });

  it("handles mixed quoted + unquoted", () => {
    expect(
      tokenizeArgs(
        'erdei-fahazak --append "address-step issue" --vault personal',
      ),
    ).toEqual([
      "erdei-fahazak",
      "--append",
      "address-step issue",
      "--vault",
      "personal",
    ]);
  });
});

// ---------------------------------------------------------------------------
// interpretAsk — single LLM call
// ---------------------------------------------------------------------------

function fakeClient(text: string): AnthropicClient {
  return {
    async chat() {
      return {
        text,
        blocks: [{ type: "text", text }],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
    },
  };
}

describe("interpretAsk", () => {
  it("forwards parsed run interpretations", async () => {
    const client = fakeClient(
      [
        "<run>",
        "command: triage",
        "args:",
        "explanation: Show what's on fire.",
        "</run>",
      ].join("\n"),
    );
    const result = await interpretAsk("what's on fire", client);
    expect(result.kind).toBe("run");
  });

  it("forwards clarify and refuse interpretations", async () => {
    const clarifyClient = fakeClient(
      "<clarify>which app?</clarify>",
    );
    expect((await interpretAsk("show me plans", clarifyClient)).kind).toBe(
      "clarify",
    );
    const refuseClient = fakeClient(
      "<refuse>Approvals must be explicit; use yarn jarvis approve.</refuse>",
    );
    expect((await interpretAsk("approve the funnel", refuseClient)).kind).toBe(
      "refuse",
    );
  });
});

// ---------------------------------------------------------------------------
// runAsk — wiring + dispatch injection
// ---------------------------------------------------------------------------

describe("runAsk", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("rejects empty text", async () => {
    expect(await runAsk([])).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(
      "ask: text required",
    );
  });

  it("dispatches the resolved argv when interpretation is run", async () => {
    const client = fakeClient(
      [
        "<run>",
        "command: triage",
        "args:",
        "explanation: x",
        "</run>",
      ].join("\n"),
    );
    let dispatchedArgv: string[] | null = null;
    const code = await runAsk(["what's pending"], {
      buildClient: () => client,
      dispatch: async (argv) => {
        dispatchedArgv = argv;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(dispatchedArgv).toEqual(["triage"]);
  });

  it("prints the clarify question and exits 0", async () => {
    const client = fakeClient("<clarify>which app?</clarify>");
    const code = await runAsk(["show plans"], { buildClient: () => client });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("which app?");
  });

  it("prints the refuse reason and exits 1", async () => {
    const client = fakeClient(
      "<refuse>Use yarn jarvis approve directly.</refuse>",
    );
    const code = await runAsk(["approve foo"], { buildClient: () => client });
    expect(code).toBe(1);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("yarn jarvis approve");
  });

  it("returns 1 when the LLM response is unparseable", async () => {
    const client = fakeClient("free-form prose");
    const code = await runAsk(["foo"], { buildClient: () => client });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /<run>|<clarify>|<refuse>/,
    );
  });
});
