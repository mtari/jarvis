import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brainExists,
  brainSchema,
  listOnboardedApps,
  loadBrain,
  saveBrain,
} from "./brain.ts";
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

  it("accepts an optional repo with rootPath + monorepoPath", () => {
    const parsed = brainSchema.parse({
      ...minimalJarvisBrain,
      repo: {
        rootPath: "/Users/me/projects/myapp",
        monorepoPath: "apps/myapp",
      },
    });
    expect(parsed.repo?.rootPath).toBe("/Users/me/projects/myapp");
    expect(parsed.repo?.monorepoPath).toBe("apps/myapp");
  });

  it("repo.monorepoPath is optional", () => {
    const parsed = brainSchema.parse({
      ...minimalJarvisBrain,
      repo: { rootPath: "/abs/path" },
    });
    expect(parsed.repo?.rootPath).toBe("/abs/path");
    expect(parsed.repo?.monorepoPath).toBeUndefined();
  });

  it("rejects repo with empty rootPath", () => {
    expect(() =>
      brainSchema.parse({
        ...minimalJarvisBrain,
        repo: { rootPath: "" },
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

// ---------------------------------------------------------------------------
// listOnboardedApps — multi-vault sweep
// ---------------------------------------------------------------------------

describe("listOnboardedApps", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-list-apps-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(vault: string, app: string, repo?: BrainInput["repo"]): void {
    const brainsDir = path.join(dataDir, "vaults", vault, "brains", app);
    fs.mkdirSync(brainsDir, { recursive: true });
    saveBrain(path.join(brainsDir, "brain.json"), {
      schemaVersion: 1,
      projectName: app,
      projectType: "app",
      projectStatus: "active",
      projectPriority: 3,
      ...(repo !== undefined && { repo }),
    });
  }

  it("returns an empty list when the vaults dir is missing", () => {
    expect(listOnboardedApps(dataDir)).toEqual([]);
  });

  it("walks every vault and returns each onboarded app", () => {
    seed("personal", "alpha", { rootPath: "/repo/alpha" });
    seed("personal", "beta", { rootPath: "/repo/beta" });
    seed("consulting", "gamma", { rootPath: "/repo/gamma" });
    const apps = listOnboardedApps(dataDir);
    expect(apps).toHaveLength(3);
    const sorted = [...apps].sort((a, b) => a.app.localeCompare(b.app));
    expect(sorted.map((a) => `${a.vault}/${a.app}`)).toEqual([
      "personal/alpha",
      "personal/beta",
      "consulting/gamma",
    ]);
  });

  it("includes apps without brain.repo (caller decides whether to skip)", () => {
    seed("personal", "with-repo", { rootPath: "/repo/x" });
    seed("personal", "no-repo");
    const apps = listOnboardedApps(dataDir);
    const withRepo = apps.find((a) => a.app === "with-repo");
    const noRepo = apps.find((a) => a.app === "no-repo");
    expect(withRepo?.brain.repo?.rootPath).toBe("/repo/x");
    expect(noRepo?.brain.repo).toBeUndefined();
  });

  it("silently skips brains that fail to parse", () => {
    seed("personal", "ok", { rootPath: "/repo/ok" });
    // Corrupt brain
    const broken = path.join(
      dataDir,
      "vaults",
      "personal",
      "brains",
      "broken",
    );
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "brain.json"), "not valid json");
    const apps = listOnboardedApps(dataDir);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.app).toBe("ok");
  });

  it("handles vaults with empty brains/ directories", () => {
    fs.mkdirSync(path.join(dataDir, "vaults", "personal", "brains"), {
      recursive: true,
    });
    expect(listOnboardedApps(dataDir)).toEqual([]);
  });
});
