import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../../cli/commands/_test-helpers.ts";
import { brainDir, brainFile, dbFile } from "../../cli/paths.ts";
import { saveBrain } from "../../orchestrator/brain.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { appendSetupTask } from "../../orchestrator/setup-tasks.ts";
import {
  buildInboxSummaryText,
  buildOnDemandTriageBlocks,
  formatDraftResults,
  formatScoreResults,
  parseScoutFlags,
} from "./slash-commands.ts";

describe("buildInboxSummaryText", () => {
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

  function recordAmendmentProposed(planId: string): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "amendment-proposed",
        payload: { planId, reason: "x", proposal: "y" },
      });
    } finally {
      conn.close();
    }
  }

  it("returns 'Inbox is empty.' when nothing is pending", () => {
    expect(buildInboxSummaryText({ dataDir: sandbox.dataDir })).toBe(
      "Inbox is empty.",
    );
  });

  it("lists awaiting-review plans under 'Pending plan reviews'", () => {
    dropPlan(sandbox, "p-fresh", {
      status: "awaiting-review",
      title: "Fresh plan",
      priority: "high",
    });
    const out = buildInboxSummaryText({ dataDir: sandbox.dataDir });
    expect(out).toContain("Pending plan reviews (1)");
    expect(out).toContain("p-fresh");
    expect(out).toContain("Fresh plan");
    expect(out).toContain("[high]");
  });

  it("separates amendment-state plans into their own section with [AMEND] tag", () => {
    dropPlan(sandbox, "p-amend", {
      status: "awaiting-review",
      title: "Amended plan",
    });
    dropPlan(sandbox, "p-fresh", {
      status: "awaiting-review",
      title: "Fresh plan",
    });
    recordAmendmentProposed("p-amend");
    const out = buildInboxSummaryText({ dataDir: sandbox.dataDir });
    expect(out).toContain("Pending amendment reviews (1)");
    expect(out).toContain("Pending plan reviews (1)");
    expect(out).toMatch(/p-amend.*\*\[AMEND\]\*/);
    const freshLine = out
      .split("\n")
      .find((l) => l.includes("p-fresh"))!;
    expect(freshLine).not.toContain("[AMEND]");
  });

  it("adds a 'Pending setup tasks' section + caps inline at 3", () => {
    for (let i = 0; i < 5; i += 1) {
      appendSetupTask(sandbox.dataDir, {
        id: `task-${i}`,
        title: `task title ${i}`,
        createdAt: `2026-05-05T0${i}:00:00Z`,
      });
    }
    const out = buildInboxSummaryText({ dataDir: sandbox.dataDir });
    expect(out).toContain("Pending setup tasks (5)");
    expect(out).toContain("task-0");
    expect(out).toContain("task-1");
    expect(out).toContain("task-2");
    // Capped — only 3 listed inline, plus a "…and N more." footer
    expect(out).not.toContain("task-3");
    expect(out).toContain("and 2 more");
  });

  it("filters out non-awaiting-review plans (drafts, approved, executing)", () => {
    dropPlan(sandbox, "draft-p", { status: "draft", title: "DRAFT" });
    dropPlan(sandbox, "approved-p", { status: "approved", title: "APPROVED" });
    dropPlan(sandbox, "executing-p", {
      status: "executing",
      title: "EXECUTING",
    });
    expect(buildInboxSummaryText({ dataDir: sandbox.dataDir })).toBe(
      "Inbox is empty.",
    );
  });

  it("ignores amendment-proposed events whose plan is no longer pending", () => {
    // Plan transitioned out of awaiting-review (e.g., approved). The
    // amendment event is still in the log but the plan shouldn't show
    // up in the inbox at all.
    dropPlan(sandbox, "p-approved", {
      status: "approved",
      title: "Approved later",
    });
    recordAmendmentProposed("p-approved");
    expect(buildInboxSummaryText({ dataDir: sandbox.dataDir })).toBe(
      "Inbox is empty.",
    );
  });
});

