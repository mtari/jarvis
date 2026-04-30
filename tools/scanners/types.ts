/**
 * Phase 2 Analyst — signal collector framework.
 *
 * A "signal" is an observation about an app's repo that might warrant
 * action (a new improvement plan, an alert, a reprioritisation). Signals
 * are produced by short-lived collectors that scan a single repo and
 * return a list of observations. Analyst aggregates signals across apps
 * and decides what to do with them (auto-draft a plan, escalate, etc.).
 *
 * For now (this PR) we only define the contract + write signals to the
 * event log so the user can review them via `yarn jarvis scan`. The
 * Strategist auto-draft hand-off and the daemon-driven hourly tick land
 * in follow-up plans. See MASTER_PLAN.md §6, §13.
 */

export type SignalSeverity = "low" | "medium" | "high" | "critical";

export interface Signal {
  /**
   * Stable identifier of the producing collector — also matches the
   * filename in `tools/scanners/<kind>.ts`. Used for dedup, suppression
   * keys, and per-collector circuit-breaker accounting (Phase 2.5).
   */
  kind: string;
  severity: SignalSeverity;
  /**
   * Short, human-readable headline. Goes into Slack escalation summaries
   * and the `agent-call` audit log. ≤120 chars by convention.
   */
  summary: string;
  /**
   * Optional structured detail — collector-specific JSON. Anything the
   * Strategist (or a future filter) might use to decide whether to draft
   * a plan, plus enough context for a human reader.
   */
  details?: Record<string, unknown>;
  /**
   * A stable key that groups the same underlying observation across runs
   * (e.g., `yarn-audit:CVE-2026-1234`). Used by the suppressions table
   * (Phase 2.5) and to avoid duplicate plans on a recurring signal.
   */
  dedupKey?: string;
}

export interface CollectorContext {
  /**
   * Absolute path to the repo (or monorepo subdirectory) the collector
   * should scan. Matches the `cwd` Developer uses, so collectors can
   * reuse the same tool conventions.
   */
  cwd: string;
  /** App id from the brain. Goes onto recorded signal events. */
  app: string;
}

/**
 * A signal collector. One instance per kind. Implementations live under
 * `tools/scanners/` and export a `default` instance.
 *
 * Collectors are short-lived: each `collect()` call runs one scan and
 * returns. Long-running collectors (e.g., file watchers) are out of scope
 * for the Phase 2 entry — re-shape later if/when needed.
 */
export interface SignalCollector {
  /** Collector kind — matches the filename in `tools/scanners/<kind>.ts`. */
  kind: string;
  /** Human-readable name shown in the `yarn jarvis scan` output. */
  description: string;
  /**
   * Run the collector against the given app's repo. Should be idempotent
   * and side-effect-free beyond the temp files / network calls implied
   * by the scan itself.
   *
   * Implementations should swallow non-fatal errors and return a signal
   * with `severity: "low"` describing the failure rather than throwing.
   * Throw only on programming bugs.
   */
  collect(ctx: CollectorContext): Promise<Signal[]>;
}
