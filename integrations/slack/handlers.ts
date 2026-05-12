import type { App as BoltApp } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
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
import Database from "better-sqlite3";
import { appendEvent } from "../../orchestrator/event-log.ts";
import { interpretAsk } from "../../cli/commands/ask.ts";
import { todayLogPath } from "../../cli/commands/logs.ts";
import fs from "node:fs";
import { appendNote } from "../../orchestrator/notes.ts";
import { findPlan, scanPlans } from "../../orchestrator/plan-store.ts";
import {
  approveScheduledPost,
  findScheduledPost,
  skipScheduledPost,
  ScheduledPostMutationError,
} from "../../orchestrator/scheduled-posts.ts";
import { resolveSetupTask } from "../../orchestrator/setup-tasks.ts";
import { suppress } from "../../orchestrator/suppressions.ts";
import { daemonPidFile, dbFile } from "../../cli/paths.ts";
import { readPidFile, defaultIsPidAlive } from "../../orchestrator/daemon-pid.ts";
import { readTodayCallCount } from "../../cli/commands/cost.ts";
import { buildSkipReasonModal } from "./blocks/setup-task.ts";
import {
  buildPostSkipReasonModal,
} from "./blocks/post-review.ts";
import { buildReviseModal } from "./blocks/plan-review.ts";
import {
  autoDraftFromIdeas,
  scoreUnscoredIdeas,
} from "../../agents/scout.ts";
import {
  runDailyAudit,
  type DailyAuditResult,
} from "../../agents/strategist-daily-audit.ts";
import {
  runProjectAudit,
  type ProjectAuditResult,
} from "../../agents/strategist-project-audit.ts";
import { listOnboardedApps } from "../../orchestrator/brain.ts";
import {
  buildInboxSummaryText,
  buildOnDemandTriageBlocks,
  formatDraftResults,
  formatScoreResults,
  parseScoutFlags,
} from "./slash-commands.ts";
import { parseSlashArgs } from "./slash-args.ts";
import {
  surfacePlan,
  updateSurfacedPlan,
  updateSurfacedPost,
  type SurfaceContext,
} from "./surface.ts";
import {
  continueDiscussConversation,
  findDiscussConversation,
  startDiscussConversation,
  type SlackDiscussContext,
} from "./discuss.ts";
import {
  continueIdeaIntakeConversation,
  findIdeaIntakeConversation,
  startIdeaIntakeConversation,
} from "./idea-intake.ts";
import {
  formatIdeaListing,
  listIdeasWithStatus,
} from "../../orchestrator/idea-listing.ts";
import {
  findIdeaByQuery,
  loadBusinessIdeas,
  saveBusinessIdeas,
} from "../../orchestrator/business-ideas.ts";
import { buildIdeasEditModal } from "./blocks/ideas-edit-modal.ts";

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
      if (result.reason === "wrong-state") {
        const currentStatus = result.record?.plan.metadata.status;
        if (currentStatus === "approved") {
          ctx.log("approve via slack noop", { planId });
          await postEphemeral(client, body, `✓ Plan ${planId} already approved`);
        } else {
          ctx.logError("approve via slack failed", null, { planId, reason: result.reason });
          await postEphemeral(
            client,
            body,
            `✗ Approve failed: plan ${planId} is currently ${currentStatus ?? "unknown"} — expected awaiting-review.`,
          );
        }
      } else {
        ctx.logError("approve via slack failed", null, {
          planId,
          reason: result.reason,
        });
        await postEphemeral(client, body, `✗ Approve failed: ${result.message}`);
      }
      return;
    }
    ctx.log("approved via slack", { planId, userId });
    const updatedRecord = findPlan(ctx.dataDir, planId);
    if (updatedRecord) {
      const parts: string[] = [`✓ Approved by <@${userId}>`];
      if (result.parentTransitioned) {
        parts.push(`parent ${result.parentTransitioned.id} now executing`);
      }
      const brain = result.brainChangesApplied;
      if (brain && brain.hasChanges) {
        const segs: string[] = [];
        if (brain.applied.length > 0) {
          segs.push(`brain updated: ${brain.applied.length}`);
        }
        if (brain.skipped.length > 0) {
          segs.push(`skipped: ${brain.skipped.length}`);
        }
        if (brain.errors.length > 0) {
          segs.push(`errors: ${brain.errors.length}`);
        }
        if (segs.length > 0) parts.push(segs.join(", "));
      }
      await updateSurfacedPlan(ctx.surfaceCtx, updatedRecord, parts.join(" — "));
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

  app.action("setup_task_done", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const taskId = action.value;
    if (!taskId) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    const result = resolveSetupTask(ctx.dataDir, dbFile(ctx.dataDir), taskId, {
      status: "done",
      actor: `slack:${userId}`,
    });
    if (!result.ok) {
      ctx.logError("setup-task done failed", null, { taskId, message: result.message });
      await postEphemeral(client, body, `✗ ${result.message ?? "Mark done failed"}`);
      return;
    }
    ctx.log("setup-task resolved (done) via slack", { taskId, userId });
    await closeSetupTaskMessage(client, body, `✓ Done by <@${userId}>`);
  });

  app.action("setup_task_skip", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const taskId = action.value;
    if (!taskId) return;
    if (body.type !== "block_actions" || !body.trigger_id) return;
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildSkipReasonModal(taskId),
      });
    } catch (err) {
      ctx.logError("opening setup-task skip modal failed", err, { taskId });
    }
  });

  app.view("setup_task_skip_submit", async ({ ack, body, view, client }) => {
    const taskId = view.private_metadata;
    const reason =
      view.state.values["reason_block"]?.["reason_input"]?.value ?? "";
    if (!taskId || !reason) {
      await ack({
        response_action: "errors",
        errors: { reason_block: "Reason is required." },
      });
      return;
    }
    await ack();
    const userId = body.user.id ?? "<slack>";

    const result = resolveSetupTask(ctx.dataDir, dbFile(ctx.dataDir), taskId, {
      status: "skipped",
      actor: `slack:${userId}`,
      skipReason: reason,
    });
    if (!result.ok) {
      ctx.logError("setup-task skip failed", null, { taskId, message: result.message });
      await postDmOrEphemeral(
        client,
        userId,
        body.user.id,
        `✗ ${result.message ?? "Skip failed"}`,
      );
      return;
    }
    ctx.log("setup-task resolved (skipped) via slack", { taskId, userId });
    // We don't have the original message ts on a view submission, so
    // we DM the user — the surface tick won't repost a resolved task,
    // and the channel message will eventually look stale (acceptable).
    await postDmOrEphemeral(
      client,
      userId,
      body.user.id,
      `↪ Skipped \`${taskId}\` — reason recorded.`,
    );
  });

  app.action("escalation_acknowledge", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const eventIdStr = action.value;
    const escalationEventId = eventIdStr ? Number.parseInt(eventIdStr, 10) : NaN;
    if (!Number.isFinite(escalationEventId)) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    // Record an `escalation-acknowledged` event for the audit trail.
    // The Slack message itself gets its action stripped + a context
    // line appended so the team can see it's been seen.
    try {
      const conn = new Database(dbFile(ctx.dataDir));
      try {
        appendEvent(conn, {
          appId: "jarvis",
          vaultId: "personal",
          kind: "escalation-acknowledged",
          payload: {
            escalationEventId,
            actor: `slack:${userId}`,
          },
        });
      } finally {
        conn.close();
      }
    } catch (err) {
      ctx.logError("escalation acknowledge — DB write failed", err, {
        escalationEventId,
      });
      // Continue to the message update — best-effort
    }
    ctx.log("escalation acknowledged via slack", {
      escalationEventId,
      userId,
    });

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
                  text: `✓ Acknowledged by <@${userId}>.`,
                },
              ],
            },
          ],
          text: `Acknowledged: escalation #${escalationEventId}`,
        });
      } catch (err) {
        ctx.logError("update after escalation acknowledge failed", err, {
          escalationEventId,
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Discuss proposal buttons — Accept / Drop
  // -------------------------------------------------------------------------

  app.action("discuss_accept", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const threadTs = action.value;
    if (!threadTs) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";
    const channelId =
      body.type === "block_actions" ? body.channel?.id : undefined;
    if (!channelId) return;

    try {
      const result = await continueDiscussConversation({
        ctx: {
          dataDir: ctx.dataDir,
          client,
          anthropic: ctx.getAnthropicClient(),
        },
        channel: channelId,
        threadTs,
        userText: "y",
        userId,
      });
      ctx.log("discuss accept via slack", {
        channel: channelId,
        threadTs,
        status: result.status,
      });
      await stripDiscussButtons(client, body, `✓ Accepted by <@${userId}>`);
    } catch (err) {
      ctx.logError("discuss accept failed", err, {
        channel: channelId,
        threadTs,
      });
      await postEphemeral(
        client,
        body,
        `✗ Accept failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  app.action("discuss_drop", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const threadTs = action.value;
    if (!threadTs) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";
    const channelId =
      body.type === "block_actions" ? body.channel?.id : undefined;
    if (!channelId) return;

    try {
      const result = await continueDiscussConversation({
        ctx: {
          dataDir: ctx.dataDir,
          client,
          anthropic: ctx.getAnthropicClient(),
        },
        channel: channelId,
        threadTs,
        userText: "n",
        userId,
      });
      ctx.log("discuss drop via slack", {
        channel: channelId,
        threadTs,
        status: result.status,
      });
      await stripDiscussButtons(
        client,
        body,
        `↪ Dropped by <@${userId}> — Jarvis will refine and try again.`,
      );
    } catch (err) {
      ctx.logError("discuss drop failed", err, {
        channel: channelId,
        threadTs,
      });
      await postEphemeral(
        client,
        body,
        `✗ Drop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Discuss thread replies — drive the conversation forward
  // -------------------------------------------------------------------------

  app.message(async ({ message, client }) => {
    // Filter: only thread replies (need thread_ts), not the bot's own
    // messages, and not edits/deletes (we ignore those entirely).
    const m = message as {
      type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };
    if (m.type !== "message") return;
    if (m.subtype !== undefined) return; // skip message_changed, file_share, etc.
    if (m.bot_id !== undefined) return; // skip bot messages
    if (!m.thread_ts || m.thread_ts === m.ts) return; // not a thread reply
    if (!m.channel || !m.user || !m.text) return;

    // Route the reply to whichever thread-owning system claims it.
    // Discuss and idea-intake both use Slack threads; we look up by
    // (channel, thread_ts) in each store and dispatch on the match.
    const discussLookup = findDiscussConversation(
      ctx.dataDir,
      m.channel,
      m.thread_ts,
    );
    if (discussLookup) {
      try {
        const result = await continueDiscussConversation({
          ctx: {
            dataDir: ctx.dataDir,
            client,
            anthropic: ctx.getAnthropicClient(),
          },
          channel: m.channel,
          threadTs: m.thread_ts,
          userText: m.text,
          userId: m.user,
        });
        ctx.log("discuss thread continued via slack", {
          channel: m.channel,
          threadTs: m.thread_ts,
          status: result.status,
          ...(result.outcome !== undefined && { outcome: result.outcome }),
        });
      } catch (err) {
        ctx.logError("discuss thread reply failed", err, {
          channel: m.channel,
          threadTs: m.thread_ts,
        });
        try {
          await client.chat.postMessage({
            channel: m.channel,
            thread_ts: m.thread_ts,
            text: `✗ Discuss errored: ${
              err instanceof Error ? err.message : String(err)
            }. Reply again to retry.`,
          });
        } catch {
          // best-effort
        }
      }
      return;
    }

    const ideaLookup = findIdeaIntakeConversation(
      ctx.dataDir,
      m.channel,
      m.thread_ts,
    );
    if (ideaLookup) {
      try {
        const result = await continueIdeaIntakeConversation({
          ctx: { dataDir: ctx.dataDir, client },
          channel: m.channel,
          threadTs: m.thread_ts,
          userText: m.text,
          userId: m.user,
        });
        ctx.log("idea-intake thread continued via slack", {
          channel: m.channel,
          threadTs: m.thread_ts,
          status: result.status,
          ...(result.ideaId !== undefined && { ideaId: result.ideaId }),
        });
      } catch (err) {
        ctx.logError("idea-intake thread reply failed", err, {
          channel: m.channel,
          threadTs: m.thread_ts,
        });
        try {
          await client.chat.postMessage({
            channel: m.channel,
            thread_ts: m.thread_ts,
            text: `✗ Idea intake errored: ${
              err instanceof Error ? err.message : String(err)
            }. Reply again to retry.`,
          });
        } catch {
          // best-effort
        }
      }
      return;
    }

    // Neither system owns this thread — ignore.
  });

  app.command("/jarvis", async ({ ack, command, respond, client }) => {
    await ack();
    const text = (command.text ?? "").trim();
    const parts = text.split(/\s+/).filter((s) => s.length > 0);
    const subcommand = parts[0];

    if (!subcommand) {
      await respond({ response_type: "ephemeral", text: SLASH_USAGE });
      return;
    }

    switch (subcommand) {
      case "plan":
        return runSlashPlan(text.slice(subcommand.length).trim(), ctx, respond, "improvement");
      case "bug":
        return runSlashPlan(text.slice(subcommand.length).trim(), ctx, respond, "improvement", "bugfix");
      case "inbox":
        return runSlashInbox(ctx, respond);
      case "triage":
        return runSlashTriage(ctx, respond, command.channel_id, client);
      case "scout": {
        const sub = parts[1];
        if (sub === "score") {
          return runSlashScoutScore(parts.slice(2), ctx, respond);
        }
        if (sub === "draft") {
          return runSlashScoutDraft(parts.slice(2), ctx, respond);
        }
        await respond({
          response_type: "ephemeral",
          text: "Usage: `/jarvis scout score|draft [--threshold N] [--vault <v>]`",
        });
        return;
      }
      case "ideas": {
        const sub = parts[1];
        if (sub === "add") {
          return runSlashIdeasAdd(parts.slice(2), ctx, respond, command, client);
        }
        if (sub === "list") {
          return runSlashIdeasList(parts.slice(2), ctx, respond);
        }
        if (sub === "edit") {
          return runSlashIdeasEdit(parts.slice(2), ctx, respond, command, client);
        }
        await respond({
          response_type: "ephemeral",
          text: "Usage: `/jarvis ideas add|list|edit [--vault <v>]`",
        });
        return;
      }
      case "daily-audit":
        return runSlashDailyAudit(parts.slice(1), ctx, respond);
      case "project-audit":
        return runSlashProjectAudit(parts.slice(1), ctx, respond);
      case "logs":
        return runSlashLogs(parts.slice(1), ctx, respond);
      case "notes":
        return runSlashNotes(parts.slice(1), ctx, respond, command);
      case "ask":
        return runSlashAsk(parts.slice(1).join(" "), ctx, respond);
      case "discuss":
        return runSlashDiscuss(parts.slice(1), ctx, respond, command, client);
      case "status":
        return runSlashStatus(ctx, respond);
      default:
        await respond({
          response_type: "ephemeral",
          text: `Unknown subcommand \`${subcommand}\`. Available: \`plan\`, \`bug\`, \`inbox\`, \`triage\`, \`scout score\`, \`scout draft\`, \`ideas add\`, \`ideas list\`, \`ideas edit\`, \`daily-audit\`, \`project-audit\`, \`logs\`, \`notes\`, \`ask\`, \`discuss\`, \`status\`.`,
        });
    }
  });

  // -------------------------------------------------------------------------
  // Post-review buttons (single-post plans, §10)
  // -------------------------------------------------------------------------

  app.action("post_approve", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const postId = action.value;
    if (!postId) return;
    const userId = "user" in body && body.user?.id ? body.user.id : "<slack>";

    const conn = new Database(dbFile(ctx.dataDir));
    try {
      try {
        approveScheduledPost(conn, postId, { actor: `slack:${userId}` });
      } catch (err) {
        const message =
          err instanceof ScheduledPostMutationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.logError("post approve via slack failed", err, { postId });
        await postEphemeral(client, body, `✗ Approve failed: ${message}`);
        return;
      }
      appendEvent(conn, {
        appId: "marketer",
        vaultId: "personal",
        kind: "post-approved",
        payload: { postId, actor: `slack:${userId}` },
      });
    } finally {
      conn.close();
    }
    ctx.log("post approved via slack", { postId, userId });

    const updated = (() => {
      const c = new Database(dbFile(ctx.dataDir), { readonly: true });
      try {
        return findScheduledPost(c, postId);
      } finally {
        c.close();
      }
    })();
    if (updated) {
      const planRecord = findPlan(ctx.dataDir, updated.planId);
      const planTitle = planRecord?.plan.metadata.title;
      await updateSurfacedPost(
        ctx.surfaceCtx,
        updated,
        `✓ Approved by <@${userId}>`,
        planTitle !== undefined ? { planTitle } : {},
      );
    }
  });

  app.action("post_skip", async ({ ack, body, action, client }) => {
    await ack();
    if (action.type !== "button") return;
    const postId = action.value;
    if (!postId) return;
    if (body.type !== "block_actions" || !body.trigger_id) return;
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildPostSkipReasonModal(postId),
      });
    } catch (err) {
      ctx.logError("opening post skip modal failed", err, { postId });
    }
  });

  app.view("ideas_edit_submit", async ({ ack, body, view, client }) => {
    let ideaId: string;
    let rescoreDefault: boolean;
    try {
      const meta = JSON.parse(view.private_metadata) as { ideaId?: unknown; rescoreDefault?: unknown };
      if (typeof meta.ideaId !== "string" || !meta.ideaId) throw new Error("missing ideaId");
      ideaId = meta.ideaId;
      rescoreDefault = meta.rescoreDefault === true;
    } catch {
      await ack({
        response_action: "errors",
        errors: { body_block: "Invalid metadata. Try opening the modal again." },
      });
      return;
    }
    await ack();

    const userId = body.user.id ?? "<slack>";
    const newBody = view.state.values["body_block"]?.["body_input"]?.value ?? "";
    const rescoreBlock = (
      view.state.values["rescore_block"]?.["rescore_checkbox"] as
        | { selected_options?: Array<{ value: string }> }
        | undefined
    );
    const doRescore = (rescoreBlock?.selected_options ?? []).some((o) => o.value === "rescore");

    const file = loadBusinessIdeas(ctx.dataDir);
    const idx = file.ideas.findIndex((i) => i.id === ideaId);
    if (idx < 0) {
      await client.chat.postMessage({
        channel: ctx.surfaceCtx.inboxChannelId,
        text: `✗ <@${userId}> tried to edit idea \`${ideaId}\` but it wasn't found.`,
      });
      return;
    }

    const oldBodyLength = file.ideas[idx]!.body.length;
    const ideaTitle = file.ideas[idx]!.title;
    const { score: _s, scoredAt: _sa, rationale: _r, ...ideaRest } = file.ideas[idx]!;
    void _s; void _sa; void _r;
    file.ideas[idx] = { ...ideaRest, body: newBody };
    saveBusinessIdeas(ctx.dataDir, file);

    const conn = new Database(dbFile(ctx.dataDir));
    try {
      appendEvent(conn, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "idea-edited",
        payload: {
          ideaId,
          bytesDelta: newBody.length - oldBodyLength,
          source: "slack",
          actor: `slack:${userId}`,
        },
      });
    } finally {
      conn.close();
    }

    await client.chat.postMessage({
      channel: ctx.surfaceCtx.inboxChannelId,
      text: doRescore
        ? `:pencil: <@${userId}> updated *${ideaTitle}*. Rescoring now…`
        : `:pencil: <@${userId}> updated *${ideaTitle}*. Scout will rescore on next tick.`,
    });

    void rescoreDefault; // used only to populate the modal's default state

    if (doRescore) {
      try {
        const result = await scoreUnscoredIdeas({
          dataDir: ctx.dataDir,
          client: ctx.getAnthropicClient(),
          vault: "personal",
        });
        const scored = result.entries.find((e) => e.ideaId === ideaId && e.score !== undefined);
        if (scored !== undefined) {
          await client.chat.postMessage({
            channel: ctx.surfaceCtx.inboxChannelId,
            text: `*${ideaTitle}* → Score: *${scored.score}*`,
          });
        }
      } catch (err) {
        await client.chat.postMessage({
          channel: ctx.surfaceCtx.inboxChannelId,
          text: `:warning: Rescore failed for *${ideaTitle}*: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  });

  app.view("post_skip_submit", async ({ ack, body, view, client }) => {
    const postId = view.private_metadata;
    const reason =
      view.state.values["skip_reason_block"]?.["skip_reason_input"]?.value ?? "";
    if (!postId || !reason || reason.trim().length === 0) {
      await ack({
        response_action: "errors",
        errors: { skip_reason_block: "Reason is required." },
      });
      return;
    }
    await ack();
    const userId = body.user.id ?? "<slack>";

    const conn = new Database(dbFile(ctx.dataDir));
    try {
      try {
        skipScheduledPost(conn, postId, {
          reason: reason.trim(),
          actor: `slack:${userId}`,
        });
      } catch (err) {
        const message =
          err instanceof ScheduledPostMutationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.logError("post skip via slack failed", err, { postId });
        await postDmOrEphemeral(
          client,
          userId,
          body.user.id,
          `✗ Skip failed: ${message}`,
        );
        return;
      }
      appendEvent(conn, {
        appId: "marketer",
        vaultId: "personal",
        kind: "post-skipped",
        payload: { postId, actor: `slack:${userId}`, reason: reason.trim() },
      });
    } finally {
      conn.close();
    }
    ctx.log("post skipped via slack", { postId, userId });

    const updated = (() => {
      const c = new Database(dbFile(ctx.dataDir), { readonly: true });
      try {
        return findScheduledPost(c, postId);
      } finally {
        c.close();
      }
    })();
    if (updated) {
      const planRecord = findPlan(ctx.dataDir, updated.planId);
      const planTitle = planRecord?.plan.metadata.title;
      await updateSurfacedPost(
        ctx.surfaceCtx,
        updated,
        `↪ Skipped by <@${userId}> — ${reason.trim()}`,
        planTitle !== undefined ? { planTitle } : {},
      );
    }
    await postDmOrEphemeral(
      client,
      userId,
      body.user.id,
      `↪ Skipped \`${postId}\`.`,
    );
  });
}

const SLASH_USAGE = [
  "*Available `/jarvis` subcommands:*",
  "• `/jarvis plan <app> <brief>` — draft an improvement plan",
  "• `/jarvis bug <app> <description>` — draft a bugfix plan",
  "• `/jarvis inbox` — show pending plan reviews + setup tasks (just for you)",
  "• `/jarvis triage` — post the on-demand triage report to this channel",
  "• `/jarvis scout score [--vault <v>]` — score unscored ideas in `Business_Ideas.md`",
  "• `/jarvis scout draft [--threshold N] [--vault <v>]` — auto-draft plans from high-scoring ideas",
  "• `/jarvis ideas add [--vault <v>]` — capture a new idea via thread interview, append to `Business_Ideas.md`",
  "• `/jarvis ideas list [--vault <v>]` — show every idea with its score (high → low, then unscored)",
  "• `/jarvis ideas edit <query> [--rescore]` — opens a modal to edit the idea body (3000 char max); `--rescore` rescores on save; CLI handles title/app/tags and long bodies",
  "• `/jarvis daily-audit [--dry-run] [--force]` — manually fire the daily self-audit (daemon already runs it once per day)",
  "• `/jarvis project-audit --app <name> | --all [--dry-run] [--force] [--no-research]` — manually fire per-app project audit",
  "• `/jarvis logs [--lines N]` — snapshot of last N lines of today's daemon log (default 50, max 200)",
  "• `/jarvis notes <app> <text>` — append a free-text note read by Strategist / Scout / Developer",
  "• `/jarvis ask <text>` — natural-language router into the right Jarvis command",
  "• `/jarvis discuss <app> <topic>` — open a multi-turn co-owner conversation in a thread",
  "• `/jarvis status` — daemon liveness, plan-queue depth, and recent activity",
].join("\n");

type SlashRespond = (args: {
  response_type: "ephemeral" | "in_channel";
  text?: string;
  blocks?: KnownBlock[];
}) => Promise<unknown>;

async function runSlashPlan(
  rawArgs: string,
  ctx: HandlerContext,
  respond: SlashRespond,
  planType: StrategistPlanType,
  callerSubtype?: string,
): Promise<void> {
  const parsed = parseSlashArgs(rawArgs);

  if (parsed.parseError) {
    await respond({
      response_type: "ephemeral",
      text:
        `Couldn't parse args: ${parsed.parseError}. ` +
        `Use \`/jarvis ${callerSubtype ?? "plan"} --app <name> "<brief>"\` or \`/jarvis ${callerSubtype ?? "plan"} <name> "<brief>"\`.`,
    });
    return;
  }

  const app = parsed.app;
  const brief = parsed.rest;
  const subtype = callerSubtype ?? parsed.type;
  const subtypeLabel = subtype ? `${planType}/${subtype}` : planType;
  const usage = callerSubtype
    ? `Usage: \`/jarvis bug <app> <description>\``
    : `Usage: \`/jarvis plan <app> <brief>\``;

  if (!app || app.startsWith("--")) {
    await respond({
      response_type: "ephemeral",
      text:
        `Couldn't parse app name from \`${rawArgs}\`. ` +
        `Use \`/jarvis ${callerSubtype ?? "plan"} --app <name> "<brief>"\` or \`/jarvis ${callerSubtype ?? "plan"} <name> "<brief>"\`.`,
    });
    return;
  }

  if (!brief) {
    await respond({ response_type: "ephemeral", text: usage });
    return;
  }

  if (!isStrategistPlanType(planType)) return;

  await respond({
    response_type: "ephemeral",
    text: `📝 Strategist drafting *${subtypeLabel}* plan for *${app}*…`,
  });

  const baseClient = ctx.getAnthropicClient();
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
      ...(subtype !== undefined && { subtype }),
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
    ctx.logError(`/jarvis ${subtype ?? "plan"} failed`, err, { app, brief });
    await respond({
      response_type: "ephemeral",
      text: `✗ Plan drafting failed: ${message}`,
    });
  }
}

async function runSlashInbox(
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  try {
    const text = buildInboxSummaryText({ dataDir: ctx.dataDir });
    await respond({ response_type: "ephemeral", text });
  } catch (err) {
    ctx.logError("/jarvis inbox failed", err);
    await respond({
      response_type: "ephemeral",
      text: `✗ Inbox lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashTriage(
  ctx: HandlerContext,
  respond: SlashRespond,
  channelId: string | undefined,
  client: BoltApp["client"] | undefined,
): Promise<void> {
  await respond({
    response_type: "ephemeral",
    text: "📋 Building on-demand triage report…",
  });
  try {
    const result = buildOnDemandTriageBlocks({ dataDir: ctx.dataDir });
    // Post in the channel where the slash was issued so the team
    // sees the same report. Falls back to inbox channel when the
    // user invoked the command in a DM (no channel id available
    // for posting back to).
    const target = channelId ?? ctx.surfaceCtx.inboxChannelId;
    if (!client) return;
    await client.chat.postMessage({
      channel: target,
      blocks: result.blocks,
      text: result.text,
    });
    ctx.log("on-demand triage posted via slack", { date: result.date, channel: target });
  } catch (err) {
    ctx.logError("/jarvis triage failed", err);
    await respond({
      response_type: "ephemeral",
      text: `✗ Triage build failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashDailyAudit(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  // Light flag parsing — only --dry-run and --force.
  let dryRun = false;
  let force = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
  }

  await respond({
    response_type: "ephemeral",
    text: ":calendar: Running daily self-audit…",
  });

  let result: DailyAuditResult;
  try {
    result = await runDailyAudit({
      dataDir: ctx.dataDir,
      client: ctx.getAnthropicClient(),
      ...(dryRun && { dryRun: true }),
      ...(force && { force: true }),
    });
  } catch (err) {
    ctx.logError("/jarvis daily-audit failed", err, { dryRun, force });
    await respond({
      response_type: "ephemeral",
      text: `✗ Daily audit failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  ctx.log("daily-audit via slack", {
    dryRun,
    force,
    ran: result.ran,
    ...(result.skipReason !== undefined && { skipReason: result.skipReason }),
    drafted: result.drafted.length,
    errors: result.errors.length,
  });

  await respond({
    response_type: "ephemeral",
    text: formatDailyAuditResult(result),
  });
}

function formatDailyAuditResult(result: DailyAuditResult): string {
  const lines: string[] = [];
  if (!result.ran) {
    lines.push(`:fast_forward: *Daily audit skipped* — \`${result.skipReason}\``);
    lines.push(`• \`jarvis\` backlog depth: ${result.backlogDepth}`);
    lines.push(`• Project shipments (last 7d): ${result.projectShipments}`);
    return lines.join("\n");
  }
  lines.push(":white_check_mark: *Daily audit ran*");
  lines.push(`• \`jarvis\` backlog depth (before): ${result.backlogDepth}`);
  lines.push(`• Project shipments (last 7d): ${result.projectShipments}`);
  if (result.drafted.length === 0) {
    lines.push("• Drafted: _(none — dry-run or no slots)_");
  } else {
    lines.push(`• Drafted ${result.drafted.length} plan(s):`);
    for (const d of result.drafted) {
      lines.push(`    • \`${d.planId}\``);
    }
  }
  if (result.errors.length > 0) {
    lines.push("• Errors:");
    for (const e of result.errors) lines.push(`    • ${e}`);
  }
  return lines.join("\n");
}

async function runSlashProjectAudit(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  let app: string | undefined;
  let all = false;
  let dryRun = false;
  let force = false;
  let disableResearch = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--app" && args[i + 1]) {
      app = args[i + 1];
      i += 1;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--no-research") {
      disableResearch = true;
    }
  }

  if (!app && !all) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/jarvis project-audit --app <name> | --all [--dry-run] [--force] [--no-research]`",
    });
    return;
  }

  const client = ctx.getAnthropicClient();

  if (app) {
    const appName = app;
    await respond({
      response_type: "ephemeral",
      text: `:mag: Running project audit for *${appName}*…`,
    });
    let result: ProjectAuditResult;
    try {
      result = await runProjectAudit({
        dataDir: ctx.dataDir,
        app: appName,
        vault: "personal",
        client,
        dryRun,
        force,
        disableResearch,
      });
    } catch (err) {
      ctx.logError("/jarvis project-audit failed", err, { app: appName });
      await respond({
        response_type: "ephemeral",
        text: `✗ Project audit failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    ctx.log("project-audit via slack", {
      app: appName,
      dryRun,
      force,
      disableResearch,
      ran: result.ran,
      ...(result.skipReason !== undefined && { skipReason: result.skipReason }),
      drafted: result.drafted.length,
      errors: result.errors.length,
    });
    await respond({
      response_type: "ephemeral",
      text: formatProjectAuditResult(appName, result),
    });
    return;
  }

  // --all
  const apps = listOnboardedApps(ctx.dataDir).filter((a) => a.app !== "jarvis");
  const summaries: string[] = [];
  for (const { app: appName, vault } of apps) {
    let result: ProjectAuditResult;
    try {
      result = await runProjectAudit({
        dataDir: ctx.dataDir,
        app: appName,
        vault,
        client,
        dryRun,
        force,
        disableResearch,
      });
    } catch (err) {
      summaries.push(
        `• *${appName}*: errored — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!result.ran) {
      summaries.push(`• *${appName}*: skipped (\`${result.skipReason ?? "unknown"}\`)`);
    } else if (result.drafted.length === 0) {
      summaries.push(`• *${appName}*: ran — mode: ${result.mode}, drafted: (none)`);
    } else {
      summaries.push(
        `• *${appName}*: ran — mode: ${result.mode}, drafted: ${result.drafted.map((d) => d.planId).join(", ")}`,
      );
    }
  }

  const header = `:mag: *Project audit — all apps* (${apps.length} total)`;
  const body = summaries.length > 0 ? summaries.join("\n") : "_No non-jarvis apps found._";
  await respond({ response_type: "ephemeral", text: `${header}\n${body}` });
}

function formatProjectAuditResult(app: string, result: ProjectAuditResult): string {
  const lines: string[] = [];
  if (!result.ran) {
    lines.push(`:fast_forward: *Project audit skipped* for *${app}* — \`${result.skipReason}\``);
    return lines.join("\n");
  }
  lines.push(`:white_check_mark: *Project audit ran* for *${app}* (mode: ${result.mode})`);
  if (result.drafted.length === 0) {
    lines.push("• Drafted: _(none — dry-run or no slots)_");
  } else {
    lines.push(`• Drafted ${result.drafted.length} plan(s):`);
    for (const d of result.drafted) {
      lines.push(`    • \`${d.planId}\``);
    }
  }
  if (result.errors.length > 0) {
    lines.push("• Errors:");
    for (const e of result.errors) lines.push(`    • ${e}`);
  }
  return lines.join("\n");
}

const LOGS_DEFAULT_LINES = 50;
const LOGS_MAX_LINES = 200;
// Slack ephemeral text caps at ~40k chars; leave headroom for the code-fence
// wrapper and the truncation notice.
const LOGS_MAX_BODY_CHARS = 35_000;

async function runSlashLogs(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  let lines = LOGS_DEFAULT_LINES;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--lines" && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        await respond({
          response_type: "ephemeral",
          text: `Invalid --lines value \`${args[i + 1]}\` — must be a positive integer.`,
        });
        return;
      }
      lines = Math.min(parsed, LOGS_MAX_LINES);
      i += 1;
    }
  }

  const logFile = todayLogPath(ctx.dataDir);
  if (!fs.existsSync(logFile)) {
    await respond({
      response_type: "ephemeral",
      text: `:warning: Today's daemon log not found at \`${logFile}\`. The daemon may not have started yet.`,
    });
    return;
  }

  let body: string;
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const allLines = text.split("\n").filter((l) => l.length > 0);
    body = allLines.slice(-lines).join("\n");
  } catch (err) {
    await respond({
      response_type: "ephemeral",
      text: `:x: Failed to read log file: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  let truncationNotice = "";
  if (body.length > LOGS_MAX_BODY_CHARS) {
    body = body.slice(body.length - LOGS_MAX_BODY_CHARS);
    // Drop any partial line at the start so the head isn't a half-line.
    const firstNewline = body.indexOf("\n");
    if (firstNewline > 0) body = body.slice(firstNewline + 1);
    truncationNotice =
      "_…older lines truncated to fit Slack's message limit._\n";
  }

  const header = `:scroll: Last ${lines} line(s) of \`${logFile.split("/").pop()}\`:`;
  await respond({
    response_type: "ephemeral",
    text: `${header}\n${truncationNotice}\`\`\`\n${body}\n\`\`\``,
  });
}

async function runSlashScoutScore(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  const { vault } = parseScoutFlags(args);
  await respond({
    response_type: "ephemeral",
    text: "🔍 Scout scoring unscored ideas…",
  });
  try {
    const client = ctx.getAnthropicClient();
    const result = await scoreUnscoredIdeas({
      dataDir: ctx.dataDir,
      client,
      vault,
    });
    ctx.log("scout score via slack", {
      vault,
      scored: result.scoredCount,
      errors: result.errorCount,
    });
    await respond({ response_type: "ephemeral", text: formatScoreResults(result) });
  } catch (err) {
    ctx.logError("/jarvis scout score failed", err, { vault });
    await respond({
      response_type: "ephemeral",
      text: `✗ Scout score failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashScoutDraft(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  const flags = parseScoutFlags(args);
  await respond({
    response_type: "ephemeral",
    text: `📝 Scout drafting plans for ideas scoring ≥ ${flags.threshold ?? 80}…`,
  });
  try {
    const client = ctx.getAnthropicClient();
    const result = await autoDraftFromIdeas({
      dataDir: ctx.dataDir,
      vault: flags.vault,
      client,
      ...(flags.threshold !== undefined && { scoreThreshold: flags.threshold }),
    });
    ctx.log("scout draft via slack", {
      vault: flags.vault,
      drafted: result.draftedCount,
      errors: result.errorCount,
    });
    await respond({ response_type: "ephemeral", text: formatDraftResults(result) });
  } catch (err) {
    ctx.logError("/jarvis scout draft failed", err, flags);
    await respond({
      response_type: "ephemeral",
      text: `✗ Scout draft failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashAsk(
  text: string,
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: 'Usage: `/jarvis ask "<text>"`',
    });
    return;
  }
  await respond({
    response_type: "ephemeral",
    text: "🤔 Interpreting…",
  });
  try {
    const client = ctx.getAnthropicClient();
    const interpretation = await interpretAsk(trimmed, client);
    if (interpretation.kind === "clarify") {
      await respond({
        response_type: "ephemeral",
        text: `*Need more info:* ${interpretation.question}`,
      });
      return;
    }
    if (interpretation.kind === "refuse") {
      await respond({
        response_type: "ephemeral",
        text: interpretation.reason,
      });
      return;
    }
    // Don't run the command from Slack — show the user what to run.
    // Slack output capture for arbitrary CLI commands is a deeper
    // refactor (commands print to stdout, not return strings); v1
    // shows the resolved command + a one-line explanation so the
    // user can paste it. The CLI flavour does run it directly.
    await respond({
      response_type: "ephemeral",
      text: [
        `*${interpretation.explanation}*`,
        "",
        "```",
        `yarn jarvis ${interpretation.command} ${interpretation.argv.slice(1).join(" ")}`,
        "```",
        "",
        "_Run that in your terminal. Slack output capture for arbitrary commands lands in a follow-up._",
      ].join("\n"),
    });
  } catch (err) {
    ctx.logError("/jarvis ask failed", err, { text: trimmed });
    await respond({
      response_type: "ephemeral",
      text: `✗ Ask failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashIdeasEdit(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
  command: { trigger_id?: string; channel_id?: string; user_id?: string },
  client: BoltApp["client"],
): Promise<void> {
  const rescoreFlag = args.includes("--rescore");
  const queryParts = args.filter((a) => a !== "--rescore");
  const rawQuery = queryParts.join(" ").replace(/["""'']/g, "").trim();

  if (rawQuery.length === 0) {
    await respond({
      response_type: "ephemeral",
      text:
        "Usage: `/jarvis ideas edit <query> [--rescore]` — opens a modal to edit the idea body.\n" +
        "Run `/jarvis ideas list` to see ids.",
    });
    return;
  }

  const file = loadBusinessIdeas(ctx.dataDir);
  const result = findIdeaByQuery(file, rawQuery);

  if (result.kind === "none") {
    await respond({
      response_type: "ephemeral",
      text:
        `No idea found matching \`${rawQuery}\`.\n` +
        "Run `/jarvis ideas list` to see ids.",
    });
    return;
  }

  if (result.kind === "multiple") {
    const lines = [
      `Multiple ideas match \`${rawQuery}\` — narrow your search or use the exact id:`,
      ...result.candidates.map((c, i) => `${i + 1}. \`${c.id}\` — ${c.title}`),
    ];
    await respond({ response_type: "ephemeral", text: lines.join("\n") });
    return;
  }

  const triggerId = command.trigger_id;
  if (!triggerId) {
    await respond({
      response_type: "ephemeral",
      text:
        `Couldn't open modal (no trigger_id). Edit via CLI:\n\`\`\`\nyarn jarvis ideas edit ${result.idea.id}\n\`\`\``,
    });
    return;
  }

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: buildIdeasEditModal({ idea: result.idea, rescoreDefault: rescoreFlag }),
    });
  } catch (err) {
    ctx.logError("opening ideas edit modal failed", err, { ideaId: result.idea.id });
    await respond({
      response_type: "ephemeral",
      text: `✗ Couldn't open modal: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function runSlashIdeasList(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  // Light flag parsing — only --vault for now (currently unused, but accepted
  // so the command shape matches `ideas add` and the future multi-vault model).
  void args;
  const rows = listIdeasWithStatus(ctx.dataDir);
  const body = formatIdeaListing(rows, "slack");
  const header = `:bulb: *Ideas* (${rows.length})`;
  const footer =
    rows.length === 0
      ? ""
      : "\n\n_Run `/jarvis scout score` to score unscored, `/jarvis scout draft` to auto-draft high scorers._";
  await respond({
    response_type: "ephemeral",
    text: `${header}\n\n${body}${footer}`,
  });
}

async function runSlashIdeasAdd(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
  command: { user_id?: string; channel_id?: string },
  client: BoltApp["client"],
): Promise<void> {
  // Light flag parsing — only --vault for now.
  let vault = "personal";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vault" && args[i + 1]) {
      vault = args[i + 1]!;
      i += 1;
    }
  }
  const channel = command.channel_id;
  if (!channel) {
    await respond({
      response_type: "ephemeral",
      text: "Couldn't determine the channel for this thread. Try invoking from a channel rather than a DM.",
    });
    return;
  }
  const userId = command.user_id ?? "<slack>";
  await respond({
    response_type: "ephemeral",
    text: ":bulb: Opening idea-intake thread… reply in the thread to answer.",
  });
  try {
    const result = await startIdeaIntakeConversation({
      ctx: { dataDir: ctx.dataDir, client },
      channel,
      vault,
      invokedBy: userId,
    });
    ctx.log("idea-intake thread opened via slack", {
      userId,
      vault,
      conversationId: result.conversationId,
      threadTs: result.threadTs,
    });
  } catch (err) {
    ctx.logError("/jarvis ideas add failed", err, { userId, vault });
    await respond({
      response_type: "ephemeral",
      text: `✗ Idea intake failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function runSlashDiscuss(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
  command: { user_id?: string; channel_id?: string },
  client: BoltApp["client"],
): Promise<void> {
  const app = args[0];
  const topic = args.slice(1).join(" ").trim();
  if (!app || topic.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: 'Usage: `/jarvis discuss <app> "<topic>"`',
    });
    return;
  }
  const channel = command.channel_id;
  if (!channel) {
    await respond({
      response_type: "ephemeral",
      text: "Couldn't determine the channel for this thread. Try invoking from a channel rather than a DM.",
    });
    return;
  }
  const userId = command.user_id ?? "<slack>";
  await respond({
    response_type: "ephemeral",
    text: `:speech_balloon: Opening discuss thread for *${app}*…`,
  });
  try {
    const slackCtx: SlackDiscussContext = {
      dataDir: ctx.dataDir,
      client,
      anthropic: ctx.getAnthropicClient(),
    };
    const result = await startDiscussConversation({
      ctx: slackCtx,
      channel,
      app,
      vault: "personal",
      topic,
      invokedBy: userId,
    });
    ctx.log("discuss thread opened via slack", {
      app,
      userId,
      conversationId: result.conversationId,
      threadTs: result.threadTs,
    });
  } catch (err) {
    ctx.logError("/jarvis discuss failed", err, { app, userId });
    await respond({
      response_type: "ephemeral",
      text: `✗ Discuss failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

const STATUS_ORDER = [
  "awaiting-review",
  "approved",
  "executing",
  "done",
  "rejected",
  "draft",
];

function formatStatusUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

async function runSlashStatus(
  ctx: HandlerContext,
  respond: SlashRespond,
): Promise<void> {
  try {
    const lines: string[] = [];

    // Daemon liveness
    const pidPath = daemonPidFile(ctx.dataDir);
    const pidData = readPidFile(pidPath);
    if (pidData && defaultIsPidAlive(pidData.pid)) {
      lines.push(`*Daemon:* running (pid ${pidData.pid}, up ${formatStatusUptime(pidData.startedAt)})`);
    } else {
      lines.push("*Daemon:* stopped");
    }

    // Plan counts by status
    const scan = scanPlans(ctx.dataDir);
    const counts = new Map<string, number>();
    for (const r of scan.records) {
      const s = r.plan.metadata.status;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const planParts: string[] = [];
    for (const s of STATUS_ORDER) {
      const n = counts.get(s);
      if (n && n > 0) planParts.push(`${n} ${s}`);
    }
    for (const [s, n] of counts) {
      if (!STATUS_ORDER.includes(s) && n > 0) planParts.push(`${n} ${s}`);
    }
    lines.push(`*Plans:* ${planParts.length > 0 ? planParts.join(", ") : "none"}`);

    // Last 3 plan transitions + last agent call (single readonly connection)
    const dbPath = dbFile(ctx.dataDir);
    interface TransitionRow { created_at: string; payload: string }
    interface AgentCallRow { created_at: string; payload: string }
    const transitions: string[] = [];
    let lastCallStr = "none";

    const db = new Database(dbPath, { readonly: true });
    try {
      const transRows = db
        .prepare(
          "SELECT created_at, payload FROM events WHERE kind = 'plan-transition' ORDER BY id DESC LIMIT 3",
        )
        .all() as TransitionRow[];
      for (const row of transRows) {
        try {
          const p = JSON.parse(row.payload) as { planId?: string; to?: string };
          transitions.push(`${row.created_at} ${p.planId ?? "?"} → ${p.to ?? "?"}`);
        } catch {
          transitions.push(row.created_at);
        }
      }

      const callRow = db
        .prepare(
          "SELECT created_at, payload FROM events WHERE kind = 'agent-call' ORDER BY id DESC LIMIT 1",
        )
        .get() as AgentCallRow | undefined;
      if (callRow) {
        try {
          const p = JSON.parse(callRow.payload) as { agent?: string };
          lastCallStr = `${callRow.created_at} (${p.agent ?? "unknown"})`;
        } catch {
          lastCallStr = callRow.created_at;
        }
      }
    } finally {
      db.close();
    }

    lines.push(`*Last transitions:* ${transitions.length > 0 ? "\n" + transitions.map((t) => `  • ${t}`).join("\n") : "none"}`);
    lines.push(`*Last agent call:* ${lastCallStr}`);

    // Calls today
    const callsToday = readTodayCallCount(dbPath);
    lines.push(`*Calls today:* ${callsToday}`);

    // Record the invocation
    const writeDb = new Database(dbPath);
    try {
      appendEvent(writeDb, {
        appId: "jarvis",
        vaultId: "personal",
        kind: "slack.slash.status",
        payload: {},
      });
    } finally {
      writeDb.close();
    }

    await respond({ response_type: "ephemeral", text: lines.join("\n") });
  } catch (err) {
    ctx.logError("/jarvis status failed", err);
    await respond({
      response_type: "ephemeral",
      text: `✗ Status failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function runSlashNotes(
  args: string[],
  ctx: HandlerContext,
  respond: SlashRespond,
  command: { user_id?: string },
): Promise<void> {
  const app = args[0];
  const text = args.slice(1).join(" ").trim();
  if (!app || text.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/jarvis notes <app> <text>` (vault defaults to `personal`)",
    });
    return;
  }
  const userId = command.user_id ?? "<slack>";
  try {
    appendNote(ctx.dataDir, "personal", app, {
      text,
      actor: `slack:${userId}`,
    });
    ctx.log("note appended via slack", { app, userId, len: text.length });
    await respond({
      response_type: "ephemeral",
      text: `📝 Note appended to *${app}* — Strategist / Scout / Developer will read this in their next context.`,
    });
  } catch (err) {
    ctx.logError("/jarvis notes failed", err, { app });
    await respond({
      response_type: "ephemeral",
      text: `✗ Note append failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
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

/**
 * Strip the action buttons from a setup-task message and append a
 * resolution context line. Used after the user clicks Mark done so
 * the same message visually closes itself.
 */
async function closeSetupTaskMessage(
  client: BoltApp["client"] | undefined,
  body: unknown,
  outcomeText: string,
): Promise<void> {
  if (!client) return;
  const b = body as {
    type?: string;
    message?: { ts?: string; blocks?: Array<{ type?: string }> };
    channel?: { id?: string };
  };
  if (b.type !== "block_actions" || !b.message?.ts || !b.channel?.id) return;
  const trimmed = (b.message.blocks ?? []).filter(
    (block) => block.type !== "actions",
  );
  try {
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      blocks: [
        ...trimmed,
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: outcomeText }],
        },
      ] as never,
      text: outcomeText,
    });
  } catch {
    // best-effort
  }
}

/**
 * After a discuss Accept / Drop click, strip the action row from the
 * proposal message + append an outcome context line so the message
 * visually closes. Same shape as closeSetupTaskMessage; kept as a
 * separate function so the two can diverge later if needed.
 */
async function stripDiscussButtons(
  client: BoltApp["client"] | undefined,
  body: unknown,
  outcomeText: string,
): Promise<void> {
  if (!client) return;
  const b = body as {
    type?: string;
    message?: { ts?: string; blocks?: Array<{ type?: string }> };
    channel?: { id?: string };
  };
  if (b.type !== "block_actions" || !b.message?.ts || !b.channel?.id) return;
  const trimmed = (b.message.blocks ?? []).filter(
    (block) => block.type !== "actions",
  );
  try {
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      blocks: [
        ...trimmed,
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: outcomeText }],
        },
      ] as never,
      text: outcomeText,
    });
  } catch {
    // best-effort
  }
}
