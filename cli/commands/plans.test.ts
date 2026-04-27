import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runPlans } from "./plans.ts";

describe("runPlans", () => {
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

  it("prints 'No plans match' when nothing exists", async () => {
    const code = await runPlans([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No plans match");
  });

  it("lists plans and renders a table by default", async () => {
    dropPlan(sandbox, "2026-04-27-alpha", { title: "Alpha", status: "draft" });
    dropPlan(sandbox, "2026-04-27-beta", {
      title: "Beta",
      status: "awaiting-review",
    });

    const code = await runPlans([]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("ID");
    expect(out).toContain("STATUS");
    expect(out).toContain("2026-04-27-alpha");
    expect(out).toContain("2026-04-27-beta");
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
  });

  it("filters by --status", async () => {
    dropPlan(sandbox, "2026-04-27-alpha", { status: "draft" });
    dropPlan(sandbox, "2026-04-27-beta", { status: "awaiting-review" });

    logs = [];
    await runPlans(["--status", "draft"]);
    const out = logs.join("\n");
    expect(out).toContain("2026-04-27-alpha");
    expect(out).not.toContain("2026-04-27-beta");
  });

  it("--pending-review is a shortcut for --status awaiting-review", async () => {
    dropPlan(sandbox, "2026-04-27-alpha", { status: "draft" });
    dropPlan(sandbox, "2026-04-27-beta", { status: "awaiting-review" });

    logs = [];
    await runPlans(["--pending-review"]);
    const out = logs.join("\n");
    expect(out).not.toContain("2026-04-27-alpha");
    expect(out).toContain("2026-04-27-beta");
  });

  it("emits JSON with --format json", async () => {
    dropPlan(sandbox, "2026-04-27-alpha", {
      title: "Alpha",
      status: "approved",
    });

    logs = [];
    const code = await runPlans(["--format", "json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as Array<Record<string, string>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("2026-04-27-alpha");
    expect(parsed[0]?.status).toBe("approved");
  });

  it("rejects an invalid --status value", async () => {
    const code = await runPlans(["--status", "elsewhere"]);
    expect(code).toBe(1);
  });
});
