import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notesFile } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runNotes } from "./notes.ts";

describe("runNotes", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  const FIXED_NOW = new Date("2026-05-05T14:00:00.000Z");

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  it("returns 1 when no app argument is given", async () => {
    expect(await runNotes([])).toBe(1);
  });

  it("rejects empty --append text", async () => {
    expect(await runNotes(["jarvis", "--append", "   "])).toBe(1);
  });

  it("--append writes a timestamped entry to the notes file", async () => {
    const code = await runNotes(
      ["jarvis", "--append", "Try the inline-validation hypothesis."],
      { now: FIXED_NOW },
    );
    expect(code).toBe(0);
    const text = fs.readFileSync(
      notesFile(sandbox.dataDir, "personal", "jarvis"),
      "utf8",
    );
    expect(text).toContain("Try the inline-validation hypothesis");
    expect(text).toContain("## 2026-05-05T14:00:00.000Z");
    expect(text).toContain("cli");
  });

  it("--append appends rather than overwriting existing content", async () => {
    await runNotes(["jarvis", "--append", "first"], {
      now: new Date("2026-05-05T10:00:00Z"),
    });
    await runNotes(["jarvis", "--append", "second"], {
      now: new Date("2026-05-05T11:00:00Z"),
    });
    const text = fs.readFileSync(
      notesFile(sandbox.dataDir, "personal", "jarvis"),
      "utf8",
    );
    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  it("editor mode invokes $EDITOR with the notes file path", async () => {
    let invoked: { editor: string; file: string } | null = null;
    const code = await runNotes(["jarvis"], {
      spawnEditor: (editor, file) => {
        invoked = { editor, file };
        return { status: 0 };
      },
    });
    expect(code).toBe(0);
    expect(invoked).not.toBeNull();
    expect(invoked!.file).toBe(notesFile(sandbox.dataDir, "personal", "jarvis"));
    // First-time editor mode seeds the file with a header
    const text = fs.readFileSync(invoked!.file, "utf8");
    expect(text).toContain("# Notes — jarvis");
  });

  it("editor mode returns 1 when the editor exits non-zero", async () => {
    expect(
      await runNotes(["jarvis"], {
        spawnEditor: () => ({ status: 1 }),
      }),
    ).toBe(1);
  });

  it("--vault routes to the right vault directory", async () => {
    await runNotes(
      ["demo-app", "--vault", "work", "--append", "vault-scoped note"],
      { now: FIXED_NOW },
    );
    expect(
      fs.existsSync(notesFile(sandbox.dataDir, "work", "demo-app")),
    ).toBe(true);
    expect(
      fs.existsSync(notesFile(sandbox.dataDir, "personal", "demo-app")),
    ).toBe(false);
  });
});
