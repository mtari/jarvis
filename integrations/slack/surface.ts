import Database from "better-sqlite3";
import type { WebClient } from "@slack/web-api";
import { appendEvent } from "../../orchestrator/event-log.ts";
import {
  findPlan,
  listPlans,
  type PlanRecord,
} from "../../orchestrator/plan-store.ts";
import type { Plan } from "../../orchestrator/plan.ts";
import { dbFile } from "../../cli/paths.ts";
import {
  buildPlanReviewBlocks,
  buildOutcomeContext,
} from "./blocks/plan-review.ts";

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
    try {
      const result = await surfacePlan(ctx, candidate);
      if (result.posted) surfaced.push(candidate.id);
    } catch (err) {
      errors.push({
        planId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { surfaced, errors };
}

export function reloadPlanFromDisk(
  dataDir: string,
  planId: string,
): { record: PlanRecord; plan: Plan } | null {
  const r = findPlan(dataDir, planId);
  if (!r) return null;
  return { record: r, plan: r.plan };
}
