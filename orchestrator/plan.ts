import { z } from "zod";

export const planTypeSchema = z.enum([
  "business",
  "improvement",
  "marketing",
  "implementation",
]);
export type PlanType = z.infer<typeof planTypeSchema>;

export const improvementSubtypeSchema = z.enum([
  "new-feature",
  "rework",
  "refactor",
  "security-fix",
  "dep-update",
  "bugfix",
  "meta",
]);
export type ImprovementSubtype = z.infer<typeof improvementSubtypeSchema>;

export const marketingSubtypeSchema = z.enum(["campaign", "single-post"]);
export type MarketingSubtype = z.infer<typeof marketingSubtypeSchema>;

export const planStatusSchema = z.enum([
  "draft",
  "awaiting-review",
  "approved",
  "executing",
  "paused",
  "blocked",
  "cancelled",
  "done",
  "rejected",
  "shipped-pending-impact",
  "success",
  "null-result",
  "regression",
]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const prioritySchema = z.enum(["low", "normal", "high", "blocking"]);
export type Priority = z.infer<typeof prioritySchema>;

export const implementationReviewSchema = z.enum([
  "required",
  "skip",
  "auto",
]);
export type ImplementationReview = z.infer<typeof implementationReviewSchema>;

const confidenceSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string().optional(),
});

export const planMetadataSchema = z
  .object({
    title: z.string().min(1),
    type: planTypeSchema,
    subtype: z.string().optional(),
    parentPlan: z.string().optional(),
    implementationReview: implementationReviewSchema.optional(),
    app: z.string().min(1),
    priority: prioritySchema,
    destructive: z.boolean(),
    status: planStatusSchema,
    author: z.string().min(1),
    confidence: confidenceSchema,
  })
  .superRefine((data, ctx) => {
    if (data.type === "improvement") {
      if (!data.subtype) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: "subtype required for improvement plans",
        });
      } else if (!improvementSubtypeSchema.safeParse(data.subtype).success) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: `invalid improvement subtype: ${data.subtype}`,
        });
      }
    }
    if (data.type === "marketing") {
      if (!data.subtype) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: "subtype required for marketing plans",
        });
      } else if (!marketingSubtypeSchema.safeParse(data.subtype).success) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: `invalid marketing subtype: ${data.subtype}`,
        });
      }
    }
    if (data.type === "implementation" && !data.parentPlan) {
      ctx.addIssue({
        code: "custom",
        path: ["parentPlan"],
        message: "parentPlan required for implementation plans",
      });
    }
  });

export type PlanMetadata = z.infer<typeof planMetadataSchema>;

export interface PlanSection {
  title: string;
  body: string;
}

export interface Plan {
  metadata: PlanMetadata;
  sections: PlanSection[];
}

const HEADER_FIELD_ORDER: ReadonlyArray<keyof PlanMetadata> = [
  "type",
  "subtype",
  "parentPlan",
  "implementationReview",
  "app",
  "priority",
  "destructive",
  "status",
  "author",
  "confidence",
];

const FIELD_DISPLAY: Record<string, string> = {
  type: "Type",
  subtype: "Subtype",
  parentPlan: "ParentPlan",
  implementationReview: "ImplementationReview",
  app: "App",
  priority: "Priority",
  destructive: "Destructive",
  status: "Status",
  author: "Author",
  confidence: "Confidence",
};

const HEADER_LINE_PATTERN = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/;
const TITLE_LINE_PATTERN = /^#\s+Plan:\s+(.+)$/;
const CONFIDENCE_PATTERN = /^(\d{1,3})(?:\s*[—-]\s*(.+))?$/;

