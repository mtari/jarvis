import Database from "better-sqlite3";
import {
  prepareMarketingPlan,
  MarketerError,
} from "../../agents/marketer.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { reconcileMarketingPlanState } from "../../orchestrator/marketing-plan-lifecycle.ts";
import { listPlans, type PlanRecord } from "../../orchestrator/plan-store.ts";
import {
  countScheduledPosts,
} from "../../orchestrator/scheduled-posts.ts";
import { dbFile } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Marketer auto-fire service. Every ~30s the tick scans for marketing
 * plans whose `status` is `approved` and that haven't yet had their
 * content calendar persisted to `scheduled_posts`. For each, fires
 * `prepareMarketingPlan` — humanizing each post and writing rows.
 *
 * Idempotency: a plan with rows in `scheduled_posts` is skipped (the
 * marketer agent itself is also idempotent on this — defense in
 * depth here keeps us from invoking the LLM at all on the steady-
 * state polling tick).
 *
 * After preparation, the plan stays at `approved`. Plan-level state
 * transitions to `executing` / `done` will land when the publisher
 * tracks plan-level outcome (separate slice).
 */

const DEFAULT_TICK_MS = 30_000;

export interface MarketerServiceOptions {
  dataDir: string;
  /** Tick interval. Default 30s. */
  tickMs?: number;
  /** Override the SDK client used for the humanizer pass (test seam). */
  buildAnthropicClient?: () => AnthropicClient;
  /** @internal */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

export function createMarketerService(
  opts: MarketerServiceOptions,
): DaemonService {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let lazyClient: AnthropicClient | null = null;
  const getClient = (): AnthropicClient => {
    if (!lazyClient) {
      lazyClient = opts.buildAnthropicClient
        ? opts.buildAnthropicClient()
        : createSdkClient();
    }
    return lazyClient;
  };

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  return {
    name: "marketer",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          await runMarketerTick({
            dataDir: opts.dataDir,
            ctx,
            getClient,
          });
        } catch (err) {
          ctx.logger.error("marketer tick errored", err);
        } finally {
          tickInFlight = false;
        }
      };

      void tickFn(); // initial fire
      timer = setInterval(() => void tickFn(), tickMs);
      timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export interface RunMarketerTickInput {
  dataDir: string;
  ctx: DaemonContext;
  getClient: () => AnthropicClient;
}

export interface MarketerTickResult {
  prepared: Array<{ planId: string; postCount: number }>;
  skipped: Array<{ planId: string; reason: string }>;
  errors: Array<{ planId: string; error: string }>;
}

/**
 * Tick body — exported for direct invocation in tests. Walks every
 * plan record, filters to approved marketing plans, fires
 * prepareMarketingPlan on each that hasn't been prepared yet.
 */
export async function runMarketerTick(
  input: RunMarketerTickInput,
): Promise<MarketerTickResult> {
  const result: MarketerTickResult = {
    prepared: [],
    skipped: [],
    errors: [],
  };
  const candidates = pickApprovedMarketingPlans(input.dataDir);
  if (candidates.length === 0) return result;

  const db = new Database(dbFile(input.dataDir), { readonly: true });
  let toFire: PlanRecord[];
  try {
    toFire = candidates.filter((record) => {
      const existing = countScheduledPosts(db, { planId: record.id });
      if (existing > 0) {
        result.skipped.push({
          planId: record.id,
          reason: `already prepared (${existing} rows in scheduled_posts)`,
        });
        return false;
      }
      return true;
    });
  } finally {
    db.close();
  }

  for (const record of toFire) {
    try {
      const fired = await prepareMarketingPlan({
        client: input.getClient(),
        planId: record.id,
        dataDir: input.dataDir,
      });
      result.prepared.push({
        planId: record.id,
        postCount: fired.prepared.length,
      });
      input.ctx.logger.info("marketer fired", {
        planId: record.id,
        app: record.app,
        postCount: fired.prepared.length,
      });
      writeFireEvent(input.dataDir, record, fired.prepared.length);

      // Move plan approved → executing (and possibly → done if every row
      // already terminal, e.g. a plan with all skipped posts; rare but
      // safe). Reconcile is idempotent and per-plan-scoped.
      try {
        const reconcile = reconcileMarketingPlanState({
          dataDir: input.dataDir,
          dbFilePath: dbFile(input.dataDir),
          planId: record.id,
          actor: "marketer",
        });
        for (const t of reconcile.transitioned) {
          input.ctx.logger.info("plan transitioned", {
            planId: record.id,
            from: t.from,
            to: t.to,
          });
        }
      } catch (err) {
        input.ctx.logger.error("plan reconcile failed", err, {
          planId: record.id,
        });
      }
    } catch (err) {
      const reason =
        err instanceof MarketerError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ planId: record.id, error: reason });
      input.ctx.logger.error("marketer fire failed", err, {
        planId: record.id,
        app: record.app,
      });
    }
  }

  return result;
}

function pickApprovedMarketingPlans(dataDir: string): PlanRecord[] {
  return listPlans(dataDir).filter(
    (r) =>
      r.plan.metadata.type === "marketing" &&
      r.plan.metadata.status === "approved",
  );
}

function writeFireEvent(
  dataDir: string,
  record: PlanRecord,
  postCount: number,
): void {
  const db = new Database(dbFile(dataDir));
  try {
    appendEvent(db, {
      appId: record.app,
      vaultId: record.vault,
      kind: "marketer-fired",
      payload: {
        planId: record.id,
        postCount,
      },
    });
  } finally {
    db.close();
  }
}
