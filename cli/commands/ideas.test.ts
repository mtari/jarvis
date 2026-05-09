import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type {
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
import { runIdeas } from "./ideas.ts";

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
