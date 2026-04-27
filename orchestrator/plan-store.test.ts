import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPlan,
  listPlans,
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
});
