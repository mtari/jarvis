import { brainSchema, loadBrain, saveBrain } from "./brain.ts";
import { brainFile } from "../cli/paths.ts";

/**
 * Reads the `## Brain changes (proposed)` section of a meta plan and
 * applies each change to the app's brain.
 *
 * Only meta plans (improvement type, subtype meta) are handled — the
 * approve hook short-circuits on anything else. Even within meta
 * plans, the applier fires only when a parseable section exists; a
 * meta plan that proposes changes elsewhere (user-profile, prompts)
 * is silently skipped.
 *
 * Bullet format (enforced by `prompts/strategist-doc-absorb.md`):
 *
 *   - `<dot.path.to.field>`: <add | refine | conflict> — <value>
 *
 * Op semantics:
 *   - `add` / `refine` → set the path to the parsed value. Functionally
 *     identical; the distinction is for the user (added vs updated).
 *   - `conflict` → recorded for review, NOT applied. Operator must
 *     either revise the plan or hand-edit the brain.
 *
 * Value parsing: tries JSON first (so arrays, objects, numbers,
 * booleans, strings-in-quotes work), falls back to a stripped string
 * for unquoted bare values. After applying, the brain is re-validated
 * against the Zod schema; if validation fails the change is reverted
 * and reported as an error.
 */

export type BrainChangeOp = "add" | "refine" | "conflict";

export interface BrainChange {
  /** Dot path, e.g. `brand.voice` or `userPreferences.areasOfInterest`. */
  path: string;
  op: BrainChangeOp;
  /** Parsed value (any JSON type) for add/refine. Unset for conflict. */
  value?: unknown;
  /** Free-text note from the bullet — preserved for audit / display. */
  rawValueText: string;
}

export interface AppliedChange {
  path: string;
  op: BrainChangeOp;
  /** The previous value at the path, for the audit log. */
  previousValue: unknown;
  newValue: unknown;
}

export interface SkippedChange {
  path: string;
  op: BrainChangeOp;
  reason: string;
  rawValueText: string;
}

export interface ApplyBrainUpdatesResult {
  /** True when `## Brain changes (proposed)` section was present + parseable. */
  hasChanges: boolean;
  applied: AppliedChange[];
  skipped: SkippedChange[];
  errors: SkippedChange[];
}

export class BrainUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainUpdateError";
  }
}

/**
 * Pure parser. Given a plan's markdown, extracts the section + bullets.
 * Returns `[]` when the section is missing or has no parseable bullets.
 */
export function parseBrainChanges(planMarkdown: string): BrainChange[] {
  const lines = planMarkdown.split("\n");
  const headerIdx = lines.findIndex((l) =>
    /^##\s+Brain changes \(proposed\)\s*$/.test(l),
  );
  if (headerIdx === -1) return [];
  // Body runs from the line after the header up to the next `## ` header
  // (or the end of the document).
  const bodyLines: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) break;
    bodyLines.push(lines[i] ?? "");
  }
  const out: BrainChange[] = [];
  const bulletPattern =
    /^[-*]\s*`([^`]+)`\s*:\s*(add|refine|conflict)\s*[—–-]\s*(.*)$/i;
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(bulletPattern);
    if (!m) continue;
    const path = m[1]!.trim();
    const op = m[2]!.toLowerCase() as BrainChangeOp;
    const rawValueText = m[3]!.trim();
    const change: BrainChange = { path, op, rawValueText };
    if (op !== "conflict") {
      const parsed = tryParseValue(rawValueText);
      if (parsed.ok) {
        change.value = parsed.value;
      } else {
        // Unparseable add/refine value — keep raw text; applier will
        // mark it as a skipped error.
      }
    }
    out.push(change);
  }
  return out;
}

interface ApplyBrainUpdatesInput {
  dataDir: string;
  vault: string;
  app: string;
  /** Plan markdown — the source of `## Brain changes (proposed)`. */
  planMarkdown: string;
}

/**
 * Applies the parseable changes to the brain. Atomic per-call: either
 * the brain ends up with all add/refine changes applied (and conflicts
 * surfaced as skipped), or the original brain stays untouched (when
 * the post-apply Zod validation fails, the call returns an error
 * without writing).
 */
