import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { dbFile } from "../paths.ts";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runInbox } from "./inbox.ts";

describe("runInbox", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let logs: string[];

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    logs = [];
    console.log = (msg?: unknown): void => {
      logs.push(typeof msg === "string" ? msg : String(msg));
    };
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("reports an empty inbox after install", async () => {
    const code = await runInbox([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Inbox is empty");
  });

  it("lists awaiting-review plans only", async () => {
    dropPlan(sandbox, "2026-04-27-alpha", { status: "draft" });
    dropPlan(sandbox, "2026-04-27-beta", {
      status: "awaiting-review",
      title: "Beta",
    });

    logs = [];
    await runInbox([]);
    const out = logs.join("\n");
    expect(out).toContain("Pending plan reviews (1)");
    expect(out).toContain("2026-04-27-beta");
    expect(out).not.toContain("2026-04-27-alpha");
  });

  function recordEvent(planId: string, kind: string): void {
    const conn = new Database(dbFile(sandbox.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind,
        payload: { planId },
      });
    } finally {
      conn.close();
    }
  }

  it("tags plans with a pending amendment as [AMEND] in a separate section", async () => {
    dropPlan(sandbox, "2026-04-27-amend", {
      status: "awaiting-review",
      title: "Amended plan",
    });
    dropPlan(sandbox, "2026-04-27-fresh", {
      status: "awaiting-review",
      title: "Fresh review",
    });
    recordEvent("2026-04-27-amend", "amendment-proposed");

    logs = [];
    await runInbox([]);
    const out = logs.join("\n");
    expect(out).toContain("Pending amendment reviews (1)");
    expect(out).toContain("Pending plan reviews (1)");
    // Amendment row carries [AMEND] tag
    expect(out).toMatch(/2026-04-27-amend.*\[AMEND\]/);
    // Fresh row has no [AMEND] tag
    expect(out).toMatch(/2026-04-27-fresh\b/);
    const freshLine = out
      .split("\n")
      .find((l) => l.includes("2026-04-27-fresh"))!;
    expect(freshLine).not.toContain("[AMEND]");
  });

  it("clears the amendment tag once an amendment-applied event lands", async () => {
    dropPlan(sandbox, "2026-04-27-resolved", {
      status: "awaiting-review",
      title: "Already resolved",
    });
    recordEvent("2026-04-27-resolved", "amendment-proposed");
    recordEvent("2026-04-27-resolved", "amendment-applied");

    logs = [];
    await runInbox([]);
    const out = logs.join("\n");
    // Showed up under regular reviews, not amendment reviews
    expect(out).toContain("Pending plan reviews (1)");
    expect(out).not.toContain("Pending amendment reviews");
  });
});
