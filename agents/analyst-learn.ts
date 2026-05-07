import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../orchestrator/event-log.ts";
import { listFeedback, type FeedbackRow } from "../orchestrator/feedback-store.ts";
import { parsePlan, transitionPlan } from "../orchestrator/plan.ts";
import { listPlans, savePlan } from "../orchestrator/plan-store.ts";
import {
  dumpFailedDraft,
  generatePlanId,
  parseStrategistResponse,
} from "./strategist.ts";
import { dbFile, planDir, repoRoot } from "../cli/paths.ts";

/**
 * Analyst's learning loop — Phase 4 v1.
 *
 * Walks the feedback store + recent plan transitions to find recurring
 * themes that suggest a meta plan would improve future outputs:
 *
 *   - rejection notes that cluster around the same words ("scope too
 *     broad", "not enough detail", "unsafe rollback") → Strategist
 *     prompt could absorb a guard against the pattern.
 *   - revise notes clustered the same way → same.
 *   - approval rate by plan subtype: very low approval is a quality
 *     signal worth surfacing.
 *   - edit-before-publish patterns on posts: every post needing the
 *     same fix points at a humanizer or brand-voice rule.
 *
 * Pure-function entry point: `runLearnScan(input) → LearnReport`. The
 * caller (CLI) renders the report. Auto-drafting meta plans for
 * high-confidence findings lands in a follow-up — keep this slice
 * scan-only so the loop's signal can be examined before we let it
 * write plans on its own.
 */

export interface RunLearnScanInput {
  dataDir: string;
  /** Only feedback rows on or after this ISO datetime. Default: 30d ago. */
  since?: string;
  /** Cap on rows scanned. Default 1000. */
  limit?: number;
  /** Test seam — fixed clock for the recorded event timestamp. */
  now?: Date;
}

export interface ThemeCluster {
  /** Token (lowercased word or short phrase) shared across the rows. */
  token: string;
  /** Number of feedback rows that mention the token. */
  count: number;
  /** Plan ids the theme appeared on (capped at 5 for display). */
  examplePlanIds: string[];
}

export interface LearnReport {
  scannedFeedbackRows: number;
  scannedPlans: number;
  rejectionThemes: ThemeCluster[];
  reviseThemes: ThemeCluster[];
  /** Approval rate per (type, subtype) where total >= 3. Sorted ascending. */
  lowApprovalRates: Array<{
    type: string;
    subtype: string | null;
    total: number;
    approved: number;
    rate: number;
  }>;
  /**
   * Recommendations the operator can act on. Each is one human-
   * readable line; future PRs may swap these for structured proposals
   * the meta-plan drafter consumes.
   */
  recommendations: string[];
  since: string;
}

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 1000;
const MIN_CLUSTER_COUNT = 3;
const MIN_APPROVAL_SAMPLE = 3;
const LOW_APPROVAL_THRESHOLD = 0.5;

