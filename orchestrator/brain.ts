import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.ts";

const projectTypeSchema = z.enum([
  "app",
  "consulting",
  "personal-brand",
  "other",
]);

const projectStatusSchema = z.enum(["active", "maintenance", "paused"]);

const userPreferencesSchema = z.object({
  voiceOverrides: z.array(z.string()).optional(),
  areasOfInterest: z.array(z.string()).optional(),
  areasToAvoid: z.array(z.string()).optional(),
  energyHints: z.array(z.string()).optional(),
});

const prioritySchema = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number(),
  source: z.string(),
});

const wipSchema = z.object({
  activePlanId: z.string().optional(),
  activeBranch: z.string().optional(),
});

const looseObjectSchema = z.record(z.string(), z.unknown());

const scopeSchema = z.object({
  userTypes: z.array(z.string()).optional(),
  primaryFlows: z.array(z.string()).optional(),
  domainRules: z.array(z.string()).optional(),
});

/**
 * Where the app's source code lives on disk. The plan-executor uses this
 * to set the SDK `cwd` for Developer fires — without it, the daemon can
 * only auto-fire on the jarvis repo. `monorepoPath` is the repo-relative
 * subdirectory when the app is one package inside a monorepo.
 */
const repoSchema = z.object({
  rootPath: z.string().min(1),
  monorepoPath: z.string().optional(),
});

export const brainSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  projectType: projectTypeSchema,
  projectStatus: projectStatusSchema,
  projectPriority: z.number().int().min(1).max(5),

  stack: looseObjectSchema.optional(),
  brand: looseObjectSchema.optional(),
  conventions: looseObjectSchema.optional(),
  scope: scopeSchema.optional(),
  features: z.array(z.string()).optional(),
  /**
   * On-disk location of the app's source code. Optional for back-compat
   * with brains created before multi-repo support; the brain-migration
   * runner backfills it from `app-onboarded` events. Apps without `repo`
   * are excluded from the plan-executor's auto-fire enabled-apps set.
   */
  repo: repoSchema.optional(),
  userPreferences: userPreferencesSchema.default({}),
  connections: z.record(z.string(), looseObjectSchema).default({}),
  priorities: z.array(prioritySchema).default([]),
  alertThresholds: looseObjectSchema.optional(),
  wip: wipSchema.default({}),
  metrics: z
    .object({
      latest: looseObjectSchema.optional(),
    })
    .optional(),
  businessPlanId: z.string().optional(),
});

export type Brain = z.infer<typeof brainSchema>;
export type BrainInput = z.input<typeof brainSchema>;

export function loadBrain(filePath: string): Brain {
  const text = fs.readFileSync(filePath, "utf8");
  const data: unknown = JSON.parse(text);
  return brainSchema.parse(data);
}

export interface OnboardedApp {
  vault: string;
  app: string;
  brain: Brain;
}

/**
 * Walks `<dataDir>/vaults/<vault>/brains/<app>/brain.json` for every vault
 * and every app, returning the parsed brain when it loads cleanly. Brains
 * that fail to parse (corrupt JSON, schema drift) are skipped silently —
 * sweep operations like the analyst tick should not crash on one broken
 * brain. The skipped count surfaces as a separate signal in the future.
 *
 * Used by the daemon's analyst-tick service and any other multi-app
 * sweeper that needs to enumerate everything Jarvis is aware of.
 */
export function listOnboardedApps(dataDir: string): OnboardedApp[] {
  const vaultsRoot = path.join(dataDir, "vaults");
  if (!fs.existsSync(vaultsRoot)) return [];

  const out: OnboardedApp[] = [];
  for (const vault of safeReaddir(vaultsRoot)) {
    const brainsRoot = path.join(vaultsRoot, vault, "brains");
    if (!fs.existsSync(brainsRoot)) continue;
    for (const app of safeReaddir(brainsRoot)) {
      const file = path.join(brainsRoot, app, "brain.json");
      if (!fs.existsSync(file)) continue;
      try {
        const brain = loadBrain(file);
        out.push({ vault, app, brain });
      } catch {
        // Skip brains that fail schema validation.
      }
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function saveBrain(filePath: string, brain: BrainInput): Brain {
  const validated = brainSchema.parse(brain);
  const json = JSON.stringify(validated, null, 2) + "\n";
  atomicWriteFileSync(filePath, json);
  return validated;
}

export function brainExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
