import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/agent-sdk-runtime.ts";
import { parsePlan } from "../orchestrator/plan.ts";
import { listScheduledPosts } from "../orchestrator/scheduled-posts.ts";
import { dbFile, planDir } from "../cli/paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import {
  MarketerError,
  parseContentCalendar,
  prepareMarketingPlan,
  SUPPORTED_CHANNELS,
} from "./marketer.ts";

// ---------------------------------------------------------------------------
// Mock LLM client — humanizer always returns input verbatim with `(none)`
// ---------------------------------------------------------------------------

function passthroughHumanizerClient(): {
  client: AnthropicClient;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
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

function rewritingHumanizerClient(rewritten: string): {
  client: AnthropicClient;
} {
  return {
    client: {
      async chat() {
        const text = `<humanized>\n${rewritten}\n</humanized>\n<changes>\n- replaced filler\n</changes>`;
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

// ---------------------------------------------------------------------------
// Plan fixture
// ---------------------------------------------------------------------------

function marketingPlanText(overrides: { calendar?: string; status?: string; subtype?: string } = {}): string {
  const status = overrides.status ?? "approved";
  const subtype = overrides.subtype ?? "campaign";
  const calendar =
    overrides.calendar ??
    [
      "### Post 1",
      "Date: 2026-04-08",
      "Channel: facebook",
      "Assets: -",
      "Text:",
      "First post text. Multi-line allowed.",
      "",
      "Second paragraph.",
      "",
      "### Post 2",
      "Date: 2026-04-15",
      "Channel: instagram",
      "Assets: hero.jpg, secondary.jpg",
      "Text:",
      "Second post.",
    ].join("\n");
  return [
    "# Plan: April 2026 campaign",
    "Type: marketing",
    `Subtype: ${subtype}`,
    "App: demo",
    "Priority: normal",
    "Destructive: false",
    `Status: ${status}`,
    "Author: strategist",
    "Confidence: 75 — campaign for April",
    "",
    "## Opportunity",
    "Drive bookings.",
    "",
    "## Audience",
    "Local families.",
    "",
    "## Channels",
    "Facebook + Instagram.",
    "",
    "## Content calendar",
    calendar,
    "",
    "## Schedule",
    "Two posts per week.",
    "",
    "## Tracking & KPIs",
    "Bookings.",
    "",
    "## Success metric",
    "- Metric: bookings",
    "- Baseline: 12/mo",
    "- Target: 18/mo",
    "- Data source: dashboard",
    "",
    "## Observation window",
    "45d.",
    "",
    "## Connections required",
    "- Facebook: present",
    "",
    "## Rollback",
    "Pause and delete posts.",
    "",
    "## Estimated effort",
    "- Claude calls: ~10",
    "- Your review time: 30 min",
    "- Wall-clock to ship: 2 days",
    "",
    "## Amendment clauses",
    "Pause if a post underperforms sharply.",
    "",
  ].join("\n");
}

function dropPlan(sandbox: InstallSandbox, id: string, text: string): string {
  const folder = planDir(sandbox.dataDir, "personal", "demo");
  fs.mkdirSync(folder, { recursive: true });
  const planPath = path.join(folder, `${id}.md`);
  fs.writeFileSync(planPath, text);
  return planPath;
}

// ---------------------------------------------------------------------------
// parseContentCalendar
// ---------------------------------------------------------------------------

describe("parseContentCalendar", () => {
  it("extracts entries with date / channel / assets / text", () => {
    const plan = parsePlan(marketingPlanText());
    const entries = parseContentCalendar(plan);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      index: 1,
      date: "2026-04-08",
      channel: "facebook",
      assets: [],
    });
    expect(entries[0]?.text).toContain("First post text");
    expect(entries[0]?.text).toContain("Second paragraph");
    expect(entries[1]?.assets).toEqual(["hero.jpg", "secondary.jpg"]);
  });

  it("returns [] when the plan has no Content calendar section", () => {
    const text = marketingPlanText();
    const stripped = text.replace(/## Content calendar[\s\S]*?(\n## Schedule)/, "$1");
    const plan = parsePlan(stripped);
    expect(parseContentCalendar(plan)).toEqual([]);
  });

  it("returns [] when the section has no `### Post` blocks", () => {
    const plan = parsePlan(marketingPlanText({ calendar: "(no posts yet)" }));
    expect(parseContentCalendar(plan)).toEqual([]);
  });

  it("rejects an unknown channel", () => {
    const plan = parsePlan(
      marketingPlanText({
        calendar: [
          "### Post 1",
          "Date: 2026-04-08",
          "Channel: tiktok",
          "Assets: -",
          "Text:",
          "x",
        ].join("\n"),
      }),
    );
    expect(() => parseContentCalendar(plan)).toThrow(/tiktok/);
  });

  it("rejects malformed Date", () => {
    const plan = parsePlan(
      marketingPlanText({
        calendar: [
          "### Post 1",
          "Date: April 8",
          "Channel: facebook",
          "Assets: -",
          "Text:",
          "x",
        ].join("\n"),
      }),
    );
    expect(() => parseContentCalendar(plan)).toThrow(/ISO YYYY-MM-DD/);
  });

  it("rejects missing Text marker", () => {
    const plan = parsePlan(
      marketingPlanText({
        calendar: [
          "### Post 1",
          "Date: 2026-04-08",
          "Channel: facebook",
          "Assets: -",
          "Just prose without Text marker",
        ].join("\n"),
      }),
    );
    expect(() => parseContentCalendar(plan)).toThrow(/Text/);
  });

  it("rejects empty post body", () => {
    const plan = parsePlan(
      marketingPlanText({
        calendar: [
          "### Post 1",
          "Date: 2026-04-08",
          "Channel: facebook",
          "Assets: -",
          "Text:",
          "",
        ].join("\n"),
      }),
    );
    expect(() => parseContentCalendar(plan)).toThrow(/empty post body/);
  });

  it("normalises channel to lowercase", () => {
    const plan = parsePlan(
      marketingPlanText({
        calendar: [
          "### Post 1",
          "Date: 2026-04-08",
          "Channel: Facebook",
          "Assets: -",
          "Text:",
          "x",
        ].join("\n"),
      }),
    );
    expect(parseContentCalendar(plan)[0]?.channel).toBe("facebook");
  });

  it("supports all SUPPORTED_CHANNELS", () => {
    const blocks = SUPPORTED_CHANNELS.map((ch, i) =>
      [
        `### Post ${i + 1}`,
        `Date: 2026-04-${String(i + 1).padStart(2, "0")}`,
        `Channel: ${ch}`,
        "Assets: -",
        "Text:",
        `body for ${ch}`,
      ].join("\n"),
    );
    const plan = parsePlan(
      marketingPlanText({ calendar: blocks.join("\n\n") }),
    );
    expect(parseContentCalendar(plan)).toHaveLength(SUPPORTED_CHANNELS.length);
  });
});

// ---------------------------------------------------------------------------
// prepareMarketingPlan
// ---------------------------------------------------------------------------

describe("prepareMarketingPlan", () => {
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

  it("end-to-end: parses, humanizes, persists pending rows", async () => {
    dropPlan(sandbox, "2026-04-01-april-campaign", marketingPlanText());
    const { client } = passthroughHumanizerClient();

    const result = await prepareMarketingPlan({
      client,
      planId: "2026-04-01-april-campaign",
      dataDir: sandbox.dataDir,
    });

    expect(result.alreadyPrepared).toBe(false);
    expect(result.prepared).toHaveLength(2);
    expect(result.prepared[0]?.unchanged).toBe(true);
    expect(result.prepared[0]?.scheduledAt).toBe("2026-04-08T09:00:00.000Z");

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = listScheduledPosts(db, {
        planId: "2026-04-01-april-campaign",
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.status).toBe("pending");
      expect(rows[0]?.appId).toBe("demo");
      expect(rows[0]?.channel).toBe("facebook");
      expect(rows[1]?.assets).toEqual(["hero.jpg", "secondary.jpg"]);

      // post-prepared event recorded for each row
      const events = db
        .prepare("SELECT payload FROM events WHERE kind = 'post-prepared'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("stores humanized text when humanizer rewrites", async () => {
    dropPlan(sandbox, "rewrite-test", marketingPlanText());
    const { client } = rewritingHumanizerClient("Cleaned up post.");
    const result = await prepareMarketingPlan({
      client,
      planId: "rewrite-test",
      dataDir: sandbox.dataDir,
    });
    expect(result.prepared[0]?.humanizedText).toBe("Cleaned up post.");
    expect(result.prepared[0]?.unchanged).toBe(false);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = listScheduledPosts(db, { planId: "rewrite-test" });
      expect(rows[0]?.content).toBe("Cleaned up post.");
    } finally {
      db.close();
    }
  });

  it("is idempotent — re-running skips when rows exist", async () => {
    dropPlan(sandbox, "idempotency-test", marketingPlanText());
    const { client } = passthroughHumanizerClient();
    await prepareMarketingPlan({
      client,
      planId: "idempotency-test",
      dataDir: sandbox.dataDir,
    });
    const second = await prepareMarketingPlan({
      client,
      planId: "idempotency-test",
      dataDir: sandbox.dataDir,
    });
    expect(second.alreadyPrepared).toBe(true);
    expect(second.existingCount).toBe(2);
    expect(second.prepared).toEqual([]);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      expect(
        listScheduledPosts(db, { planId: "idempotency-test" }),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("rejects non-marketing plan", async () => {
    const text = marketingPlanText().replace(
      "Type: marketing\nSubtype: campaign",
      "Type: improvement\nSubtype: new-feature\nImplementationReview: required",
    );
    dropPlan(sandbox, "not-marketing", text);
    const { client } = passthroughHumanizerClient();
    await expect(
      prepareMarketingPlan({
        client,
        planId: "not-marketing",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(MarketerError);
  });

  it("rejects plan with wrong status", async () => {
    dropPlan(
      sandbox,
      "draft-state",
      marketingPlanText({ status: "draft" }),
    );
    const { client } = passthroughHumanizerClient();
    await expect(
      prepareMarketingPlan({
        client,
        planId: "draft-state",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/approved.*executing/);
  });

  it("rejects plan with no Content calendar entries", async () => {
    dropPlan(
      sandbox,
      "empty-cal",
      marketingPlanText({ calendar: "(empty)" }),
    );
    const { client } = passthroughHumanizerClient();
    await expect(
      prepareMarketingPlan({
        client,
        planId: "empty-cal",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/no parseable Content calendar/);
  });

  it("throws MarketerError on missing plan", async () => {
    const { client } = passthroughHumanizerClient();
    await expect(
      prepareMarketingPlan({
        client,
        planId: "ghost",
        dataDir: sandbox.dataDir,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("uses single-post status: executing too", async () => {
    dropPlan(
      sandbox,
      "single-post-test",
      marketingPlanText({ status: "executing", subtype: "single-post" }),
    );
    const { client } = passthroughHumanizerClient();
    const result = await prepareMarketingPlan({
      client,
      planId: "single-post-test",
      dataDir: sandbox.dataDir,
    });
    expect(result.alreadyPrepared).toBe(false);
    expect(result.prepared.length).toBeGreaterThan(0);
  });
});