/**
 * Stop-words excluded from theme extraction. Conservative list — we
 * want to catch domain phrases, not over-prune. Inflected forms are
 * normalised separately (see `normaliseToken`).
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "it",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "as",
  "by",
  "at",
  "be",
  "been",
  "being",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "it's",
  "not",
  "no",
  "yes",
  "if",
  "then",
  "else",
  "too",
  "very",
  "just",
  "more",
  "less",
  "much",
  "many",
  "some",
  "any",
  "all",
  "than",
  "from",
  "into",
  "out",
  "over",
  "under",
  "about",
  "would",
  "could",
  "should",
  "will",
  "can",
  "may",
  "might",
  "must",
  "shall",
  "plan",
  "needs",
  "need",
  "should",
  "make",
]);

export function runLearnScan(input: RunLearnScanInput): LearnReport {
  const now = input.now ?? new Date();
  const sinceMs = now.getTime() - DEFAULT_LOOKBACK_MS;
  const since = input.since ?? new Date(sinceMs).toISOString();
  const limit = input.limit ?? DEFAULT_LIMIT;

  const db = new Database(dbFile(input.dataDir), { readonly: true });
  let allFeedback: FeedbackRow[];
  try {
    allFeedback = listFeedback(db, { limit });
  } finally {
    db.close();
  }

  const recent = allFeedback.filter((r) => r.created_at >= since);
  const rejectionRows = recent.filter(
    (r) => r.kind === "reject" && r.target_type === "plan",
  );
  const reviseRows = recent.filter(
    (r) => r.kind === "revise" && r.target_type === "plan",
  );

  const rejectionThemes = clusterThemes(rejectionRows);
  const reviseThemes = clusterThemes(reviseRows);
  const planRecords = listPlans(input.dataDir);
  const lowApprovalRates = computeLowApprovalRates(recent, planRecords);

  const recommendations = buildRecommendations({
    rejectionThemes,
    reviseThemes,
    lowApprovalRates,
  });

  // Record the scan completion event so the daemon-tick wiring (later)
  // can read it and avoid duplicate scans within the same window.
  const writeDb = new Database(dbFile(input.dataDir));
  try {
    appendEvent(writeDb, {
      appId: "jarvis",
      vaultId: "personal",
      kind: "learn-scan-completed",
      payload: {
        scannedFeedbackRows: recent.length,
        scannedPlans: planRecords.length,
        rejectionThemes: rejectionThemes.length,
        reviseThemes: reviseThemes.length,
        lowApprovalRates: lowApprovalRates.length,
        recommendations: recommendations.length,
        since,
      },
      ...(input.now !== undefined && { createdAt: input.now.toISOString() }),
    });
  } finally {
    writeDb.close();
  }

  return {
    scannedFeedbackRows: recent.length,
    scannedPlans: planRecords.length,
    rejectionThemes,
    reviseThemes,
    lowApprovalRates,
    recommendations,
    since,
  };
}

// ---------------------------------------------------------------------------
// Theme clustering — frequency over normalised tokens
// ---------------------------------------------------------------------------

function clusterThemes(rows: FeedbackRow[]): ThemeCluster[] {
  if (rows.length === 0) return [];
  // token → set of plan ids that mentioned it. Sets dedupe per-plan
  // so a plan with the word twice in one note doesn't double-count.
  const byToken = new Map<string, Set<string>>();
  for (const row of rows) {
    const note = row.note?.trim();
    if (!note) continue;
    const tokens = new Set<string>();
    for (const raw of tokenise(note)) {
      const norm = normaliseToken(raw);
      if (!norm) continue;
      tokens.add(norm);
    }
    for (const t of tokens) {
      let bucket = byToken.get(t);
      if (!bucket) {
        bucket = new Set();
        byToken.set(t, bucket);
      }
      bucket.add(row.target_id);
    }
  }

  const clusters: ThemeCluster[] = [];
  for (const [token, planIds] of byToken) {
    if (planIds.size < MIN_CLUSTER_COUNT) continue;
    clusters.push({
      token,
      count: planIds.size,
      examplePlanIds: [...planIds].slice(0, 5),
    });
  }
  // Sort: most common first; tie-break alphabetically for stability.
  clusters.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
  return clusters;
}

function tokenise(s: string): string[] {
  // Split on non-letter chars; lowercase. Treat hyphenated words as one token.
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 0);
}

function normaliseToken(t: string): string | null {
  if (t.length < 4) return null; // skip "and", "the", short noise
  if (STOP_WORDS.has(t)) return null;
  // Light stemming: drop common inflections so "rejecting" / "rejected"
  // / "rejects" cluster as "reject".
  let normalised = t;
  if (normalised.endsWith("ing") && normalised.length > 5) {
    normalised = normalised.slice(0, -3);
  } else if (normalised.endsWith("ed") && normalised.length > 4) {
    normalised = normalised.slice(0, -2);
  } else if (normalised.endsWith("s") && normalised.length > 4) {
    normalised = normalised.slice(0, -1);
  }
  if (normalised.length < 4) return null;
  return normalised;
}

// ---------------------------------------------------------------------------
// Approval-rate signal
// ---------------------------------------------------------------------------

function computeLowApprovalRates(
  recent: FeedbackRow[],
  planRecords: ReturnType<typeof listPlans>,
): LearnReport["lowApprovalRates"] {
  // Build (planId → {type, subtype}) from disk; planRecords is the
  // authoritative source.
  const planMeta = new Map<string, { type: string; subtype: string | null }>();
  for (const r of planRecords) {
    planMeta.set(r.id, {
      type: r.plan.metadata.type,
      subtype: r.plan.metadata.subtype ?? null,
    });
  }

  // Bucket by (type, subtype). Approve = approve feedback. Total =
  // approve + reject + revise (signal of "decision was rendered").
  type Bucket = { type: string; subtype: string | null; approved: number; total: number };
  const buckets = new Map<string, Bucket>();
  const key = (t: string, s: string | null): string => `${t}::${s ?? "(none)"}`;
  for (const row of recent) {
    if (row.target_type !== "plan") continue;
    if (
      row.kind !== "approve" &&
      row.kind !== "reject" &&
      row.kind !== "revise"
    ) {
      continue;
    }
    const meta = planMeta.get(row.target_id);
    if (!meta) continue; // skip rows for plans we don't have on disk
    const k = key(meta.type, meta.subtype);
    let b = buckets.get(k);
    if (!b) {
      b = { type: meta.type, subtype: meta.subtype, approved: 0, total: 0 };
      buckets.set(k, b);
    }
    b.total += 1;
    if (row.kind === "approve") b.approved += 1;
  }

  const out: LearnReport["lowApprovalRates"] = [];
  for (const b of buckets.values()) {
    if (b.total < MIN_APPROVAL_SAMPLE) continue;
    const rate = b.approved / b.total;
    if (rate < LOW_APPROVAL_THRESHOLD) {
      out.push({
        type: b.type,
        subtype: b.subtype,
        total: b.total,
        approved: b.approved,
        rate: Math.round(rate * 100) / 100,
      });
    }
  }
  // Worst rates first.
  out.sort((a, b) => a.rate - b.rate);
  return out;
}

// ---------------------------------------------------------------------------
// Recommendations — terse, human-readable
// ---------------------------------------------------------------------------

function buildRecommendations(args: {
  rejectionThemes: ThemeCluster[];
  reviseThemes: ThemeCluster[];
  lowApprovalRates: LearnReport["lowApprovalRates"];
}): string[] {
  const out: string[] = [];
  for (const t of args.rejectionThemes.slice(0, 3)) {
    out.push(
      `Rejection theme: "${t.token}" appeared on ${t.count} rejected plans. Consider a Strategist prompt note that addresses this pattern explicitly.`,
    );
  }
  for (const t of args.reviseThemes.slice(0, 3)) {
    out.push(
      `Revise theme: "${t.token}" appeared in ${t.count} revise notes. Likely a recurring gap in Strategist's draft — consider a checklist item or a brain field.`,
    );
  }
  for (const lar of args.lowApprovalRates.slice(0, 3)) {
    const subtypeStr = lar.subtype ? `/${lar.subtype}` : "";
    out.push(
      `Low approval rate: ${lar.type}${subtypeStr} approved ${lar.approved}/${lar.total} (${Math.round(lar.rate * 100)}%). Investigate plan-quality before drafting more in this category.`,
    );
  }
  return out;
}

// ===========================================================================
// Auto-draft meta plans from scan findings
// ===========================================================================

/**
 * Single-finding shape passed to Strategist for drafting. Subset of
 * the LearnReport — flattened so the agent prompt is straightforward
 * to construct.
 */
