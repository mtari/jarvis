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

/**
 * Plans that count as "open" for duplicate-detection purposes: anything
 * pending user review or in active execution, plus shipped-pending-impact
 * (still on the user's plate via the observation window). Excludes terminal
 * states (done/cancelled/rejected/success/null-result/regression) and
 * `draft` (in-flight, not yet visible to the user).
 */
const OPEN_PLAN_STATUSES: ReadonlySet<string> = new Set([
  "awaiting-review",
  "approved",
  "executing",
  "paused",
  "blocked",
  "shipped-pending-impact",
]);

/**
 * Returns a markdown context block listing every currently-open plan for
 * the given app (any plan type, any subtype including `meta`), or `null`
 * when none exist. Injected into every drafting brief — user-initiated
 * (strategist.ts), per-app daily audit (strategist-project-audit.ts), and
 * jarvis self-audit (strategist-daily-audit.ts) — so Strategist sees what
 * is already in the backlog before drafting and can return <clarify>
 * instead of producing a duplicate plan.
 *
 * Mirrors the `notesContextBlock` pattern (orchestrator/notes.ts).
 */
export function openPlansContextBlock(
  dataDir: string,
  app: string,
): string | null {
  const open = listPlans(dataDir).filter(
    (r) => r.app === app && OPEN_PLAN_STATUSES.has(r.plan.metadata.status),
  );
  if (open.length === 0) return null;

  open.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const lines: string[] = [];
  lines.push(
    "Currently open plans for this app (review before drafting to avoid duplicates):",
  );
  for (const r of open) {
    const m = r.plan.metadata;
    const subtype = m.subtype ? `/${m.subtype}` : "";
    lines.push(
      `- ${r.id} — "${m.title}" (${m.type}${subtype}, status=${m.status}, priority=${m.priority})`,
    );
  }
  lines.push("");
  lines.push(
    "If your draft would substantially overlap any plan above (same problem, same primary capability), DO NOT draft a second plan. Return <clarify> asking whether to revise the existing plan instead.",
  );
  return lines.join("\n");
}
