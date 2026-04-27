import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyProfileTemplate,
  loadProfile,
  profileSchema,
  saveProfile,
} from "./profile.ts";

describe("profile schema", () => {
  it("fills defaults from a minimal input", () => {
    const profile = profileSchema.parse({ schemaVersion: 1 });
    expect(profile.identity.name).toBe("");
    expect(profile.identity.timezone).toBe("");
    expect(profile.preferences.languageRules).toEqual([]);
    expect(profile.history.pastDecisions).toEqual([]);
    expect(profile.observedPatterns.rejectionReasons).toEqual([]);
  });

  it("preserves user-supplied values", () => {
    const profile = profileSchema.parse({
      schemaVersion: 1,
      identity: { name: "Mihaly", timezone: "Europe/Budapest" },
      preferences: {
        responseStyle: "terse, no fluff",
        languageRules: ["Hungarian informal"],
      },
    });
    expect(profile.identity.name).toBe("Mihaly");
    expect(profile.identity.timezone).toBe("Europe/Budapest");
    expect(profile.preferences.responseStyle).toBe("terse, no fluff");
    expect(profile.preferences.languageRules).toEqual([
      "Hungarian informal",
    ]);
  });

  it("rejects schemaVersion that is not 1", () => {
    expect(() => profileSchema.parse({ schemaVersion: 2 })).toThrow();
  });

  it("rejects missing schemaVersion", () => {
    expect(() => profileSchema.parse({})).toThrow();
  });

  it("emptyProfileTemplate is a fully-structured profile with empty values", () => {
    const empty = emptyProfileTemplate();
    expect(empty.schemaVersion).toBe(1);
    expect(empty.identity.name).toBe("");
    expect(empty.preferences.globalExclusions).toEqual([]);
  });
});

describe("profile IO", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-profile-"));
    file = path.join(dir, "user-profile.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a saved profile", () => {
    const saved = saveProfile(file, {
      schemaVersion: 1,
      identity: { name: "Mihaly" },
    });
    const loaded = loadProfile(file);
    expect(loaded).toEqual(saved);
  });

  it("writes pretty-printed JSON with trailing newline", () => {
    saveProfile(file, { schemaVersion: 1 });
    const text = fs.readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"schemaVersion": 1');
  });

  it("loadProfile rejects a malformed profile on disk", () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99 }));
    expect(() => loadProfile(file)).toThrow();
  });
});
