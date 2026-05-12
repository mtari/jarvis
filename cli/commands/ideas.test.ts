import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type {
  AnthropicClient,
  ChatResponse,
  RunAgentResult,
  RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import {
  loadBusinessIdeas,
} from "../../orchestrator/business-ideas.ts";
import type { IntakeIO } from "../../agents/intake.ts";
import { businessIdeasFile, dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runIdeas, slugify } from "./ideas.ts";

function fixedRunResult(text: string): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 1,
    durationMs: 1,
    totalCostUsd: 0,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  };
}

function makeIO(answers: ReadonlyArray<string>): IntakeIO {
  let i = 0;
  return {
    readUserAnswer: async () =>
      i < answers.length
        ? { kind: "answer", text: answers[i++]! }
        : { kind: "end" },
    writeOutput: () => {},
  };
}

describe("runIdeas", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("rejects unknown subcommands and missing subcommands", async () => {
    expect(await runIdeas([])).toBe(1);
    expect(await runIdeas(["unknown"])).toBe(1);
  });

  it("ideas list prints scored ideas first, then unscored — table format", async () => {
    fs.writeFileSync(
      `${sandbox.dataDir}/Business_Ideas.md`,
      `## Low score
App: a
Brief: low
Score: 30

## High score
App: a
Brief: high
Score: 90

## Unscored
App: a
Brief: ?

`,
    );
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const code = await runIdeas(["list"]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    const text = lines.join("\n");
    const highIdx = text.indexOf("High score");
    const lowIdx = text.indexOf("Low score");
    const unscoredIdx = text.indexOf("Unscored");
    expect(highIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(lowIdx);
    expect(lowIdx).toBeLessThan(unscoredIdx);
    expect(text).toContain("3 idea(s)");
  });

  it("ideas list --format json emits structured records", async () => {
    fs.writeFileSync(
      `${sandbox.dataDir}/Business_Ideas.md`,
      `## A
App: x
Brief: y
Score: 70

`,
    );
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const code = await runIdeas(["list", "--format", "json"]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(lines.join("\n")) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.["title"]).toBe("A");
    expect(parsed[0]?.["score"]).toBe(70);
    expect(parsed[0]?.["drafted"]).toBe(false);
  });

  it("ideas list --format invalid returns exit 1", async () => {
    expect(await runIdeas(["list", "--format", "csv"])).toBe(1);
  });

  it("appends a new idea to Business_Ideas.md and records an idea-added event", async () => {
    const transport: RunAgentTransport = (() => {
      const responses = [
        `<ask>Title and app?</ask>`,
        `<idea>
Title: Personal-brand newsletter
App: new
Brief: Weekly behind-the-scenes letter on solo product-building.
Tags: brand, content

Audience: indie devs. Effort: 2h/week. No deps.
</idea>`,
      ];
      let i = 0;
      return async () => fixedRunResult(responses[i++]!);
    })();

    const code = await runIdeas(["add"], {
      transport,
      io: makeIO(["Personal-brand newsletter, new project"]),
      hasTty: () => true,
    });
    expect(code).toBe(0);

    const file = loadBusinessIdeas(sandbox.dataDir);
    expect(file.ideas).toHaveLength(1);
    expect(file.ideas[0]?.title).toBe("Personal-brand newsletter");
    expect(file.ideas[0]?.app).toBe("new");
    expect(file.ideas[0]?.tags).toEqual(["brand", "content"]);
    expect(file.ideas[0]?.body).toContain("indie devs");

    // The on-disk file is well-formed
    const text = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");
    expect(text).toContain("## Personal-brand newsletter");
    expect(text).toContain("App: new");
    expect(text).toContain("Brief: Weekly");

    // Audit-trail event
    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'idea-added'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        title: "Personal-brand newsletter",
        app: "new",
        tags: ["brand", "content"],
      });
    } finally {
      db.close();
    }
  });

  it("preserves existing ideas when appending a new one", async () => {
    // Seed one idea into the file
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `# Business Ideas

## Existing idea
App: erdei-fahazak
Brief: An older idea.

Old body.

`,
    );

    const transport: RunAgentTransport = (() => {
      const responses = [
        `<ask>Title?</ask>`,
        `<idea>
Title: New idea
App: erdei-fahazak
Brief: Brand new.

Body.
</idea>`,
      ];
      let i = 0;
      return async () => fixedRunResult(responses[i++]!);
    })();

    const code = await runIdeas(["add"], {
      transport,
      io: makeIO(["title here"]),
      hasTty: () => true,
    });
    expect(code).toBe(0);

    const file = loadBusinessIdeas(sandbox.dataDir);
    expect(file.ideas).toHaveLength(2);
    expect(file.ideas.map((i) => i.title)).toEqual([
      "Existing idea",
      "New idea",
    ]);
  });

  it("disambiguates ids on title collision", async () => {
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `## Same title
App: a
Brief: first

`,
    );

    const transport: RunAgentTransport = (() => {
      const responses = [
        `<ask>?</ask>`,
        `<idea>
Title: Same title
App: b
Brief: second

body
</idea>`,
      ];
      let i = 0;
      return async () => fixedRunResult(responses[i++]!);
    })();

    await runIdeas(["add"], {
      transport,
      io: makeIO(["x"]),
      hasTty: () => true,
    });

    const file = loadBusinessIdeas(sandbox.dataDir);
    expect(file.ideas.map((i) => i.id)).toEqual(["same-title", "same-title-2"]);
  });

  it("refuses to run without a TTY when no IO override is provided", async () => {
    expect(
      await runIdeas(["add"], {
        hasTty: () => false,
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ideas edit tests
// ---------------------------------------------------------------------------

const SCORE_RESPONSE_TEXT = `<score>${JSON.stringify({
  score: 75,
  rationale: "Good strategic fit.",
  suggestedPriority: "normal",
})}</score>`;

function makeScoutClient(): AnthropicClient {
  return {
    async chat(): Promise<ChatResponse> {
      return {
        text: SCORE_RESPONSE_TEXT,
        blocks: [{ type: "text", text: SCORE_RESPONSE_TEXT }],
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

const SEEDED_IDEA = `## Original Title
App: myapp
Brief: Original brief.
Score: 60
ScoredAt: 2026-01-01T00:00:00Z
Rationale: Old rationale.

Original body.

`;

describe("ideas edit", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("happy-path: edit mutates title + body, strips Score/ScoredAt/Rationale", async () => {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), SEEDED_IDEA);

    const code = await runIdeas(["edit", "original-title"], {
      spawnEditor: (_editor, file) => {
        fs.writeFileSync(
          file,
          `## Updated Title\nApp: myapp\nBrief: Updated brief.\n\nUpdated body.\n`,
        );
        return { status: 0 };
      },
    });

    expect(code).toBe(0);
    const loaded = loadBusinessIdeas(sandbox.dataDir);
    expect(loaded.ideas).toHaveLength(1);
    expect(loaded.ideas[0]?.title).toBe("Updated Title");
    expect(loaded.ideas[0]?.brief).toBe("Updated brief.");
    expect(loaded.ideas[0]?.body).toBe("Updated body.");
    expect(loaded.ideas[0]?.score).toBeUndefined();
    expect(loaded.ideas[0]?.scoredAt).toBeUndefined();
    expect(loaded.ideas[0]?.rationale).toBeUndefined();
    expect(loaded.ideas[0]?.id).toBe("updated-title");
    expect(loaded.ideas.find((i) => i.id === "original-title")).toBeUndefined();
  });

  it("no-op when editor exits 0 with unchanged content", async () => {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), SEEDED_IDEA);
    const beforeFile = loadBusinessIdeas(sandbox.dataDir);

    const code = await runIdeas(["edit", "original-title"], {
      spawnEditor: (_editor, _file) => ({ status: 0 }),
    });

    expect(code).toBe(0);
    const afterFile = loadBusinessIdeas(sandbox.dataDir);
    expect(afterFile.ideas).toEqual(beforeFile.ideas);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'idea-edited'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("--rescore invokes buildScoutClient exactly once and prints score line", async () => {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), SEEDED_IDEA);

    let clientCalls = 0;
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };

    try {
      const code = await runIdeas(["edit", "original-title", "--rescore"], {
        spawnEditor: (_editor, file) => {
          fs.writeFileSync(file, `## Original Title\nApp: myapp\nBrief: Changed brief.\n`);
          return { status: 0 };
        },
        buildScoutClient: () => {
          clientCalls += 1;
          return makeScoutClient();
        },
      });
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }

    expect(clientCalls).toBe(1);
    expect(lines.some((l) => l.includes("score"))).toBe(true);
  });

  it("title change recomputes id, old id no longer resolves", async () => {
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `## Old Title\nApp: a\nBrief: b.\n`,
    );

    const code = await runIdeas(["edit", "old-title"], {
      spawnEditor: (_editor, file) => {
        fs.writeFileSync(file, `## New Title\nApp: a\nBrief: b.\n`);
        return { status: 0 };
      },
    });

    expect(code).toBe(0);
    const loaded = loadBusinessIdeas(sandbox.dataDir);
    expect(loaded.ideas.find((i) => i.id === "new-title")).toBeDefined();
    expect(loaded.ideas.find((i) => i.id === "old-title")).toBeUndefined();
  });

  it("id collision after rename disambiguates with -2 suffix", async () => {
    fs.writeFileSync(
      businessIdeasFile(sandbox.dataDir),
      `## Alpha\nApp: a\nBrief: x.\n\n## Beta\nApp: a\nBrief: y.\n`,
    );

    const code = await runIdeas(["edit", "alpha"], {
      spawnEditor: (_editor, file) => {
        fs.writeFileSync(file, `## Beta\nApp: a\nBrief: x renamed.\n`);
        return { status: 0 };
      },
    });

    expect(code).toBe(0);
    const loaded = loadBusinessIdeas(sandbox.dataDir);
    const ids = loaded.ideas.map((i) => i.id).sort();
    expect(ids).toContain("beta");
    expect(ids).toContain("beta-2");
  });

  it("editor non-zero exit aborts, original file untouched, exits 1", async () => {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), SEEDED_IDEA);
    const beforeText = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");

    const code = await runIdeas(["edit", "original-title"], {
      spawnEditor: () => ({ status: 1 }),
    });

    expect(code).toBe(1);
    const afterText = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");
    expect(afterText).toBe(beforeText);
  });

  it("parse failure on edited buffer aborts with exit 1, original file untouched", async () => {
    fs.writeFileSync(businessIdeasFile(sandbox.dataDir), SEEDED_IDEA);
    const beforeText = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");

    const code = await runIdeas(["edit", "original-title"], {
      spawnEditor: (_editor, file) => {
        fs.writeFileSync(file, `## \nApp: myapp\nBrief: missing title.\n`);
        return { status: 0 };
      },
    });

    expect(code).toBe(1);
    const afterText = fs.readFileSync(businessIdeasFile(sandbox.dataDir), "utf8");
    expect(afterText).toBe(beforeText);
  });
});

describe("slugify", () => {
  it("never produces a trailing dash when slice lands on a dash boundary", () => {
    // 60 chars of "a-b-c-..." — make a title long enough that the 60th char is a dash
    const title = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeeee fffff";
    const result = slugify(title);
    expect(result).not.toMatch(/-$/);
    expect(result).not.toMatch(/^-/);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("never produces a leading dash", () => {
    expect(slugify("---hello world")).not.toMatch(/^-/);
  });
});

