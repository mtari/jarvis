import fs from "node:fs";
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

export const brainSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  projectType: projectTypeSchema,
  projectStatus: projectStatusSchema,
  projectPriority: z.number().int().min(1).max(5),

  stack: looseObjectSchema.optional(),
  brand: looseObjectSchema.optional(),
  conventions: looseObjectSchema.optional(),
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

export function saveBrain(filePath: string, brain: BrainInput): Brain {
  const validated = brainSchema.parse(brain);
  const json = JSON.stringify(validated, null, 2) + "\n";
  atomicWriteFileSync(filePath, json);
  return validated;
}

export function brainExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
