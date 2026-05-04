import fs from "node:fs";
import path from "node:path";
import {
  buildTriageReport,
  formatMarkdown,
} from "../../cli/commands/triage.ts";
import { triageDir } from "../../cli/paths.ts";
import type { DaemonContext, DaemonService } from "../../cli/commands/daemon.ts";

/**
 * Phase 2 exit deliverable, automated. Once a week (default Monday 09:00
 * local time), the daemon writes a triage markdown report to
 * `<dataDir>/triage/<YYYY-MM-DD>.md`. The user reads it Monday morning;
 * the file's existence guards against double-firing within the same day.
 *
 * Implementation: poll once per `tickMs` (default 1 hour). Each tick
 * checks (current weekday matches `dayOfWeek`) AND (current hour ≥
 * `hour`) AND (no report written today). If all three hold, build the
 * report and write the file. Cheap — most ticks no-op.
 *
 * Mirrors the analyst-service pattern: `tickInFlight` guard, `_tickBody`
 * test seam, error-isolated try/catch so a thrown report-build never
 * stalls the service.
 */

export interface TriageServiceOptions {
  dataDir: string;
  /**
   * Day of week to fire on. 0 = Sunday, 1 = Monday, ... 6 = Saturday.
   * Default 1 (Monday).
   */
  dayOfWeek?: number;
  /** Hour of day (0–23, local time) to fire at or after. Default 9. */
  hour?: number;
  /** Polling interval. Default 1 hour. */
  tickMs?: number;
  /** Window length for the report's signal section. Default 7 days. */
  windowDays?: number;
  /** Override "now" for deterministic tests. Production uses real wall clock. */
  now?: () => Date;
  /**
   * Override the tick body for testing — replaces the per-tick logic
   * with a custom function.
   *
   * @internal — not part of the public API.
   */
  _tickBody?: (ctx: DaemonContext) => Promise<void>;
}

const DEFAULT_DAY_OF_WEEK = 1; // Monday
const DEFAULT_HOUR = 9;
const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_WINDOW_DAYS = 7;

export function createTriageService(
  opts: TriageServiceOptions,
): DaemonService {
  let timer: NodeJS.Timeout | null = null;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const dayOfWeek = opts.dayOfWeek ?? DEFAULT_DAY_OF_WEEK;
  const hour = opts.hour ?? DEFAULT_HOUR;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? ((): Date => new Date());

  let tickInFlight = false;

  return {
    name: "triage",
    start(ctx: DaemonContext): void {
      const tickFn = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
          if (opts._tickBody !== undefined) {
            await opts._tickBody(ctx);
            return;
          }
          runTriageTickIfDue({
            dataDir: opts.dataDir,
            dayOfWeek,
            hour,
            windowDays,
            now: now(),
            ctx,
          });
        } catch (err) {
          ctx.logger.error(
            "triage tick errored",
            err instanceof Error ? err : new Error(String(err)),
          );
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

export interface TriageTickInput {
  dataDir: string;
  dayOfWeek: number;
  hour: number;
  windowDays: number;
  now: Date;
  ctx: DaemonContext;
}

export interface TriageTickResult {
  fired: boolean;
  /** Reason a tick was skipped — useful for tests + the daemon log. */
  skipReason?: "wrong-day" | "before-hour" | "already-fired-today";
  /** Path of the written markdown when `fired`. */
  outputPath?: string;
}

/**
 * Single tick of the triage scheduler. Exported for direct testing — the
 * test seams (`now` + a stub `dataDir`) make it easier to verify gating
 * behavior than going through `setInterval`.
 */
export function runTriageTickIfDue(
  input: TriageTickInput,
): TriageTickResult {
  if (input.now.getDay() !== input.dayOfWeek) {
    return { fired: false, skipReason: "wrong-day" };
  }
  if (input.now.getHours() < input.hour) {
    return { fired: false, skipReason: "before-hour" };
  }

  const dir = triageDir(input.dataDir);
  const outputPath = path.join(dir, `${formatLocalDate(input.now)}.md`);
  if (fs.existsSync(outputPath)) {
    return { fired: false, skipReason: "already-fired-today" };
  }

  const report = buildTriageReport({
    dataDir: input.dataDir,
    now: input.now,
    windowDays: input.windowDays,
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, formatMarkdown(report), "utf8");

  input.ctx.logger.info("triage: wrote weekly report", {
    path: outputPath,
    criticalSignals: report.criticalSignals.length,
    pendingReviews: report.pendingReviews.length,
    stuckPlans: report.stuckPlans.length,
  });

  return { fired: true, outputPath };
}

/** YYYY-MM-DD in local time. */
function formatLocalDate(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
