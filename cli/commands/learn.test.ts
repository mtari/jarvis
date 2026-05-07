import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { recordFeedback } from "../../orchestrator/feedback-store.ts";
import { runLearn } from "./learn.ts";

describe("runLearn", () => {
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
    expect(await runLearn([])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("missing subcommand");
  });

  it("rejects unknown subcommand", async () => {
    expect(await runLearn(["frobnicate"])).toBe(1);
    expect(
      errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("unknown subcommand");
  });

  it("scan: prints a quiet report when no feedback exists", async () => {
    expect(await runLearn(["scan"])).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Learn scan");
    expect(out).toContain("Feedback:  0 rows");
    expect(out).toContain("none above threshold");
  });

  it("scan: surfaces themes when feedback clusters", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      for (const id of ["p1", "p2", "p3"]) {
        recordFeedback(db, {
          kind: "reject",
          actor: "user",
          targetType: "plan",
          targetId: id,
          note: "scope too broad",
        });
      }
    } finally {
      db.close();
    }
    expect(await runLearn(["scan"])).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Rejection themes");
    expect(out).toContain("scope");
    expect(out).toContain("Recommendations:");
  });

  it("scan: --format json emits valid JSON", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const code = await runLearn(["scan", "--format", "json"]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      const parsed: unknown = JSON.parse(written.trim());
      expect(parsed).toHaveProperty("scannedFeedbackRows");
      expect(parsed).toHaveProperty("rejectionThemes");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("scan: rejects invalid --format", async () => {
    expect(await runLearn(["scan", "--format", "xml"])).toBe(1);
  });

  it("scan: rejects invalid --limit", async () => {
    expect(await runLearn(["scan", "--limit", "abc"])).toBe(1);
  });

  it("scan: --since narrows the window", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      const longAgo = new Date();
      longAgo.setDate(longAgo.getDate() - 60);
      for (const id of ["old-1", "old-2", "old-3"]) {
        recordFeedback(db, {
          kind: "reject",
          actor: "user",
          targetType: "plan",
          targetId: id,
          note: "scope problem",
          createdAt: longAgo.toISOString(),
        });
      }
    } finally {
      db.close();
    }
    const since = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    })();
    expect(await runLearn(["scan", "--since", since])).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    // Old rows excluded → no themes surface.
    expect(out).toContain("none above threshold");
  });

  // -------------------------------------------------------------------------
  // learn draft
  // -------------------------------------------------------------------------

  function fakeMetaClient(): NonNullable<
    NonNullable<Parameters<typeof runLearn>[1]>["buildClient"]
  > {
    const text = `<plan>
# Plan: Add scope-tightening rule
Type: improvement
Subtype: meta
ImplementationReview: skip
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 70 — fixture

## Problem
Recurring scope rejections.

## Build plan
- Add prompt rule.

## Testing strategy
Manual.

## Acceptance criteria
- ok

## Success metric
- Metric: x
- Baseline: x
- Target: x
- Data source: x

## Observation window
30d.

## Connections required
- None: present

## Rollback
Revert.

## Estimated effort
- Claude calls: 1
- Your review time: 5 min
- Wall-clock to ship: minutes

## Amendment clauses
Pause if metric grows.
</plan>`;
    return () =>
      ({
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
      }) as never;
  }

  it("draft: no findings → friendly message + exit 0", async () => {
    const code = await runLearn(["draft"], {
      buildClient: fakeMetaClient(),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("nothing to draft");
  });

  it("draft: drafts a plan when a finding is above threshold", async () => {
    const db = new Database(dbFile(sandbox.dataDir));
    try {
      for (let i = 0; i < 5; i += 1) {
        recordFeedback(db, {
          kind: "reject",
          actor: "user",
          targetType: "plan",
          targetId: `p-${i}`,
          note: "the scope is bad",
        });
      }
    } finally {
      db.close();
    }
    const code = await runLearn(["draft"], {
      buildClient: fakeMetaClient(),
    });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Drafted 1 meta plan(s)");
  });

  it("draft: rejects invalid --threshold", async () => {
    expect(await runLearn(["draft", "--threshold", "abc"])).toBe(1);
  });

  it("draft: rejects invalid --max-drafts", async () => {
    expect(await runLearn(["draft", "--max-drafts", "0"])).toBe(1);
  });
});