export type LearnFinding =
  | {
      kind: "rejection-theme";
      token: string;
      count: number;
      examplePlanIds: string[];
    }
  | {
      kind: "revise-theme";
      token: string;
      count: number;
      examplePlanIds: string[];
    }
  | {
      kind: "low-approval";
      type: string;
      subtype: string | null;
      total: number;
      approved: number;
      rate: number;
    };

export interface DraftMetaPlansFromScanInput {
  dataDir: string;
  client: AnthropicClient;
  /** Reuse a recent scan instead of running one. Test seam. */
  report?: LearnReport;
  /** Minimum count to draft a meta plan for a theme. Default 5. */
  threshold?: number;
  /** Hard cap on drafts per call. Default 5. */
  maxDrafts?: number;
  /** Test seam — fixed clock for the recorded events. */
  now?: Date;
}

export interface DraftedFinding {
  finding: LearnFinding;
  planId: string;
  planPath: string;
}

export interface SkippedFinding {
  finding: LearnFinding;
  reason: string;
}

export interface DraftMetaPlansFromScanResult {
  drafted: DraftedFinding[];
  skipped: SkippedFinding[];
  errors: SkippedFinding[];
}

/**
 * Default threshold for auto-draft. Findings below this stay in the
 * scan report only; humans decide when to act.
 */
