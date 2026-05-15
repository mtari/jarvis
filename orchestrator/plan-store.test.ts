import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPlan,
  listPlans,
  openPlansContextBlock,
  savePlan,
  scanPlans,
} from "./plan-store.ts";
import { parsePlan } from "./plan.ts";

const VALID_PLAN_TEXT = `# Plan: Sample
Type: improvement
Subtype: new-feature
ImplementationReview: required
App: jarvis
Priority: normal
Destructive: false
Status: draft
Author: strategist
Confidence: 50

## Problem
Just a sample.

## Build plan
Stuff.

## Testing strategy
Tests.

## Acceptance criteria
- ok
`;

describe("plan store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-plan-store-"));
    fs.mkdirSync(
      path.join(dataDir, "vaults", "personal", "plans", "jarvis"),
      { recursive: true },
    );
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function dropPlan(id: string, text: string = VALID_PLAN_TEXT): void {
    fs.writeFileSync(
      path.join(dataDir, "vaults", "personal", "plans", "jarvis", `${id}.md`),
      text,
    );
  }

  it("lists plans across vaults and apps", () => {
    dropPlan("2026-04-27-one");
    dropPlan("2026-04-27-two");
    const plans = listPlans(dataDir);
    expect(plans.map((p) => p.id).sort()).toEqual([
      "2026-04-27-one",
      "2026-04-27-two",
    ]);
    expect(plans[0]?.vault).toBe("personal");
    expect(plans[0]?.app).toBe("jarvis");
  });

  it("returns empty when no vaults exist", () => {
    fs.rmSync(path.join(dataDir, "vaults"), { recursive: true });
    expect(listPlans(dataDir)).toEqual([]);
  });

  it("scanPlans separates unreadable plans without crashing", () => {
    dropPlan("2026-04-27-good");
    fs.writeFileSync(
      path.join(dataDir, "vaults", "personal", "plans", "jarvis", "broken.md"),
      "this is not a plan",
    );
    const scan = scanPlans(dataDir);
    expect(scan.records).toHaveLength(1);
    expect(scan.unreadable).toHaveLength(1);
    expect(scan.unreadable[0]?.id).toBe("broken");
  });

  it("findPlan returns the matching record or null", () => {
    dropPlan("2026-04-27-one");
    expect(findPlan(dataDir, "2026-04-27-one")?.id).toBe("2026-04-27-one");
    expect(findPlan(dataDir, "missing")).toBeNull();
  });

  it("savePlan round-trips through atomic write", () => {
    dropPlan("2026-04-27-one");
    const record = findPlan(dataDir, "2026-04-27-one")!;
    const updated = {
      ...record.plan,
      metadata: { ...record.plan.metadata, status: "approved" as const },
    };
    savePlan(record.path, updated);
    const reread = parsePlan(fs.readFileSync(record.path, "utf8"));
    expect(reread.metadata.status).toBe("approved");
  });

  it("ignores non-.md files", () => {
    dropPlan("2026-04-27-one");
    fs.writeFileSync(
      path.join(dataDir, "vaults", "personal", "plans", "jarvis", "notes.txt"),
      "ignore me",
    );
    expect(listPlans(dataDir)).toHaveLength(1);
  });

  function planWith(opts: {
    id: string;
    app: string;
    title: string;
    status: string;
    type?: string;
    subtype?: string;
    priority?: string;
  }): string {
    return `# Plan: ${opts.title}
Type: ${opts.type ?? "improvement"}
Subtype: ${opts.subtype ?? "new-feature"}
ImplementationReview: required
App: ${opts.app}
Priority: ${opts.priority ?? "normal"}
Destructive: false
Status: ${opts.status}
Author: strategist
Confidence: 60

## Problem
x

## Build plan
y

## Testing strategy
z

## Acceptance criteria
- ok
`;
  }

  function dropAppPlan(app: string, id: string, text: string): void {
    const dir = path.join(dataDir, "vaults", "personal", "plans", app);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.md`), text);
  }

  it("openPlansContextBlock returns null when no plans for the app", () => {
    dropAppPlan(
      "erdei-fahazak",
      "2026-05-11-one",
      planWith({
        id: "2026-05-11-one",
        app: "erdei-fahazak",
        title: "Owner self-service",
        status: "awaiting-review",
      }),
    );
    expect(openPlansContextBlock(dataDir, "huntech-dev")).toBeNull();
  });

  it("openPlansContextBlock lists open plans with title + type/subtype + status + priority", () => {
    dropAppPlan(
      "erdei-fahazak",
      "2026-05-11-one",
      planWith({
        id: "2026-05-11-one",
        app: "erdei-fahazak",
        title: "Owner self-service listing submission",
        status: "awaiting-review",
        priority: "high",
      }),
    );
    dropAppPlan(
      "erdei-fahazak",
      "2026-05-12-two",
      planWith({
        id: "2026-05-12-two",
        app: "erdei-fahazak",
        title: "Owner onboarding flow",
        status: "approved",
        priority: "high",
      }),
    );

    const block = openPlansContextBlock(dataDir, "erdei-fahazak");
    expect(block).not.toBeNull();
    expect(block).toContain("Currently open plans for this app");
    expect(block).toContain('2026-05-11-one — "Owner self-service listing submission"');
    expect(block).toContain("(improvement/new-feature, status=awaiting-review, priority=high)");
    expect(block).toContain('2026-05-12-two — "Owner onboarding flow"');
    expect(block).toContain("status=approved");
    expect(block).toContain("DO NOT draft a second plan");
    // Sorted by id ascending so the earlier plan appears first
    const firstIdx = block!.indexOf("2026-05-11-one");
    const secondIdx = block!.indexOf("2026-05-12-two");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("openPlansContextBlock excludes terminal-state plans", () => {
    for (const status of [
      "draft",
      "done",
      "cancelled",
      "rejected",
      "success",
      "null-result",
      "regression",
    ]) {
      dropAppPlan(
        "erdei-fahazak",
        `2026-05-11-${status}`,
        planWith({
          id: `2026-05-11-${status}`,
          app: "erdei-fahazak",
          title: `Plan in ${status}`,
          status,
        }),
      );
    }
    expect(openPlansContextBlock(dataDir, "erdei-fahazak")).toBeNull();
  });

  it("openPlansContextBlock filters by app", () => {
    dropAppPlan(
      "erdei-fahazak",
      "2026-05-11-erdei",
      planWith({
        id: "2026-05-11-erdei",
        app: "erdei-fahazak",
        title: "Erdei plan",
        status: "awaiting-review",
      }),
    );
    dropAppPlan(
      "huntech-dev",
      "2026-05-11-huntech",
      planWith({
        id: "2026-05-11-huntech",
        app: "huntech-dev",
        title: "Huntech plan",
        status: "awaiting-review",
      }),
    );
    const block = openPlansContextBlock(dataDir, "erdei-fahazak");
    expect(block).toContain("Erdei plan");
    expect(block).not.toContain("Huntech plan");
  });
});
