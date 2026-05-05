import type { App as BoltApp } from "@slack/bolt";
import { removeAmendmentCheckpoint } from "../../agents/developer.ts";
import {
  redraftPlan,
  runStrategist,
  StrategistError,
  isStrategistPlanType,
  type StrategistPlanType,
} from "../../agents/strategist.ts";
import type { AnthropicClient } from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import {
  approvePlan,
  rejectPlan,
  revisePlan,
} from "../../orchestrator/plan-lifecycle.ts";
import { findPlan } from "../../orchestrator/plan-store.ts";
import { suppress } from "../../orchestrator/suppressions.ts";
import { dbFile } from "../../cli/paths.ts";
import { buildReviseModal } from "./blocks/plan-review.ts";
import { surfacePlan, updateSurfacedPlan, type SurfaceContext } from "./surface.ts";

export interface HandlerContext {
  dataDir: string;
  surfaceCtx: SurfaceContext;
  /**
   * Lazy: returns the SDK-backed AnthropicClient when needed for Strategist
   * work (slash commands, revise auto-redraft). All calls record
   * `mode: "subscription"` on the agent-call event.
   */
  getAnthropicClient: () => AnthropicClient;
  log: (message: string, meta?: Record<string, unknown>) => void;
  logError: (message: string, error?: unknown, meta?: Record<string, unknown>) => void;
}

