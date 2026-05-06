import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { listScheduledPosts } from "../../orchestrator/scheduled-posts.ts";
import { dbFile, planDir } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runMarketer } from "./marketer.ts";

function passthroughClient(): AnthropicClient {
  return {
    async chat(req) {
      const userMsg = req.messages[req.messages.length - 1]?.content;
      const draftText = typeof userMsg === "string" ? userMsg : "";
      const draft = draftText.split("Draft:\n").pop()?.trimEnd() ?? "";
      const text = `<humanized>\n${draft}\n</humanized>\n<changes>\n(none)\n</changes>`;
      const r: ChatResponse = {
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
      return r;
    },
  };
}

function dropMarketingPlan(sandbox: InstallSandbox, id: string): void {
  const folder = planDir(sandbox.dataDir, "personal", "demo");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, `${id}.md`),
    [
      "# Plan: April test",
      "Type: marketing",
      "Subtype: campaign",
      "App: demo",
      "Priority: normal",
      "Destructive: false",
      "Status: approved",
      "Author: strategist",
      "Confidence: 75 — fixture",
      "",
      "## Opportunity",
      "x",
      "",
      "## Audience",
      "x",
      "",
      "## Channels",
      "x",
      "",
      "## Content calendar",
      "### Post 1",
      "Date: 2026-04-08",
      "Channel: facebook",
      "Assets: -",
      "Text:",
      "Hello world.",
      "",
      "## Schedule",
      "x",
      "",
      "## Tracking & KPIs",
      "x",
      "",
      "## Success metric",
      "- Metric: x",
      "- Baseline: x",
      "- Target: x",
      "- Data source: x",
      "",
      "## Observation window",
      "30d.",
      "",
      "## Connections required",
      "- Facebook: present",
      "",
      "## Rollback",
      "x",
      "",
      "## Estimated effort",
      "- Claude calls: ~3",
      "- Your review time: 5 min",
      "- Wall-clock to ship: 1 hour",
      "",
      "## Amendment clauses",
      "x",
      "",
    ].join("\n"),
  );
}

describe("runMarketer", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    silencer.restore();
    sandbox.cleanup();
  });

  it("requires a subcommand", async () => {
    expect(await runMarketer([])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("missing subcommand");
  });

  it("rejects unknown subcommand", async () => {
    expect(await runMarketer(["frobnicate"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("unknown subcommand");
  });

  it("prepare requires a plan-id", async () => {
    expect(await runMarketer(["prepare"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("plan-id");
  });

  it("prepare on a real plan persists rows + reports success", async () => {
    dropMarketingPlan(sandbox, "2026-04-01-april");
    const code = await runMarketer(["prepare", "2026-04-01-april"], {
      client: passthroughClient(),
    });
    expect(code).toBe(0);
    expect(
      logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("Prepared 1 post(s)");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      expect(
        listScheduledPosts(db, { planId: "2026-04-01-april" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("prepare is idempotent — second run reports already-prepared", async () => {
    dropMarketingPlan(sandbox, "2026-04-02-april");
    const code1 = await runMarketer(["prepare", "2026-04-02-april"], {
      client: passthroughClient(),
    });
    expect(code1).toBe(0);
    const code2 = await runMarketer(["prepare", "2026-04-02-april"], {
      client: passthroughClient(),
    });
    expect(code2).toBe(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("already prepared");
  });

  it("prepare on a missing plan exits 1", async () => {
    const code = await runMarketer(["prepare", "ghost-plan"], {
      client: passthroughClient(),
    });
    expect(code).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("not found");
  });
});
