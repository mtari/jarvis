import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
