import Database from "better-sqlite3";
import type { WebClient } from "@slack/web-api";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  findPlan,
  listPlans,
  type PlanRecord,
} from "../../orchestrator/plan-store.ts";
import type { Plan } from "../../orchestrator/plan.ts";
import { isSuppressed } from "../../orchestrator/suppressions.ts";
import type { SignalSeverity } from "../../tools/scanners/types.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  buildAmendmentReviewBlocks,
  type AmendmentEventData,
} from "./blocks/amendment-review.ts";
import {
  buildPlanReviewBlocks,
  buildOutcomeContext,
} from "./blocks/plan-review.ts";
import { buildSignalAlertBlocks } from "./blocks/signal-alert.ts";

export interface SurfaceContext {
  dataDir: string;
  client: WebClient;
  inboxChannelId: string;
}

export interface SurfaceRecord {
  channel: string;
  messageTs: string;
  surfacedAt: string;
}

interface SlackSurfacedPayload {
  planId: string;
  channel: string;
  messageTs: string;
}

/** Returns the latest surface record for a plan, or null if not surfaced. */
export function findSurfaceRecord(
  dbFilePath: string,
  planId: string,
): SurfaceRecord | null {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT payload, created_at FROM events WHERE kind = 'slack-surfaced' ORDER BY id DESC",
      )
      .all() as Array<{ payload: string; created_at: string }>;
    for (const r of row) {
      try {
        const payload = JSON.parse(r.payload) as SlackSurfacedPayload;
        if (payload.planId === planId) {
          return {
            channel: payload.channel,
            messageTs: payload.messageTs,
            surfacedAt: r.created_at,
          };
        }
      } catch {
        // skip malformed
      }
    }
    return null;
  } finally {
    db.close();
  }
}

export interface SurfacePlanResult {
  /** True when this call actually posted a new message; false when an existing surface was reused. */
  posted: boolean;
  surface: SurfaceRecord;
}

/** Posts a plan to #jarvis-inbox and records the surface event. Idempotent. */
export async function surfacePlan(
  ctx: SurfaceContext,
  record: PlanRecord,
): Promise<SurfacePlanResult> {
  // Skip if already surfaced. Re-surfacing on re-draft happens by the caller
  // explicitly (e.g., `forceSurfacePlan`) — this default path is idempotent.
  const existing = findSurfaceRecord(dbFile(ctx.dataDir), record.id);
  if (existing) return { posted: false, surface: existing };

  const blocks = buildPlanReviewBlocks({
    planId: record.id,
    plan: record.plan,
    path: record.path,
  });

  const result = await ctx.client.chat.postMessage({
    channel: ctx.inboxChannelId,
    blocks,
    text: `Plan to review: ${record.plan.metadata.title}`,
  });

  if (!result.ok || !result.ts) {
    throw new Error(
      `chat.postMessage failed: ${result.error ?? "unknown"}`,
    );
  }

  const db = new Database(dbFile(ctx.dataDir));
  try {
    appendEvent(db, {
      appId: record.app,
      vaultId: record.vault,
      kind: "slack-surfaced",
      payload: {
        planId: record.id,
        channel: ctx.inboxChannelId,
        messageTs: result.ts,
      },
    });
  } finally {
    db.close();
  }

  return {
    posted: true,
    surface: {
      channel: ctx.inboxChannelId,
      messageTs: result.ts,
      surfacedAt: new Date().toISOString(),
    },
  };
}

/** Updates a previously-surfaced plan message in place. Useful after approve/revise/reject. */
export async function updateSurfacedPlan(
  ctx: SurfaceContext,
  record: PlanRecord,
  outcomeContext: string,
): Promise<void> {
  const existing = findSurfaceRecord(dbFile(ctx.dataDir), record.id);
  if (!existing) return; // never surfaced — nothing to update

  const blocks = buildPlanReviewBlocks({
    planId: record.id,
    plan: record.plan,
    path: record.path,
  });
  // Strip the actions block (no longer interactive after a transition)
  const noActions: unknown[] = [
    ...blocks.filter((b) => b.type !== "actions"),
    buildOutcomeContext(outcomeContext),
  ];

  // @slack/web-api's chat.update typing is narrower than @slack/types'
  // KnownBlock (it omits a couple of newer block kinds); the runtime
  // shapes match what the API accepts.
  await ctx.client.chat.update({
    channel: existing.channel,
    ts: existing.messageTs,
    blocks: noActions as never,
    text: `Plan ${record.id}: ${outcomeContext}`,
  });
}

