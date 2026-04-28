import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainExists, brainSchema, loadBrain, saveBrain } from "./brain.ts";
import type { BrainInput } from "./brain.ts";

const minimalJarvisBrain: BrainInput = {
  schemaVersion: 1,
  projectName: "jarvis",
  projectType: "other",
  projectStatus: "active",
  projectPriority: 3,
};

describe("brain schema", () => {
  it("parses a minimal brain and applies defaults", () => {
    const parsed = brainSchema.parse(minimalJarvisBrain);
    expect(parsed.userPreferences).toEqual({});
    expect(parsed.connections).toEqual({});
    expect(parsed.priorities).toEqual([]);
    expect(parsed.wip).toEqual({});
  });

  it("rejects a brain missing required fields", () => {
    expect(() => brainSchema.parse({ schemaVersion: 1 })).toThrow();
  });

  it("accepts an optional scope with sub-arrays and a features list", () => {
    const parsed = brainSchema.parse({
      ...minimalJarvisBrain,
      scope: {
        userTypes: ["solo founders", "operators"],
        primaryFlows: ["draft a plan", "approve via Slack"],
        domainRules: ["no destructive ops without confirmation"],
      },
      features: ["plan-review Slack surface", "auto-fire Developer"],
    });
    expect(parsed.scope?.userTypes).toEqual(["solo founders", "operators"]);
    expect(parsed.scope?.primaryFlows).toHaveLength(2);
    expect(parsed.features).toHaveLength(2);
  });

  it("rejects scope with non-string entries", () => {
    expect(() =>
      brainSchema.parse({
        ...minimalJarvisBrain,
        scope: { userTypes: [42, "ok"] },
      }),
    ).toThrow();
  });

  it("rejects features with non-string entries", () => {
    expect(() =>
      brainSchema.parse({
        ...minimalJarvisBrain,
        features: [{ name: "x" }],
      }),
    ).toThrow();
  });

  it("rejects an unknown projectType", () => {
    expect(() =>
      brainSchema.parse({ ...minimalJarvisBrain, projectType: "robot" }),
    ).toThrow();
  });

  it("rejects projectPriority outside 1..5", () => {
    expect(() =>
      brainSchema.parse({ ...minimalJarvisBrain, projectPriority: 0 }),
    ).toThrow();
    expect(() =>
      brainSchema.parse({ ...minimalJarvisBrain, projectPriority: 6 }),
    ).toThrow();
  });

  it("rejects schemaVersion that is not 1", () => {
    expect(() =>
      brainSchema.parse({ ...minimalJarvisBrain, schemaVersion: 2 }),
    ).toThrow();
  });
});

describe("brain IO", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-brain-"));
    file = path.join(dir, "brain.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("brainExists returns false for a missing file, true after save", () => {
    expect(brainExists(file)).toBe(false);
    saveBrain(file, minimalJarvisBrain);
    expect(brainExists(file)).toBe(true);
  });

  it("round-trips save and load", () => {
    const saved = saveBrain(file, minimalJarvisBrain);
    const loaded = loadBrain(file);
    expect(loaded).toEqual(saved);
  });

  it("preserves user-supplied optional fields through round-trip", () => {
    const richer: BrainInput = {
      ...minimalJarvisBrain,
      stack: { runtime: "node22" },
      userPreferences: {
        voiceOverrides: ["Hungarian informal"],
      },
      priorities: [
        { id: "p1", title: "ship M1", score: 90, source: "user-brief" },
      ],
    };
    saveBrain(file, richer);
    const loaded = loadBrain(file);
    expect(loaded.stack).toEqual({ runtime: "node22" });
    expect(loaded.userPreferences.voiceOverrides).toEqual([
      "Hungarian informal",
    ]);
    expect(loaded.priorities).toHaveLength(1);
    expect(loaded.priorities[0]?.id).toBe("p1");
  });

  it("writes pretty-printed JSON with trailing newline", () => {
    saveBrain(file, minimalJarvisBrain);
    const text = fs.readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "projectName": "jarvis"');
  });

  it("loadBrain rejects a malformed brain on disk", () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    expect(() => loadBrain(file)).toThrow();
  });
});