export const DEFAULT_DRAFT_THRESHOLD = 5;

/**
 * Walks the scan's findings, drafts a meta plan per finding above
 * the threshold (single Strategist call each). Idempotent across
 * invocations: findings already drafted in the last 14 days are
 * skipped via `learn-meta-drafted` events.
 */
export async function draftMetaPlansFromScan(
  input: DraftMetaPlansFromScanInput,
): Promise<DraftMetaPlansFromScanResult> {
  const threshold = input.threshold ?? DEFAULT_DRAFT_THRESHOLD;
  const maxDrafts = input.maxDrafts ?? 5;

  const report = input.report ?? runLearnScan({ dataDir: input.dataDir });
  const findings = pickFindingsToDraft(report, threshold).slice(0, maxDrafts);
  const result: DraftMetaPlansFromScanResult = {
    drafted: [],
    skipped: [],
    errors: [],
  };

  if (findings.length === 0) return result;

  const recentlyDrafted = readRecentlyDraftedFindings(input.dataDir);
  const systemPrompt = loadLearnMetaPrompt();

  for (const finding of findings) {
    const key = findingDedupeKey(finding);
    if (recentlyDrafted.has(key)) {
      result.skipped.push({
        finding,
        reason: `already drafted within the last 14 days (${key})`,
      });
      continue;
    }

    const userMessage = buildLearnMetaContext(finding);
    let responseText: string;
    try {
      const response = await input.client.chat({
        system: systemPrompt,
        cacheSystem: true,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText = response.text;
    } catch (err) {
      result.errors.push({
        finding,
        reason: `Strategist call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let action;
    try {
      action = parseStrategistResponse({
        text: responseText,
        blocks: [{ type: "text", text: responseText }],
        stopReason: null,
        model: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      });
    } catch (err) {
      result.errors.push({
        finding,
        reason: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (action.kind !== "draft") {
      // Strategist returned <clarify> — finding too thin to act on.
      result.skipped.push({
        finding,
        reason: `Strategist asked for clarification: ${action.questions.join(" ")}`,
      });
      continue;
    }

    let plan;
    try {
      plan = parsePlan(action.markdown);
    } catch (err) {
      const dumpPath = dumpFailedDraft(input.dataDir, action.markdown);
      result.errors.push({
        finding,
        reason: `schema validation failed: ${err instanceof Error ? err.message : String(err)}${dumpPath ? ` (raw at ${dumpPath})` : ""}`,
      });
      continue;
    }
    if (
      plan.metadata.type !== "improvement" ||
      plan.metadata.subtype !== "meta"
    ) {
      result.errors.push({
        finding,
        reason: `expected improvement/meta, got ${plan.metadata.type}/${plan.metadata.subtype ?? "(none)"}`,
      });
      continue;
    }

    const transitioned = transitionPlan(plan, "awaiting-review");
    const app = plan.metadata.app;
    // Find an appropriate vault — use 'personal' as default for the
    // jarvis app; per-app meta plans use the same vault as the app
    // they target if findable, else 'personal'.
    const vault = inferVault(input.dataDir, app);
    const planId = generatePlanId(
      transitioned.metadata.title,
      app,
      input.dataDir,
      vault,
    );
    const folder = planDir(input.dataDir, vault, app);
    fs.mkdirSync(folder, { recursive: true });
    const planPath = path.join(folder, `${planId}.md`);
    savePlan(planPath, transitioned);

    const writeDb = new Database(dbFile(input.dataDir));
    try {
      writeDb.transaction(() => {
        appendEvent(writeDb, {
          appId: app,
          vaultId: vault,
          kind: "plan-drafted",
          payload: {
            planId,
            brief: `learn auto-draft: ${describeFindingShort(finding)}`,
            rounds: 0,
            author: "strategist",
          },
        });
        appendEvent(writeDb, {
          appId: app,
          vaultId: vault,
          kind: "learn-meta-drafted",
          payload: {
            planId,
            findingKind: finding.kind,
            findingKey: key,
          },
          ...(input.now !== undefined && {
            createdAt: input.now.toISOString(),
          }),
        });
      })();
    } finally {
      writeDb.close();
    }

    result.drafted.push({ finding, planId, planPath });
  }

  return result;
}

/** Stable key per finding so we can dedupe across runs. */
function findingDedupeKey(f: LearnFinding): string {
  if (f.kind === "low-approval") {
    return `low-approval:${f.type}:${f.subtype ?? "(none)"}`;
  }
  return `${f.kind}:${f.token}`;
}

function readRecentlyDraftedFindings(dataDir: string): Set<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffIso = cutoff.toISOString();
  const db = new Database(dbFile(dataDir), { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'learn-meta-drafted' AND created_at >= ?",
      )
      .all(cutoffIso) as Array<{ payload: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { findingKey?: unknown };
        if (typeof p.findingKey === "string") out.add(p.findingKey);
      } catch {
        // skip malformed
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function pickFindingsToDraft(
  report: LearnReport,
  threshold: number,
): LearnFinding[] {
  const out: LearnFinding[] = [];
  for (const t of report.rejectionThemes) {
    if (t.count >= threshold) {
      out.push({
        kind: "rejection-theme",
        token: t.token,
        count: t.count,
        examplePlanIds: t.examplePlanIds,
      });
    }
  }
  for (const t of report.reviseThemes) {
    if (t.count >= threshold) {
      out.push({
        kind: "revise-theme",
        token: t.token,
        count: t.count,
        examplePlanIds: t.examplePlanIds,
      });
    }
  }
  for (const lar of report.lowApprovalRates) {
    // Low-approval requires >=threshold total + already-low rate.
    if (lar.total >= threshold) {
      out.push({
        kind: "low-approval",
        type: lar.type,
        subtype: lar.subtype,
        total: lar.total,
        approved: lar.approved,
        rate: lar.rate,
      });
    }
  }
  return out;
}

function buildLearnMetaContext(finding: LearnFinding): string {
  const lines: string[] = [];
  lines.push("Recurring pattern detected by `yarn jarvis learn scan`:");
  lines.push("");
  if (finding.kind === "rejection-theme") {
    lines.push(`Kind: rejection-theme`);
    lines.push(`Token: ${finding.token}`);
    lines.push(`Count: ${finding.count} distinct plans`);
    lines.push(`Example plan ids: ${finding.examplePlanIds.join(", ")}`);
  } else if (finding.kind === "revise-theme") {
    lines.push(`Kind: revise-theme`);
    lines.push(`Token: ${finding.token}`);
    lines.push(`Count: ${finding.count} distinct plans`);
    lines.push(`Example plan ids: ${finding.examplePlanIds.join(", ")}`);
  } else {
    lines.push(`Kind: low-approval`);
    lines.push(
      `Plan category: ${finding.type}${finding.subtype ? `/${finding.subtype}` : ""}`,
    );
    lines.push(`Approval rate: ${finding.approved}/${finding.total} (${Math.round(finding.rate * 100)}%)`);
  }
  lines.push("");
  lines.push(
    "Diagnose what this pattern likely means about Strategist's drafting / the brain / a threshold, and propose ONE intervention as a meta plan.",
  );
  return lines.join("\n");
}

function describeFindingShort(f: LearnFinding): string {
  if (f.kind === "low-approval") {
    return `low-approval ${f.type}${f.subtype ? `/${f.subtype}` : ""}`;
  }
  return `${f.kind} "${f.token}"`;
}

function inferVault(dataDir: string, app: string): string {
  // Walk listOnboardedApps-style: find the vault where this app's
  // brain lives. Default to "personal" when not found (matches the
  // out-of-the-box vault).
  const records = listPlans(dataDir);
  const hit = records.find((r) => r.app === app);
  return hit?.vault ?? "personal";
}

let cachedLearnMetaPrompt: string | undefined;
function loadLearnMetaPrompt(): string {
  if (cachedLearnMetaPrompt !== undefined) return cachedLearnMetaPrompt;
  cachedLearnMetaPrompt = fs.readFileSync(
    path.join(repoRoot(), "prompts", "strategist-learn-meta.md"),
    "utf8",
  );
  return cachedLearnMetaPrompt;
}