export function applyBrainUpdates(
  input: ApplyBrainUpdatesInput,
): ApplyBrainUpdatesResult {
  const changes = parseBrainChanges(input.planMarkdown);
  if (changes.length === 0) {
    return { hasChanges: false, applied: [], skipped: [], errors: [] };
  }

  const path = brainFile(input.dataDir, input.vault, input.app);
  const original = loadBrain(path);
  const draft = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;

  const applied: AppliedChange[] = [];
  const skipped: SkippedChange[] = [];
  const errors: SkippedChange[] = [];

  for (const change of changes) {
    if (change.op === "conflict") {
      skipped.push({
        path: change.path,
        op: change.op,
        reason: "marked as conflict by Strategist — review required",
        rawValueText: change.rawValueText,
      });
      continue;
    }
    if (change.value === undefined) {
      errors.push({
        path: change.path,
        op: change.op,
        reason: `couldn't parse value as JSON: ${change.rawValueText}`,
        rawValueText: change.rawValueText,
      });
      continue;
    }
    try {
      const previous = readPath(draft, change.path);
      writePath(draft, change.path, change.value);
      applied.push({
        path: change.path,
        op: change.op,
        previousValue: previous,
        newValue: change.value,
      });
    } catch (err) {
      errors.push({
        path: change.path,
        op: change.op,
        reason: err instanceof Error ? err.message : String(err),
        rawValueText: change.rawValueText,
      });
    }
  }

  if (applied.length === 0) {
    // Nothing to write; surface skip/error info to caller.
    return { hasChanges: true, applied, skipped, errors };
  }

  // Re-validate against the schema. If validation fails, revert — no
  // write. The error path returns each applied change as an error so
  // operators see what couldn't land.
  const validated = brainSchema.safeParse(draft);
  if (!validated.success) {
    const message = validated.error.issues
      .map((e) => `${e.path.map((p) => String(p)).join(".")}: ${e.message}`)
      .join("; ");
    return {
      hasChanges: true,
      applied: [],
      skipped,
      errors: [
        ...errors,
        ...applied.map((a): SkippedChange => ({
          path: a.path,
          op: a.op,
          reason: `post-apply schema validation failed: ${message}`,
          rawValueText: String(a.newValue),
        })),
      ],
    };
  }

  saveBrain(path, validated.data);
  return { hasChanges: true, applied, skipped, errors };
}

// ---------------------------------------------------------------------------
// Path helpers — read + write nested values by dot-path
// ---------------------------------------------------------------------------

function readPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function writePath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  const parts = dotPath.split(".");
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new BrainUpdateError(`invalid dot-path: "${dotPath}"`);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const existing = cur[key];
    if (
      existing === null ||
      existing === undefined ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      // Auto-create intermediate object. Refuses to traverse through
      // an array — brain paths shouldn't index into arrays via dot
      // paths in v1.
      if (Array.isArray(existing)) {
        throw new BrainUpdateError(
          `cannot write through array at "${parts.slice(0, i + 1).join(".")}" — replace the whole array instead`,
        );
      }
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

interface TryParseOk {
  ok: true;
  value: unknown;
}
interface TryParseFail {
  ok: false;
}

function tryParseValue(raw: string): TryParseOk | TryParseFail {
  // Trim a trailing period that prompts sometimes add to flow naturally
  // before bullets. Don't strip if the trimmed string is JSON that
  // legitimately ends in period (very rare).
  let candidate = raw.trim();
  if (candidate.endsWith(".") && !candidate.endsWith("..")) {
    // Try without the trailing period first; fall back to the full string.
    const stripped = candidate.slice(0, -1).trim();
    const r = tryJson(stripped);
    if (r.ok) return r;
  }
  return tryJson(candidate);
}

function tryJson(s: string): TryParseOk | TryParseFail {
  if (s.length === 0) return { ok: false };
  try {
    const parsed = JSON.parse(s) as unknown;
    return { ok: true, value: parsed };
  } catch {
    // Not valid JSON. The prompt asks Strategist to use JSON; an
    // unquoted bare token is unparseable.
    return { ok: false };
  }
}
