import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { notesFile } from "../cli/paths.ts";
import {
  appendNote,
  hasNotes,
  notesContextBlock,
  readNotes,
} from "./notes.ts";

describe("readNotes / hasNotes", () => {
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

  it("returns empty string when the file is missing", () => {
    expect(readNotes(sandbox.dataDir, "personal", "demo")).toBe("");
    expect(hasNotes(sandbox.dataDir, "personal", "demo")).toBe(false);
  });

  it("hasNotes returns false on a whitespace-only file", () => {
    const filePath = notesFile(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(filePath.replace(/\/notes\.md$/, ""), { recursive: true });
    fs.writeFileSync(filePath, "   \n\n   \n");
    expect(hasNotes(sandbox.dataDir, "personal", "demo")).toBe(false);
  });

  it("hasNotes returns true when there's actual content", () => {
    const filePath = notesFile(sandbox.dataDir, "personal", "demo");
    fs.mkdirSync(filePath.replace(/\/notes\.md$/, ""), { recursive: true });
    fs.writeFileSync(filePath, "Real content here.");
    expect(hasNotes(sandbox.dataDir, "personal", "demo")).toBe(true);
  });
});

describe("appendNote", () => {
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

  it("creates the file + writes a timestamped entry on first append", () => {
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "First thought.",
      now: FIXED_NOW,
    });
    const text = readNotes(sandbox.dataDir, "personal", "demo");
    expect(text).toContain("## 2026-05-05T14:00:00.000Z");
    expect(text).toContain("First thought.");
  });

  it("includes actor when provided", () => {
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "via slack",
      now: FIXED_NOW,
      actor: "slack:U-mt",
    });
    const text = readNotes(sandbox.dataDir, "personal", "demo");
    expect(text).toContain("## 2026-05-05T14:00:00.000Z — slack:U-mt");
  });

  it("appends without clobbering prior entries", () => {
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "first",
      now: new Date("2026-05-05T10:00:00Z"),
    });
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "second",
      now: new Date("2026-05-05T11:00:00Z"),
    });
    const text = readNotes(sandbox.dataDir, "personal", "demo");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  it("ignores empty / whitespace-only text", () => {
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "   \n\n   ",
      now: FIXED_NOW,
    });
    expect(hasNotes(sandbox.dataDir, "personal", "demo")).toBe(false);
  });

  it("creates the brain dir if it doesn't exist yet (pre-onboarding workflow)", () => {
    // No brain seeded for "future-app"
    appendNote(sandbox.dataDir, "personal", "future-app", {
      text: "thinking about this one",
      now: FIXED_NOW,
    });
    expect(
      fs.existsSync(notesFile(sandbox.dataDir, "personal", "future-app")),
    ).toBe(true);
  });
});

describe("notesContextBlock", () => {
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

  it("returns null when no notes exist", () => {
    expect(notesContextBlock(sandbox.dataDir, "personal", "demo")).toBeNull();
  });

  it("returns a labelled markdown block when notes exist", () => {
    appendNote(sandbox.dataDir, "personal", "demo", {
      text: "Hypothesis: address-step is the funnel killer.",
      now: new Date("2026-05-05T10:00:00Z"),
    });
    const block = notesContextBlock(sandbox.dataDir, "personal", "demo");
    expect(block).not.toBeNull();
    expect(block).toContain("## Free-text notes for this app");
    expect(block).toContain("address-step is the funnel killer");
    expect(block).toContain("brain is still authoritative");
  });
});
