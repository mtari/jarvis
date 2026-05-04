import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSuppressed,
  listSuppressions,
} from "../../orchestrator/suppressions.ts";
import { dbFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import {
  runSuppress,
  runSuppressions,
  runUnsuppress,
} from "./suppress.ts";

describe("runSuppress", () => {
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

  it("returns 1 when pattern-id is missing", async () => {
    expect(await runSuppress([])).toBe(1);
  });

  it("suppresses a pattern with optional reason", async () => {
    const code = await runSuppress([
      "yarn-audit:CVE-X",
      "--reason",
      "accepted risk",
    ]);
    expect(code).toBe(0);
    expect(isSuppressed(dbFile(sandbox.dataDir), "yarn-audit:CVE-X")).toBe(true);
    const rows = listSuppressions(dbFile(sandbox.dataDir));
    expect(rows[0]?.reason).toBe("accepted risk");
  });

  it("rejects an invalid --expires datetime", async () => {
    expect(
      await runSuppress(["yarn-audit:CVE-X", "--expires", "not-a-date"]),
    ).toBe(1);
  });

  it("accepts and stores a valid --expires datetime", async () => {
    const code = await runSuppress([
      "yarn-audit:CVE-X",
      "--expires",
      "2099-01-01T00:00:00Z",
    ]);
    expect(code).toBe(0);
    const rows = listSuppressions(dbFile(sandbox.dataDir));
    expect(rows[0]?.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });
});

describe("runUnsuppress", () => {
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

  it("returns 1 when pattern-id is missing", async () => {
    expect(await runUnsuppress([])).toBe(1);
  });

  it("returns 1 when no active suppression matches", async () => {
    expect(await runUnsuppress(["no-such-pattern"])).toBe(1);
  });

  it("clears an active suppression", async () => {
    await runSuppress(["yarn-audit:CVE-X"]);
    expect(isSuppressed(dbFile(sandbox.dataDir), "yarn-audit:CVE-X")).toBe(true);
    expect(await runUnsuppress(["yarn-audit:CVE-X"])).toBe(0);
    expect(isSuppressed(dbFile(sandbox.dataDir), "yarn-audit:CVE-X")).toBe(false);
  });

  it("returns 1 on unexpected extra arguments", async () => {
    expect(await runUnsuppress(["yarn-audit:CVE-X", "extra"])).toBe(1);
  });
});

describe("runSuppressions", () => {
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

  it("prints the no-active-suppressions message when nothing exists", async () => {
    expect(await runSuppressions([])).toBe(0);
    expect(logs.join("\n")).toContain("No active suppressions");
  });

  it("lists active suppressions", async () => {
    await runSuppress(["yarn-audit:CVE-X", "--reason", "accepted"]);
    logs.length = 0;
    expect(await runSuppressions([])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("yarn-audit:CVE-X");
    expect(out).toContain("accepted");
  });

  it("--all includes cleared rows", async () => {
    await runSuppress(["x"]);
    await runUnsuppress(["x"]);
    logs.length = 0;
    expect(await runSuppressions([])).toBe(0);
    expect(logs.join("\n")).toContain("No active suppressions");
    logs.length = 0;
    expect(await runSuppressions(["--all"])).toBe(0);
    expect(logs.join("\n")).toContain("[cleared");
  });
});