export function parsePlan(text: string): Plan {
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i += 1;
  const titleLine = lines[i];
  if (titleLine === undefined) {
    throw new Error("Plan is empty");
  }
  const titleMatch = titleLine.match(TITLE_LINE_PATTERN);
  if (!titleMatch) {
    throw new Error('Plan must start with "# Plan: <title>"');
  }
  const title = titleMatch[1]!.trim();
  i += 1;

  const headerRaw: Record<string, string> = {};
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      break;
    }
    if (line.startsWith("## ")) break;
    const m = line.match(HEADER_LINE_PATTERN);
    if (!m) {
      throw new Error(`Unparseable header line ${i + 1}: ${line}`);
    }
    headerRaw[m[1]!] = m[2]!.trim();
    i += 1;
  }

  const confidenceRaw = headerRaw["Confidence"];
  if (confidenceRaw === undefined) {
    throw new Error("Confidence is required");
  }
  const confMatch = confidenceRaw.match(CONFIDENCE_PATTERN);
  if (!confMatch) {
    throw new Error(
      'Confidence must be "<0-100>" or "<0-100> — <rationale>"',
    );
  }
  const confidence = {
    score: parseInt(confMatch[1]!, 10),
    rationale: confMatch[2]?.trim(),
  };

  const destructiveRaw = headerRaw["Destructive"];
  let destructive: boolean;
  if (destructiveRaw === "true") destructive = true;
  else if (destructiveRaw === "false") destructive = false;
  else throw new Error('Destructive must be "true" or "false"');

  const sections: PlanSection[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("## ")) {
      i += 1;
      continue;
    }
    const sectionTitle = line.slice(3).trim();
    i += 1;
    const bodyLines: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("## ")) {
      bodyLines.push(lines[i]!);
      i += 1;
    }
    sections.push({
      title: sectionTitle,
      body: bodyLines.join("\n").trim(),
    });
  }

  const metaInput: Record<string, unknown> = {
    title,
    type: headerRaw["Type"],
    app: headerRaw["App"],
    priority: headerRaw["Priority"],
    destructive,
    status: headerRaw["Status"],
    author: headerRaw["Author"],
    confidence,
  };
  if (headerRaw["Subtype"]) metaInput["subtype"] = headerRaw["Subtype"];
  if (headerRaw["ParentPlan"])
    metaInput["parentPlan"] = headerRaw["ParentPlan"];
  if (headerRaw["ImplementationReview"])
    metaInput["implementationReview"] = headerRaw["ImplementationReview"];

  const metadata = planMetadataSchema.parse(metaInput);

  return { metadata, sections };
}

export function serializePlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# Plan: ${plan.metadata.title}`);

  for (const field of HEADER_FIELD_ORDER) {
    const value = plan.metadata[field];
    if (value === undefined) continue;
    const display = FIELD_DISPLAY[field]!;
    if (field === "confidence") {
      const c = plan.metadata.confidence;
      const rendered = c.rationale
        ? `${c.score} — ${c.rationale}`
        : `${c.score}`;
      lines.push(`${display}: ${rendered}`);
    } else if (field === "destructive") {
      lines.push(`${display}: ${plan.metadata.destructive}`);
    } else {
      lines.push(`${display}: ${value as string}`);
    }
  }
  lines.push("");

  for (const section of plan.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    if (section.body) {
      lines.push(section.body);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

const TRANSITIONS: Record<PlanStatus, ReadonlyArray<PlanStatus>> = {
  draft: ["awaiting-review"],
  "awaiting-review": ["approved", "draft", "rejected"],
  approved: ["executing", "paused", "blocked", "cancelled"],
  executing: ["done", "awaiting-review", "paused", "blocked", "cancelled"],
  paused: ["executing", "cancelled"],
  blocked: ["executing", "cancelled"],
  done: ["shipped-pending-impact"],
  cancelled: [],
  rejected: [],
  "shipped-pending-impact": ["success", "null-result", "regression"],
  success: [],
  "null-result": [],
  regression: [],
};

export function allowedTransitions(from: PlanStatus): PlanStatus[] {
  return [...TRANSITIONS[from]];
}

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  public readonly from: PlanStatus;
  public readonly to: PlanStatus;

  constructor(from: PlanStatus, to: PlanStatus) {
    super(`Cannot transition plan status from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function transitionPlan(plan: Plan, to: PlanStatus): Plan {
  if (!canTransition(plan.metadata.status, to)) {
    throw new InvalidTransitionError(plan.metadata.status, to);
  }
  return {
    ...plan,
    metadata: { ...plan.metadata, status: to },
  };
}