/** Scans for awaiting-review plans not yet surfaced, posts each one. */
export async function runSurfaceTick(ctx: SurfaceContext): Promise<{
  surfaced: string[];
  errors: Array<{ planId: string; error: string }>;
}> {
  const surfaced: string[] = [];
  const errors: Array<{ planId: string; error: string }> = [];

  const candidates = listPlans(ctx.dataDir).filter(
    (p) => p.plan.metadata.status === "awaiting-review",
  );
  for (const candidate of candidates) {
    // Route to the amendment review surface when a pending amendment
    // event exists; otherwise the standard plan-review path.
    const pending = findPendingAmendment(dbFile(ctx.dataDir), candidate.id);
    try {
      if (pending) {
        const result = await surfaceAmendmentReview(ctx, candidate, pending);
        if (result.posted) surfaced.push(`${candidate.id}@amendment`);
      } else {
        const result = await surfacePlan(ctx, candidate);
        if (result.posted) surfaced.push(candidate.id);
      }
    } catch (err) {
      errors.push({
        planId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { surfaced, errors };
}

/**
 * Returns the latest unapplied amendment-proposed event for `planId`,
 * or null when none exists. "Pending" = there's at least one
 * amendment-proposed event AND there are more proposed than applied
 * (re-amend on resume increments both counts).
 *
 * The returned eventId is the auto-increment key of the
 * amendment-proposed event row — used as the dedup key for
 * `slack-amendment-surfaced` events so we don't re-post on every tick.
 */
export function findPendingAmendment(
  dbFilePath: string,
  planId: string,
): AmendmentEventData | null {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const proposedRows = db
      .prepare(
        "SELECT id, payload FROM events WHERE kind = 'amendment-proposed' AND json_extract(payload, '$.planId') = ? ORDER BY id DESC",
      )
      .all(planId) as Array<{ id: number; payload: string }>;
    if (proposedRows.length === 0) return null;

    const appliedCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'amendment-applied' AND json_extract(payload, '$.planId') = ?",
      )
      .get(planId) as { c: number };
    if (proposedRows.length <= appliedCount.c) return null;

    // Latest proposed (rows are DESC sorted by id)
    const latest = proposedRows[0]!;
    let payload: {
      reason?: string;
      proposal?: string;
      branch?: string;
      sha?: string;
      modifiedFileCount?: number;
    };
    try {
      payload = JSON.parse(latest.payload);
    } catch {
      return null;
    }
    if (typeof payload.reason !== "string" || payload.reason.length === 0) {
      return null;
    }
    if (typeof payload.proposal !== "string" || payload.proposal.length === 0) {
      return null;
    }
    return {
      eventId: latest.id,
      reason: payload.reason,
      proposal: payload.proposal,
      ...(typeof payload.branch === "string" && { branch: payload.branch }),
      ...(typeof payload.sha === "string" && { sha: payload.sha }),
      ...(typeof payload.modifiedFileCount === "number" && {
        modifiedFileCount: payload.modifiedFileCount,
      }),
    };
  } finally {
    db.close();
  }
}

/**
 * Returns the surface record for a previously-surfaced amendment event.
 * Lookup is by `amendmentEventId` so re-amend on resume produces a
 * fresh post instead of re-using the prior one.
 */
export function findAmendmentSurfaceRecord(
  dbFilePath: string,
  amendmentEventId: number,
): SurfaceRecord | null {
  const db = new Database(dbFilePath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload, created_at FROM events WHERE kind = 'slack-amendment-surfaced' ORDER BY id DESC",
      )
      .all() as Array<{ payload: string; created_at: string }>;
    for (const r of rows) {
      try {
        const payload = JSON.parse(r.payload) as {
          amendmentEventId?: number;
          channel?: string;
          messageTs?: string;
        };
        if (
          payload.amendmentEventId === amendmentEventId &&
          typeof payload.channel === "string" &&
          typeof payload.messageTs === "string"
        ) {
          return {
            channel: payload.channel,
            messageTs: payload.messageTs,
            surfacedAt: r.created_at,
          };
        }
      } catch {
        // skip malformed
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Posts an amendment-review message to `#jarvis-inbox` and records a
 * `slack-amendment-surfaced` event. Idempotent on the
 * `amendmentEventId`: a re-amend on resume produces a fresh post; the
 * same amendment doesn't re-post on subsequent ticks.
 */
export async function surfaceAmendmentReview(
  ctx: SurfaceContext,
  record: PlanRecord,
  amendment: AmendmentEventData,
): Promise<SurfacePlanResult> {
  const existing = findAmendmentSurfaceRecord(
    dbFile(ctx.dataDir),
    amendment.eventId,
  );
  if (existing) return { posted: false, surface: existing };

  const blocks = buildAmendmentReviewBlocks({
    planId: record.id,
    plan: record.plan,
    amendment,
    path: record.path,
  });

  const result = await ctx.client.chat.postMessage({
    channel: ctx.inboxChannelId,
    blocks,
    text: `Amendment to review: ${record.plan.metadata.title}`,
  });

  if (!result.ok || !result.ts) {
    throw new Error(
      `chat.postMessage failed (amendment): ${result.error ?? "unknown"}`,
    );
  }

  const db = new Database(dbFile(ctx.dataDir));
  try {
    appendEvent(db, {
      appId: record.app,
      vaultId: record.vault,
      kind: "slack-amendment-surfaced",
      payload: {
        planId: record.id,
        amendmentEventId: amendment.eventId,
        channel: ctx.inboxChannelId,
        messageTs: result.ts,
      },
    });
  } finally {
    db.close();
  }

  return {
    posted: true,
    surface: {
      channel: ctx.inboxChannelId,
      messageTs: result.ts,
      surfacedAt: new Date().toISOString(),
    },
  };
}

export function reloadPlanFromDisk(
  dataDir: string,
  planId: string,
): { record: PlanRecord; plan: Plan } | null {
  const r = findPlan(dataDir, planId);
  if (!r) return null;
  return { record: r, plan: r.plan };
}

// ---------------------------------------------------------------------------
// Slice 2 — high/critical signal alerts to #jarvis-alerts
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface AlertContext extends SurfaceContext {
  alertsChannelId: string;
}

export interface AlertableSignal {
  signalEventId: number;
  createdAt: string;
  app: string;
  vault: string;
  kind: string;
  severity: SignalSeverity;
  summary: string;
  dedupKey?: string;
}

/**
 * Returns signal events at or above `threshold` that haven't been
 * surfaced to Slack yet (no `slack-signal-surfaced` event referencing
 * the same signalEventId). Most-recent first; capped at `limit` to
 * keep the per-tick fan-out bounded.
 */
export function findUnpostedAlertableSignals(
  dbFilePath: string,
  opts: { threshold: SignalSeverity; limit?: number },
): AlertableSignal[] {
  const limit = opts.limit ?? 50;
  const minRank = SEVERITY_RANK[opts.threshold];
  const db = new Database(dbFilePath, { readonly: true });
  try {
    // Set of signalEventIds that already have a Slack surface row.
    const posted = new Set<number>();
    const surfacedRows = db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'slack-signal-surfaced'",
      )
      .all() as Array<{ payload: string }>;
    for (const r of surfacedRows) {
      try {
        const p = JSON.parse(r.payload) as { signalEventId?: number };
        if (typeof p.signalEventId === "number") posted.add(p.signalEventId);
      } catch {
        // skip malformed
      }
    }

    const signalRows = db
      .prepare(
        "SELECT id, app_id, vault_id, payload, created_at FROM events WHERE kind = 'signal' ORDER BY id DESC LIMIT ?",
      )
      .all(limit * 4) as Array<{
      id: number;
      app_id: string;
      vault_id: string;
      payload: string;
      created_at: string;
    }>;

    const out: AlertableSignal[] = [];
    for (const row of signalRows) {
      if (posted.has(row.id)) continue;
      let payload: {
        kind?: string;
        severity?: SignalSeverity;
        summary?: string;
        dedupKey?: string;
      };
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (
        typeof payload.kind !== "string" ||
        typeof payload.summary !== "string" ||
        typeof payload.severity !== "string"
      ) {
        continue;
      }
      const rank = SEVERITY_RANK[payload.severity];
      if (rank === undefined || rank < minRank) continue;
      out.push({
        signalEventId: row.id,
        createdAt: row.created_at,
        app: row.app_id,
        vault: row.vault_id,
        kind: payload.kind,
        severity: payload.severity,
        summary: payload.summary,
        ...(typeof payload.dedupKey === "string" && {
          dedupKey: payload.dedupKey,
        }),
      });
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Posts a signal alert to `#jarvis-alerts` and records a
 * `slack-signal-surfaced` event. Idempotent on `signal.signalEventId`.
 */
export async function surfaceSignalAlert(
  ctx: AlertContext,
  signal: AlertableSignal,
): Promise<{ posted: boolean }> {
  const blocks = buildSignalAlertBlocks(signal);
  const result = await ctx.client.chat.postMessage({
    channel: ctx.alertsChannelId,
    blocks,
    text: `${signal.severity.toUpperCase()} signal: ${signal.summary}`,
  });
  if (!result.ok || !result.ts) {
    throw new Error(
      `chat.postMessage failed (alert): ${result.error ?? "unknown"}`,
    );
  }

  const db = new Database(dbFile(ctx.dataDir));
  try {
    appendEvent(db, {
      appId: signal.app,
      vaultId: signal.vault,
      kind: "slack-signal-surfaced",
      payload: {
        signalEventId: signal.signalEventId,
        channel: ctx.alertsChannelId,
        messageTs: result.ts,
        severity: signal.severity,
        ...(signal.dedupKey !== undefined && { dedupKey: signal.dedupKey }),
      },
    });
  } finally {
    db.close();
  }
  return { posted: true };
}

export interface RunAlertTickResult {
  alerted: number[];
  /** Signal event ids skipped because the dedupKey is suppressed. */
  suppressedSkipped: number[];
  errors: Array<{ signalEventId: number; error: string }>;
}

/**
 * One tick: find unposted high/critical signals, skip suppressed ones,
 * post the rest to `#jarvis-alerts`. Per-signal errors are isolated
 * so one bad post doesn't abort the batch.
 */
export async function runAlertTick(
  ctx: AlertContext,
  opts: { threshold: SignalSeverity; limit?: number },
): Promise<RunAlertTickResult> {
  const result: RunAlertTickResult = {
    alerted: [],
    suppressedSkipped: [],
    errors: [],
  };
  const dbPath = dbFile(ctx.dataDir);
  const candidates = findUnpostedAlertableSignals(dbPath, opts);
  for (const candidate of candidates) {
    if (
      candidate.dedupKey !== undefined &&
      isSuppressed(dbPath, candidate.dedupKey)
    ) {
      result.suppressedSkipped.push(candidate.signalEventId);
      // Record a synthetic "surfaced" event so this signal isn't
      // re-evaluated next tick — the suppression decision is sticky
      // until the user lifts the suppression and a new matching
      // signal arrives. (Avoids hammering isSuppressed every tick
      // for high-volume noisy patterns.)
      const conn = new Database(dbPath);
      try {
        appendEvent(conn, {
          appId: candidate.app,
          vaultId: candidate.vault,
          kind: "slack-signal-surfaced",
          payload: {
            signalEventId: candidate.signalEventId,
            severity: candidate.severity,
            suppressed: true,
            ...(candidate.dedupKey !== undefined && {
              dedupKey: candidate.dedupKey,
            }),
          },
        });
      } finally {
        conn.close();
      }
      continue;
    }
    try {
      await surfaceSignalAlert(ctx, candidate);
      result.alerted.push(candidate.signalEventId);
    } catch (err) {
      result.errors.push({
        signalEventId: candidate.signalEventId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