export function registerHandlers(app: BoltApp, ctx: HandlerContext): void {
  app.action("plan_approve", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const planId = action.value;
    if (!planId) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    const result = approvePlan(ctx.dataDir, dbFile(ctx.dataDir), planId, {
      actor: `slack:${userId}`,
      confirmDestructive: true, // The Block Kit confirm dialog already gated this
    });
    if (!result.ok) {
      ctx.logError("approve via slack failed", null, {
        planId,
        reason: result.reason,
      });
      await postEphemeral(client, body, `✗ Approve failed: ${result.message}`);
      return;
    }
    ctx.log("approved via slack", { planId, userId });
    const updatedRecord = findPlan(ctx.dataDir, planId);
    if (updatedRecord) {
      await updateSurfacedPlan(
        ctx.surfaceCtx,
        updatedRecord,
        `✓ Approved by <@${userId}>${
          result.parentTransitioned
            ? ` — parent ${result.parentTransitioned.id} now executing`
            : ""
        }`,
      );
    }
  });

  app.action("plan_revise", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const planId = action.value;
    if (!planId) return;
    if (body.type !== "block_actions" || !body.trigger_id) return;
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildReviseModal(planId),
      });
    } catch (err) {
      ctx.logError("opening revise modal failed", err, { planId });
    }
  });

  app.view("plan_revise_submit", async ({ ack, body, view, client }) => {
    const planId = view.private_metadata;
    const feedback =
      view.state.values["feedback_block"]?.["feedback_input"]?.value ?? "";
    if (!planId || !feedback) {
      await ack({
        response_action: "errors",
        errors: { feedback_block: "Feedback is required." },
      });
      return;
    }
    await ack();

    const userId = body.user.id ?? "<slack>";
    const reviseResult = revisePlan(
      ctx.dataDir,
      dbFile(ctx.dataDir),
      planId,
      feedback,
      { actor: `slack:${userId}` },
    );
    if (!reviseResult.ok) {
      const summary =
        reviseResult.reason === "at-cap"
          ? `at the cap of ${reviseResult.cap} revisions`
          : reviseResult.message;
      await postDmOrEphemeral(
        client,
        userId,
        body.user.id,
        `✗ Revise failed: ${summary}`,
      );
      return;
    }

    const updatedRecord = findPlan(ctx.dataDir, planId);
    if (updatedRecord) {
      await updateSurfacedPlan(
        ctx.surfaceCtx,
        updatedRecord,
        `↻ Sent back for revision by <@${userId}> (round ${reviseResult.priorRevisions + 1}/3). Strategist redrafting…`,
      );
    }

    // Auto-redraft via Strategist
    const baseClient = ctx.getAnthropicClient();
    const recorder = buildAgentCallRecorder(baseClient, dbFile(ctx.dataDir), {
      app: reviseResult.record.app,
      vault: reviseResult.record.vault,
      agent: "strategist",
      planId,
      mode: "subscription",
    });
    try {
      await redraftPlan({
        client: recorder.client,
        planId,
        app: reviseResult.record.app,
        vault: reviseResult.record.vault,
        dataDir: ctx.dataDir,
      });
      recorder.flush();
      ctx.log("redrafted via slack", { planId });

      // Refresh the surfaced message with the new content + restored buttons
      const refreshedRecord = findPlan(ctx.dataDir, planId);
      if (refreshedRecord) {
        // Re-surface as a fresh message (the old one is now closed/updated above)
        await surfacePlan(ctx.surfaceCtx, refreshedRecord);
      }
    } catch (err) {
      recorder.flush();
      const message =
        err instanceof StrategistError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      ctx.logError("redraft via slack failed", err, { planId });
      await postDmOrEphemeral(
        client,
        userId,
        body.user.id,
        `✗ Redraft failed for ${planId}: ${message}`,
      );
    }
  });

  app.action("plan_reject", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const planId = action.value;
    if (!planId) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    const result = rejectPlan(ctx.dataDir, dbFile(ctx.dataDir), planId, {
      actor: `slack:${userId}`,
    });
    if (!result.ok) {
      await postEphemeral(client, body, `✗ Reject failed: ${result.message}`);
      return;
    }
    // Parity with `yarn jarvis reject`: drop any amendment checkpoint
    // tied to this plan id. No-op when there's no checkpoint.
    removeAmendmentCheckpoint(planId, ctx.dataDir);
    ctx.log("rejected via slack", { planId, userId });
    const updatedRecord = findPlan(ctx.dataDir, planId);
    if (updatedRecord) {
      await updateSurfacedPlan(
        ctx.surfaceCtx,
        updatedRecord,
        `✗ Rejected by <@${userId}>`,
      );
    }
  });

  app.action("signal_suppress", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const dedupKey = action.value;
    if (!dedupKey) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    try {
      suppress(dbFile(ctx.dataDir), {
        patternId: dedupKey,
        pattern: dedupKey,
        reason: `suppressed via slack by ${userId}`,
      });
    } catch (err) {
      ctx.logError("suppress via slack failed", err, { dedupKey });
      await postEphemeral(client, body, `✗ Suppress failed: ${
        err instanceof Error ? err.message : String(err)
      }`);
      return;
    }
    ctx.log("suppressed via slack", { dedupKey, userId });

    // Strip the action button from the original message — the alert
    // is now muted, no further action available.
    if (body.type === "block_actions" && body.message?.ts && body.channel?.id) {
      const trimmed = (body.message.blocks ?? []).filter(
        (b: { type?: string }) => b.type !== "actions",
      );
      try {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          blocks: [
            ...trimmed,
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `🔕 Suppressed by <@${userId}> — \`yarn jarvis unsuppress ${dedupKey}\` to lift.`,
                },
              ],
            },
          ],
          text: `Suppressed: ${dedupKey}`,
        });
      } catch (err) {
        ctx.logError("update after suppress failed", err, { dedupKey });
      }
    }
  });

  app.command("/jarvis", async ({ ack, command, respond }) => {
    await ack();
    const text = (command.text ?? "").trim();
    const parts = text.split(/\s+/).filter((s) => s.length > 0);
    const subcommand = parts[0];
    if (!subcommand) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/jarvis plan <app> <brief>`",
      });
      return;
    }
    if (subcommand !== "plan") {
      await respond({
        response_type: "ephemeral",
        text: `Unknown subcommand \`${subcommand}\`. Available: \`plan\`.`,
      });
      return;
    }

    const app = parts[1];
    const brief = parts.slice(2).join(" ");
    if (!app || !brief) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/jarvis plan <app> <brief>`",
      });
      return;
    }

    // Default to improvement plans via slash. Future: parse --type/--subtype.
    const planType: StrategistPlanType = "improvement";
    if (!isStrategistPlanType(planType)) return; // tautological — keeps the type narrowing tidy

    await respond({
      response_type: "ephemeral",
      text: `📝 Strategist drafting plan for *${app}*…`,
    });

    const baseClient = ctx.getAnthropicClient();
    // No planId yet — we don't have it until Strategist returns
    const recorder = buildAgentCallRecorder(baseClient, dbFile(ctx.dataDir), {
      app,
      vault: "personal",
      agent: "strategist",
      mode: "subscription",
    });

    try {
      const result = await runStrategist({
        client: recorder.client,
        brief,
        app,
        vault: "personal",
        dataDir: ctx.dataDir,
        type: planType,
        challenge: false, // Slack surface skips the Socratic stdin loop
      });
      recorder.ctx.planId = result.planId;
      recorder.flush();

      const surfacedRecord = findPlan(ctx.dataDir, result.planId);
      if (surfacedRecord) {
        await surfacePlan(ctx.surfaceCtx, surfacedRecord);
      }
      await respond({
        response_type: "ephemeral",
        text: `✓ Plan \`${result.planId}\` drafted — see #jarvis-inbox.`,
      });
    } catch (err) {
      recorder.flush();
      const message =
        err instanceof StrategistError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      ctx.logError("/jarvis plan failed", err, { app, brief });
      await respond({
        response_type: "ephemeral",
        text: `✗ Plan drafting failed: ${message}`,
      });
    }
  });
}

async function postEphemeral(
  client: BoltApp["client"] | undefined,
  body: unknown,
  text: string,
): Promise<void> {
  if (!client) return;
  const channel = (body as { channel?: { id?: string } }).channel?.id;
  const user = (body as { user?: { id?: string } }).user?.id;
  if (!channel || !user) return;
  try {
    await client.chat.postEphemeral({ channel, user, text });
  } catch {
    // best-effort
  }
}

async function postDmOrEphemeral(
  client: BoltApp["client"] | undefined,
  userId: string | undefined,
  fallbackUserId: string | undefined,
  text: string,
): Promise<void> {
  if (!client) return;
  const target = userId ?? fallbackUserId;
  if (!target) return;
  try {
    await client.chat.postMessage({ channel: target, text });
  } catch {
    // ignore
  }
}
