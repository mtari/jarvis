import Database from "better-sqlite3";
import { appendEvent } from "./event-log.ts";
import type { SignalSeverity } from "../tools/scanners/types.ts";

/**
 * Runtime escalations are events the user needs to know about NOW —
 * rate-limit hits, cash-in violations, missing-secret blocks, daemon
 * service crashes. Today these only land in the daemon log file
 * (`ctx.logger.error(...)`); slice 6 of the Slack-primary buildout
 * surfaces them in `#jarvis-alerts` with an Acknowledge button.
 *
 * Producers (plan-executor, daemon services, install path) call
 * `recordEscalation` from their existing error branches. The Slack
 * delivery tick reads the `escalation` events and posts unposted ones.
 *
 * Severity reuses the SignalSeverity scale so the alert channel
 * has a consistent visual vocabulary across signal alerts and
 * escalations.
 */

export interface RecordEscalationInput {
  /** Producer-supplied tag, e.g. `rate-limit`, `cash-in-violation`, `service-error`. */
  kind: string;
  severity: SignalSeverity;
  /** One-line summary for headers + previews. */
  summary: string;
  /** Optional multi-line body (stack trace, decision context, etc.). */
  detail?: string;
  /** When the escalation is scoped to a specific plan. */
  planId?: string;
  /** When the escalation is scoped to a specific app. */
  app?: string;
  /** Defaults to `personal`. */
  vault?: string;
}

/**
 * Records an `escalation` event in the SQLite log. Idempotency is the
 * caller's responsibility — recordEscalation will happily write
 * duplicates if called repeatedly with the same payload, by design,
 * since "five rate limits in a row" is itself information.
 *
 * The Slack delivery tick dedups on event id, so a single escalation
 * post per record.
 */
export function recordEscalation(
  dbFilePath: string,
  input: RecordEscalationInput,
): void {
  const db = new Database(dbFilePath);
  try {
    appendEvent(db, {
      appId: input.app ?? "jarvis",
      vaultId: input.vault ?? "personal",
      kind: "escalation",
      payload: {
        kind: input.kind,
        severity: input.severity,
        summary: input.summary,
        ...(input.detail !== undefined && { detail: input.detail }),
        ...(input.planId !== undefined && { planId: input.planId }),
        ...(input.app !== undefined && { app: input.app }),
      },
    });
  } finally {
    db.close();
  }
}
