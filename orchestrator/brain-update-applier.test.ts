import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { brainFile } from "../cli/paths.ts";
import { loadBrain, saveBrain } from "./brain.ts";
import {
  applyBrainUpdates,
  parseBrainChanges,
} from "./brain-update-applier.ts";

function seedBrain(sandbox: InstallSandbox, app: string): void {
  const brainPath = brainFile(sandbox.dataDir, "personal", app);
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  saveBrain(brainPath, {
    schemaVersion: 1,
    projectName: app,
    projectType: "app",
    projectStatus: "active",
    projectPriority: 3,
    userPreferences: { areasOfInterest: ["existing"] },
    connections: {},
    priorities: [],
    wip: {},
  });
}

// ---------------------------------------------------------------------------
// parseBrainChanges
// ---------------------------------------------------------------------------

describe("parseBrainChanges", () => {
  it("returns [] when section is missing", () => {
    expect(parseBrainChanges("# Plan: x\n\n## Problem\nfoo")).toEqual([]);
  });

  it("returns [] when section is present but empty", () => {
    const md = "## Brain changes (proposed)\n\n## Next section\n";
    expect(parseBrainChanges(md)).toEqual([]);
  });

  it("parses a string-quoted refine bullet", () => {
    const md = `## Brain changes (proposed)
- \`brand.voice\`: refine — "warm, factual"

## Next`;
    const changes = parseBrainChanges(md);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "brand.voice",
      op: "refine",
      value: "warm, factual",
    });
  });

  it("parses an array add", () => {
    const md = `## Brain changes (proposed)
- \`scope.userTypes\`: add — ["family", "couples"]
`;
    const c = parseBrainChanges(md)[0];
    expect(c?.op).toBe("add");
    expect(c?.value).toEqual(["family", "couples"]);
  });

  it("parses a number / boolean", () => {
    const md = `## Brain changes (proposed)
- \`projectPriority\`: refine — 5
- \`destructiveOk\`: refine — true
`;
    const changes = parseBrainChanges(md);
    expect(changes[0]?.value).toBe(5);
    expect(changes[1]?.value).toBe(true);
  });

  it("parses a conflict bullet without a value", () => {
    const md = `## Brain changes (proposed)
- \`stack.framework\`: conflict — doc says Next.js 14; brain has 13.5
`;
    const c = parseBrainChanges(md)[0];
    expect(c?.op).toBe("conflict");
    expect(c?.value).toBeUndefined();
    expect(c?.rawValueText).toContain("Next.js 14");
  });

  it("skips malformed lines, keeps well-formed ones", () => {
    const md = `## Brain changes (proposed)
- garbage line with no path
- \`brand.voice\`: refine — "warm"
- another garbage line
`;
    const changes = parseBrainChanges(md);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("brand.voice");
  });

  it("accepts em-dash, en-dash, or hyphen as separator", () => {
    const md = `## Brain changes (proposed)
- \`a\`: refine — "em"
- \`b\`: refine – "en"
- \`c\`: refine - "hyphen"
`;
    const changes = parseBrainChanges(md);
    expect(changes.map((c) => c.value)).toEqual(["em", "en", "hyphen"]);
  });

  it("op matching is case-insensitive", () => {
    const md = `## Brain changes (proposed)
- \`a\`: ADD — "x"
- \`b\`: Refine — "y"
- \`c\`: CONFLICT — z
`;
    const changes = parseBrainChanges(md);
    expect(changes.map((c) => c.op)).toEqual(["add", "refine", "conflict"]);
  });
});

// ---------------------------------------------------------------------------
// applyBrainUpdates
// ---------------------------------------------------------------------------

describe("applyBrainUpdates", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    seedBrain(sandbox, "demo");
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function apply(planMarkdown: string) {
    return applyBrainUpdates({
      dataDir: sandbox.dataDir,
      vault: "personal",
      app: "demo",
      planMarkdown,
    });
  }

  it("hasChanges=false when section missing", () => {
    const r = apply("# Plan: noop\n\n## Problem\nfoo");
    expect(r.hasChanges).toBe(false);
    expect(r.applied).toEqual([]);
  });

  it("applies an add to a new path", () => {
    const r = apply(`## Brain changes (proposed)
- \`brand.voice\`: add — "warm, factual"
`);
    expect(r.applied).toHaveLength(1);
    const after = loadBrain(brainFile(sandbox.dataDir, "personal", "demo"));
    expect(after.brand?.["voice"]).toBe("warm, factual");
  });

  it("applies a refine to an existing path (replaces value)", () => {
    const r = apply(`## Brain changes (proposed)
- \`userPreferences.areasOfInterest\`: refine — ["family", "couples"]
`);
    expect(r.applied).toHaveLength(1);
    const after = loadBrain(brainFile(sandbox.dataDir, "personal", "demo"));
    expect(after.userPreferences.areasOfInterest).toEqual([
      "family",
      "couples",
    ]);
  });

  it("creates intermediate objects for deep paths that don't exist yet", () => {
    const r = apply(`## Brain changes (proposed)
- \`connections.facebook.pageIdEnvVar\`: add — "FB_PAGE_ID_ERDEI"
`);
    expect(r.applied).toHaveLength(1);
    const after = loadBrain(brainFile(sandbox.dataDir, "personal", "demo"));
    expect(after.connections["facebook"]).toBeDefined();
    expect((after.connections["facebook"] as Record<string, unknown>)["pageIdEnvVar"]).toBe(
      "FB_PAGE_ID_ERDEI",
    );
  });

  it("conflict bullets are skipped, not applied", () => {
    const r = apply(`## Brain changes (proposed)
- \`stack.framework\`: conflict — doc says X; brain has Y
`);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain("conflict");
  });

  it("unparseable values are surfaced as errors, not silently skipped", () => {
    const r = apply(`## Brain changes (proposed)
- \`brand.voice\`: refine — bare-unquoted-string
`);
    expect(r.applied).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toContain("couldn't parse");
  });

  it("post-apply schema validation failure reverts ALL changes", () => {
    const r = apply(`## Brain changes (proposed)
- \`projectStatus\`: refine — "frobnicated"
- \`brand.voice\`: refine — "warm"
`);
    // First change violates the projectStatus enum → schema fails →
    // nothing is written, both changes surface as errors.
    expect(r.applied).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
    const after = loadBrain(brainFile(sandbox.dataDir, "personal", "demo"));
    expect(after.brand?.["voice"]).toBeUndefined();
  });

  it("mix of applied + skipped + errors", () => {
    const r = apply(`## Brain changes (proposed)
- \`brand.voice\`: refine — "warm"
- \`stack.framework\`: conflict — disagree
- \`badField\`: refine — also-bare
`);
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });

  it("rejects writing through an array (refuses array indexing via dot path)", () => {
    const r = apply(`## Brain changes (proposed)
- \`userPreferences.areasOfInterest.deep\`: add — "x"
`);
    expect(r.applied).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toContain("array");
  });
});
