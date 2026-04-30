import Database from "better-sqlite3";
import { appendEvent } from "../orchestrator/event-log.ts";
import { dbFile } from "../cli/paths.ts";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
} from "../tools/scanners/types.ts";

/**
 * Runs the given collectors against an app's repo and records each signal
 * as a `signal` event in the SQLite event log. Returns the flat list of
 * signals so callers (CLI, daemon) can decide what to do next.
 *
 * Signals are recorded in the same transaction so a partial DB write
 * never leaves a half-recorded scan. If a collector throws (programming
 * bug — collectors are supposed to swallow runtime errors and return a
 * `low` signal instead), the error propagates and no signals are
 * recorded for that scan.
 *
 * For the Phase 2 entry, Analyst's job ends here: record signals + return
 * them. The Strategist hand-off ("auto-draft a plan when N high signals
 * land in 24h") and the suppressions filter land in subsequent plans.
 */
export interface AnalystScanInput {
  dataDir: string;
  app: string;
  vault: string;
  ctx: CollectorContext;
  collectors: ReadonlyArray<SignalCollector>;
}

export interface AnalystScanResult {
  signals: Signal[];
  /** Per-collector summary for the CLI output. */
  byCollector: Array<{
    kind: string;
    description: string;
    signalCount: number;
    durationMs: number;
    error?: string;
  }>;
}

export async function runAnalystScan(
  input: AnalystScanInput,
): Promise<AnalystScanResult> {
  const allSignals: Signal[] = [];
  const byCollector: AnalystScanResult["byCollector"] = [];

  for (const collector of input.collectors) {
    const start = Date.now();
    let signals: Signal[] = [];
    let errorMsg: string | undefined;
    try {
      signals = await collector.collect(input.ctx);
    } catch (err) {
      // Programming bug — note it and keep going. Collectors are
      // supposed to convert runtime failures into low-severity signals.
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - start;
    allSignals.push(...signals);
    byCollector.push({
      kind: collector.kind,
      description: collector.description,
      signalCount: signals.length,
      durationMs,
      ...(errorMsg !== undefined && { error: errorMsg }),
    });
  }

  // Record all signals in one DB transaction.
  if (allSignals.length > 0) {
    const db = new Database(dbFile(input.dataDir));
    try {
      db.transaction(() => {
        for (const s of allSignals) {
          appendEvent(db, {
            appId: input.app,
            vaultId: input.vault,
            kind: "signal",
            payload: {
              kind: s.kind,
              severity: s.severity,
              summary: s.summary,
              ...(s.details !== undefined && { details: s.details }),
              ...(s.dedupKey !== undefined && { dedupKey: s.dedupKey }),
            },
          });
        }
      })();
    } finally {
      db.close();
    }
  }

  return { signals: allSignals, byCollector };
}