describe("buildOnDemandTriageBlocks", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  const FIXED_NOW = new Date("2026-05-05T00:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    // makeInstallSandbox seeds a `jarvis` brain — leave it; triage just
    // reads listOnboardedApps + the events table.
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function seedAppBrain(app: string): void {
    fs.mkdirSync(brainDir(sandbox.dataDir, "personal", app), {
      recursive: true,
    });
    saveBrain(brainFile(sandbox.dataDir, "personal", app), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
    });
  }

  it("emits Block Kit with header / section / context blocks", () => {
    const result = buildOnDemandTriageBlocks({
      dataDir: sandbox.dataDir,
      now: FIXED_NOW,
    });
    expect(result.date).toBe("2026-05-05");
    expect(result.text).toContain("on-demand");
    const types = result.blocks.map((b) => b.type);
    expect(types[0]).toBe("header");
    expect(types).toContain("section");
    expect(types).toContain("context");
  });

  it("context block tags the report as on-demand (not a written file)", () => {
    const result = buildOnDemandTriageBlocks({
      dataDir: sandbox.dataDir,
      now: FIXED_NOW,
    });
    const ctx = result.blocks.find((b) => b.type === "context");
    if (!ctx || ctx.type !== "context") throw new Error("no context");
    const text =
      ctx.elements[0] && "text" in ctx.elements[0]
        ? ctx.elements[0].text
        : "";
    expect(text).toContain("(on-demand — not written to disk)");
  });

  it("date in the header matches the now-derived YYYY-MM-DD", () => {
    seedAppBrain("demo");
    const result = buildOnDemandTriageBlocks({
      dataDir: sandbox.dataDir,
      now: FIXED_NOW,
    });
    const header = result.blocks[0];
    if (!header || header.type !== "header") throw new Error("no header");
    expect(header.text.text).toContain("2026-05-05");
  });
});

// ---------------------------------------------------------------------------
// /jarvis scout score|draft helpers
// ---------------------------------------------------------------------------

describe("parseScoutFlags", () => {
  it("returns defaults when no flags are present", () => {
    expect(parseScoutFlags([])).toEqual({ vault: "personal" });
  });

  it("reads --vault", () => {
    expect(parseScoutFlags(["--vault", "work"])).toEqual({ vault: "work" });
  });

  it("reads --threshold as an integer in [0, 100]", () => {
    expect(parseScoutFlags(["--threshold", "75"])).toEqual({
      vault: "personal",
      threshold: 75,
    });
  });

  it("ignores out-of-range or non-numeric thresholds", () => {
    expect(parseScoutFlags(["--threshold", "150"])).toEqual({
      vault: "personal",
    });
    expect(parseScoutFlags(["--threshold", "x"])).toEqual({
      vault: "personal",
    });
  });

  it("reads both flags together in either order", () => {
    expect(
      parseScoutFlags(["--threshold", "60", "--vault", "work"]),
    ).toEqual({ vault: "work", threshold: 60 });
    expect(
      parseScoutFlags(["--vault", "work", "--threshold", "60"]),
    ).toEqual({ vault: "work", threshold: 60 });
  });

  it("ignores unknown flags", () => {
    expect(parseScoutFlags(["--garbage", "x", "--vault", "y"])).toEqual({
      vault: "y",
    });
  });
});

describe("formatScoreResults", () => {
  it("returns the no-op message when there's nothing to score", () => {
    expect(
      formatScoreResults({ scoredCount: 0, errorCount: 0, entries: [] }),
    ).toContain("No unscored ideas");
  });

  it("formats one bullet per entry + a summary footer", () => {
    const out = formatScoreResults({
      scoredCount: 2,
      errorCount: 1,
      entries: [
        {
          ideaId: "first",
          score: 80,
          suggestedPriority: "high",
        },
        {
          ideaId: "second",
          score: 35,
          suggestedPriority: "low",
        },
        { ideaId: "boom", error: "LLM returned malformed response" },
      ],
    });
    expect(out).toContain("✓ `first`");
    expect(out).toContain("score *80*");
    expect(out).toContain("(suggested: high)");
    expect(out).toContain("✓ `second`");
    expect(out).toContain("✗ `boom`");
    expect(out).toContain("Scored 2, 1 error(s)");
  });
});

describe("formatDraftResults", () => {
  it("returns the no-op message when there are no ideas", () => {
    expect(
      formatDraftResults({ draftedCount: 0, errorCount: 0, entries: [] }),
    ).toContain("No ideas in `Business_Ideas.md`");
  });

  it("formats drafted, skipped, and errored entries with distinct markers", () => {
    const out = formatDraftResults({
      draftedCount: 1,
      errorCount: 1,
      entries: [
        { ideaId: "a", planId: "20260505T0900-foo" },
        { ideaId: "b", skippedReason: "below threshold (score 50 < 80)" },
        { ideaId: "c", error: "strategist failed: timeout" },
      ],
    });
    expect(out).toContain("✓ `a` → drafted `20260505T0900-foo`");
    expect(out).toContain("– `b` skipped (below threshold");
    expect(out).toContain("✗ `c` — strategist failed: timeout");
    expect(out).toContain("Drafted 1, 1 error(s)");
  });
});
