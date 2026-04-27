import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropPlan,
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runBacklog } from "./backlog.ts";

describe("runBacklog", () => {
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

  it("requires --app", async () => {
    expect(await runBacklog([])).toBe(1);
  });

  it("rejects --meta-only + --no-meta together", async () => {
    expect(
      await runBacklog(["--app", "jarvis", "--meta-only", "--no-meta"]),
    ).toBe(1);
  });

  it("shows empty product backlog + empty meta queue on a fresh app", async () => {
    expect(await runBacklog(["--app", "jarvis"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(
      "Product backlog for jarvis (0/3, 3 slots open)",
    );
    expect(out).toContain("Meta queue for jarvis: (empty)");
  });

  it("counts a single awaiting-review improvement plan in the product backlog", async () => {
    dropPlan(sandbox, "2026-04-27-one", { status: "awaiting-review" });
    await runBacklog(["--app", "jarvis"]);
    const out = logs.join("\n");
    expect(out).toContain("(1/3, 2 slots open)");
    expect(out).toContain("2026-04-27-one");
  });

  it("hits the cap header when exactly 3 are queued", async () => {
    dropPlan(sandbox, "2026-04-27-a", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-27-b", { status: "approved" });
    dropPlan(sandbox, "2026-04-27-c", { status: "awaiting-review" });
    await runBacklog(["--app", "jarvis"]);
    expect(logs.join("\n")).toContain("(3/3)");
  });

  it("warns when over the 3-cap", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      dropPlan(sandbox, `2026-04-27-${id}`, { status: "awaiting-review" });
    }
    await runBacklog(["--app", "jarvis"]);
    expect(logs.join("\n")).toContain("(4/3, ⚠ 1 over cap)");
  });

  it("orders by priority: blocking → high → normal → low", async () => {
    dropPlan(sandbox, "2026-04-27-low", {
      status: "awaiting-review",
      priority: "low",
    });
    dropPlan(sandbox, "2026-04-27-block", {
      status: "awaiting-review",
      priority: "blocking",
    });
    dropPlan(sandbox, "2026-04-27-high", {
      status: "awaiting-review",
      priority: "high",
    });
    dropPlan(sandbox, "2026-04-27-norm", {
      status: "awaiting-review",
      priority: "normal",
    });
    await runBacklog(["--app", "jarvis"]);
    const out = logs.join("\n");
    const blockIdx = out.indexOf("2026-04-27-block");
    const highIdx = out.indexOf("2026-04-27-high");
    const normIdx = out.indexOf("2026-04-27-norm");
    const lowIdx = out.indexOf("2026-04-27-low");
    expect(blockIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(normIdx);
    expect(normIdx).toBeLessThan(lowIdx);
  });

  it("excludes meta-subtype plans from the product backlog and lists them in meta queue", async () => {
    dropPlan(sandbox, "2026-04-27-product", {
      status: "awaiting-review",
      subtype: "new-feature",
    });
    dropPlan(sandbox, "2026-04-27-meta", {
      status: "awaiting-review",
      subtype: "meta",
    });
    await runBacklog(["--app", "jarvis"]);
    const out = logs.join("\n");
    expect(out).toContain("(1/3, 2 slots open)");
    expect(out).toContain("2026-04-27-product");
    expect(out).toContain("Meta queue for jarvis (1, uncapped)");
    expect(out).toContain("2026-04-27-meta");
  });

  it("--meta-only hides the product backlog", async () => {
    dropPlan(sandbox, "2026-04-27-product", { status: "awaiting-review" });
    dropPlan(sandbox, "2026-04-27-meta", {
      status: "awaiting-review",
      subtype: "meta",
    });
    await runBacklog(["--app", "jarvis", "--meta-only"]);
    const out = logs.join("\n");
    expect(out).not.toContain("Product backlog");
    expect(out).toContain("Meta queue");
  });

  it("--no-meta hides the meta queue", async () => {
    dropPlan(sandbox, "2026-04-27-meta", {
      status: "awaiting-review",
      subtype: "meta",
    });
    await runBacklog(["--app", "jarvis", "--no-meta"]);
    const out = logs.join("\n");
    expect(out).toContain("Product backlog");
    expect(out).not.toContain("Meta queue");
  });

  it("filters out plans for other apps", async () => {
    dropPlan(sandbox, "2026-04-27-mine", {
      status: "awaiting-review",
      app: "jarvis",
    });
    dropPlan(sandbox, "2026-04-27-other", {
      status: "awaiting-review",
      app: "other-app",
    });
    await runBacklog(["--app", "jarvis"]);
    const out = logs.join("\n");
    expect(out).toContain("2026-04-27-mine");
    expect(out).not.toContain("2026-04-27-other");
  });

  it("excludes terminal-state plans (done/rejected/cancelled) from both sections", async () => {
    dropPlan(sandbox, "2026-04-27-done", { status: "done" });
    dropPlan(sandbox, "2026-04-27-rejected", { status: "rejected" });
    dropPlan(sandbox, "2026-04-27-active", { status: "awaiting-review" });
    await runBacklog(["--app", "jarvis"]);
    const out = logs.join("\n");
    expect(out).toContain("(1/3, 2 slots open)");
    expect(out).toContain("2026-04-27-active");
    expect(out).not.toContain("2026-04-27-done");
    expect(out).not.toContain("2026-04-27-rejected");
  });
});
