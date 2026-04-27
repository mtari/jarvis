import fs from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.ts";

const identitySchema = z.object({
  name: z.string().default(""),
  timezone: z.string().default(""),
  locale: z.string().default(""),
  role: z.string().default(""),
  technicalBackground: z.string().default(""),
});

const personalitySchema = z.object({
  workStyle: z.string().default(""),
  communicationStyle: z.string().default(""),
  decisionStyle: z.string().default(""),
  riskTolerance: z.string().default(""),
});

const goalsSchema = z.object({
  primary: z.string().default(""),
  horizon: z.string().default(""),
  constraints: z.array(z.string()).default([]),
});

const preferencesSchema = z.object({
  responseStyle: z.string().default(""),
  planVerbosity: z.string().default(""),
  reviewRhythm: z.string().default(""),
  languageRules: z.array(z.string()).default([]),
  globalExclusions: z.array(z.string()).default([]),
});

const strategiesSchema = z.object({
  portfolio: z.string().default(""),
  marketing: z.string().default(""),
  development: z.string().default(""),
});

const pastDecisionSchema = z.object({
  date: z.string(),
  decision: z.string(),
  rationale: z.string(),
});

const historySchema = z.object({
  stackFamiliarity: z.array(z.string()).default([]),
  appsShipped: z.array(z.string()).default([]),
  pastDecisions: z.array(pastDecisionSchema).default([]),
});

const observedPatternsSchema = z.object({
  rejectionReasons: z.array(z.string()).default([]),
  approvedPatterns: z.array(z.string()).default([]),
  brandVoiceNotes: z.array(z.string()).default([]),
});

export const profileSchema = z.object({
  schemaVersion: z.literal(1),
  identity: identitySchema.prefault({}),
  personality: personalitySchema.prefault({}),
  goals: goalsSchema.prefault({}),
  preferences: preferencesSchema.prefault({}),
  strategies: strategiesSchema.prefault({}),
  history: historySchema.prefault({}),
  observedPatterns: observedPatternsSchema.prefault({}),
});

export type Profile = z.infer<typeof profileSchema>;
export type ProfileInput = z.input<typeof profileSchema>;

export function loadProfile(filePath: string): Profile {
  const text = fs.readFileSync(filePath, "utf8");
  const data: unknown = JSON.parse(text);
  return profileSchema.parse(data);
}

export function saveProfile(
  filePath: string,
  profile: ProfileInput,
): Profile {
  const validated = profileSchema.parse(profile);
  atomicWriteFileSync(filePath, JSON.stringify(validated, null, 2) + "\n");
  return validated;
}

export function emptyProfileTemplate(): Profile {
  return profileSchema.parse({ schemaVersion: 1 });
}
