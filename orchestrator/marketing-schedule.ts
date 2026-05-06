import type { DayOfWeek, ScheduleRule } from "./brain.ts";

/**
 * Resolves a content-calendar entry's `Date:` to a concrete UTC ISO
 * datetime, consulting the app's `marketing.scheduleRules.default`.
 *
 * v1 algorithm:
 *   1. Push past disallowed weekdays (per `allowedDays`).
 *   2. Push past blackout dates (per `blackoutDates`).
 *   3. Apply `preferredHours[0]` as the time-of-day in `timezone`.
 *   4. Convert to UTC.
 *
 * Cross-post coordination (`timesPerDay`, `minSpacingMinutes`) is
 * deferred — the resolver places each entry independently.
 *
 * Pure: no I/O. Tests cover every path; production callers use the
 * `resolveScheduledAt` helper below.
 */

export const DAY_INDEX: Record<DayOfWeek, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_NAME: ReadonlyArray<DayOfWeek> = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** Default time-of-day applied when no scheduleRule is configured. UTC. */
export const DEFAULT_FALLBACK_TIME_UTC = "09:00:00.000Z";

export class MarketingScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingScheduleError";
  }
}

export interface ResolveScheduledAtInput {
  /** ISO date string (YYYY-MM-DD) from the content-calendar entry. */
  date: string;
  /** Brain's per-app schedule rule. Undefined → fallback to 09:00 UTC. */
  rule?: ScheduleRule;
  /**
   * Hard cap on day-pushes when honoring allowedDays / blackoutDates.
   * Defaults to 14 (two weeks). The resolver throws if it can't find
   * a valid day within this many tries — protects against
   * misconfigured rules that would otherwise loop forever (e.g.
   * `allowedDays: []`).
   */
  maxPushDays?: number;
}

export interface ResolveScheduledAtResult {
  /** Final UTC ISO datetime to write into `scheduled_posts.scheduled_at`. */
  scheduledAt: string;
  /** Number of days pushed from the original date (0 when no push needed). */
  pushedByDays: number;
  /** Reason for the push, when pushedByDays > 0. */
  pushReason?: "disallowed-day" | "blackout-date";
}

/**
 * Pure schedule resolver. See module doc for the algorithm.
 */
export function resolveScheduledAt(
  input: ResolveScheduledAtInput,
): ResolveScheduledAtResult {
  const maxPushDays = input.maxPushDays ?? 14;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new MarketingScheduleError(
      `Date must be ISO YYYY-MM-DD, got "${input.date}"`,
    );
  }

  // No rule → original date + fixed 09:00 UTC fallback. Same default
  // the marketer used before this slice — preserves back-compat for
  // apps that don't opt into scheduleRules.
  if (!input.rule) {
    return {
      scheduledAt: `${input.date}T${DEFAULT_FALLBACK_TIME_UTC}`,
      pushedByDays: 0,
    };
  }

  const allowedSet = input.rule.allowedDays
    ? new Set(input.rule.allowedDays)
    : null; // null = all days allowed
  const blackoutSet = new Set(input.rule.blackoutDates ?? []);

  let candidate = input.date;
  let pushedByDays = 0;
  let pushReason: ResolveScheduledAtResult["pushReason"];
  while (pushedByDays <= maxPushDays) {
    const day = dayOfWeekFromIsoDate(candidate);
    const dayDisallowed = allowedSet !== null && !allowedSet.has(day);
    const dateBlackedOut = blackoutSet.has(candidate);
    if (!dayDisallowed && !dateBlackedOut) break;
    pushReason = dayDisallowed ? "disallowed-day" : "blackout-date";
    candidate = addDays(candidate, 1);
    pushedByDays += 1;
  }
  if (pushedByDays > maxPushDays) {
    throw new MarketingScheduleError(
      `Couldn't find an allowed day within ${maxPushDays} of "${input.date}" — check allowedDays / blackoutDates`,
    );
  }

  const time = input.rule.preferredHours[0];
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    throw new MarketingScheduleError(
      `preferredHours[0] must be HH:MM, got "${time}"`,
    );
  }
  const scheduledAt = toUtcIso(candidate, time, input.rule.timezone);
  return {
    scheduledAt,
    pushedByDays,
    ...(pushedByDays > 0 && pushReason !== undefined && { pushReason }),
  };
}

// ---------------------------------------------------------------------------
// Date helpers — pure, no Date library
// ---------------------------------------------------------------------------

function dayOfWeekFromIsoDate(iso: string): DayOfWeek {
  // Treat as UTC midnight to avoid local-tz drift in `getDay`. The
  // weekday classification is timezone-aware via the rule's timezone
  // field — but for "what day of the week is YYYY-MM-DD locally,"
  // the local date IS the date the user typed.
  const d = new Date(`${iso}T00:00:00.000Z`);
  const idx = d.getUTCDay();
  const name = DAY_NAME[idx];
  if (!name) {
    throw new MarketingScheduleError(`unexpected day index ${idx}`);
  }
  return name;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Computes the UTC instant for a wall-clock `(date, time)` in the
 * given IANA timezone.
 *
 * Approach: parse the literal string as UTC first, then ask `Intl`
 * what UTC moment renders to that wall-clock in the target timezone,
 * and adjust by the discovered offset. Handles DST automatically
 * because `Intl.DateTimeFormat` uses live tz database rules.
 */
function toUtcIso(date: string, time: string, timezone: string): string {
  // Naive: pretend the wall-clock is already UTC.
  const naive = new Date(`${date}T${time}:00.000Z`);

  // Compute the offset between the target tz and UTC at the naive moment.
  let parts: Array<{ type: string; value: string }>;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    parts = formatter.formatToParts(naive);
  } catch (err) {
    throw new MarketingScheduleError(
      `unknown timezone "${timezone}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const tzWall = partsToDate(parts);
  // tzWall represents what time it IS in the target zone when UTC is
  // `naive`. The difference between naive and tzWall is the negative of
  // the zone's offset. To compute the UTC moment that *renders to*
  // `(date, time)` in the target zone, we add (naive - tzWall) twice
  // — once because we need the offset, again because we want the
  // opposite direction. Equivalent: utc = naive + (naive - tzWall).
  const offsetMs = naive.getTime() - tzWall.getTime();
  const utc = new Date(naive.getTime() + offsetMs);
  return utc.toISOString();
}

function partsToDate(parts: Array<{ type: string; value: string }>): Date {
  const get = (t: string): number => {
    const part = parts.find((p) => p.type === t);
    if (!part) {
      throw new MarketingScheduleError(`Intl missing field "${t}"`);
    }
    return Number.parseInt(part.value, 10);
  };
  // `Intl` "hour: 2-digit hour12: false" returns 24 for midnight in
  // some locales — clamp.
  const hour = get("hour") % 24;
  return new Date(
    Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      hour,
      get("minute"),
      get("second"),
    ),
  );
}
