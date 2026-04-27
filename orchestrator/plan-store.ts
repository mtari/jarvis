import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { parsePlan, serializePlan } from "./plan.ts";
import type { Plan } from "./plan.ts";

export interface PlanRecord {
  plan: Plan;
  path: string;
  vault: string;
  app: string;
  id: string;
}

export interface UnreadablePlan {
  path: string;
  vault: string;
  app: string;
  id: string;
  error: string;
}

export interface PlanScan {
  records: PlanRecord[];
  unreadable: UnreadablePlan[];
}

function vaultsDir(dataDir: string): string {
  return path.join(dataDir, "vaults");
}

export function scanPlans(dataDir: string): PlanScan {
  const records: PlanRecord[] = [];
  const unreadable: UnreadablePlan[] = [];
  const vaultsRoot = vaultsDir(dataDir);
  if (!fs.existsSync(vaultsRoot)) return { records, unreadable };

  for (const vault of fs.readdirSync(vaultsRoot)) {
    const plansRoot = path.join(vaultsRoot, vault, "plans");
    if (!fs.existsSync(plansRoot)) continue;

    for (const app of fs.readdirSync(plansRoot)) {
      const appDir = path.join(plansRoot, app);
      if (!fs.statSync(appDir).isDirectory()) continue;

      for (const file of fs.readdirSync(appDir)) {
        if (!file.endsWith(".md")) continue;
        const planPath = path.join(appDir, file);
        const id = file.replace(/\.md$/, "");
        try {
          const text = fs.readFileSync(planPath, "utf8");
          const plan = parsePlan(text);
          records.push({ plan, path: planPath, vault, app, id });
        } catch (err) {
          unreadable.push({
            path: planPath,
            vault,
            app,
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return { records, unreadable };
}

export function listPlans(dataDir: string): PlanRecord[] {
  return scanPlans(dataDir).records;
}

export function findPlan(
  dataDir: string,
  planId: string,
): PlanRecord | null {
  return listPlans(dataDir).find((r) => r.id === planId) ?? null;
}

export function savePlan(planPath: string, plan: Plan): void {
  atomicWriteFileSync(planPath, serializePlan(plan));
}
