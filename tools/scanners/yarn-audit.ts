import { spawn } from "node:child_process";
import type {
  CollectorContext,
  Signal,
  SignalCollector,
} from "./types.ts";

/**
 * Yarn audit collector. Runs `yarn audit --json` in the app's cwd, parses
 * the NDJSON output (yarn writes one JSON document per line — an `auditAdvisory`
 * envelope per finding plus a final `auditSummary`), and emits one signal per
 * advisory with severity mapped from the npm severity string.
 *
 * The collector is robust to non-zero exit codes: yarn audit exits non-zero
 * when vulnerabilities are found (that's the *expected* path), so we ignore
 * the exit code and rely on the JSON envelopes. Network/binary failures
 * surface as a single `low` signal so the run never crashes the daemon.
 */
const yarnAuditCollector: SignalCollector = {
  kind: "yarn-audit",
  description: "Scans installed dependencies for known vulnerabilities (yarn audit).",
  async collect(ctx: CollectorContext): Promise<Signal[]> {
    const { exitCode, stdout, stderr, error, timedOut } = await runYarnAudit(
      ctx.cwd,
    );

    if (error) {
      return [
        {
          kind: "yarn-audit",
          severity: "low",
          summary: `yarn audit failed to run: ${error}`,
          ...(timedOut !== undefined && { details: { timedOut } }),
        },
      ];
    }

    const signals: Signal[] = [];
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const advisory = extractAdvisory(parsed);
      if (advisory === null) continue;
      signals.push(advisoryToSignal(advisory));
    }

    if (signals.length === 0 && exitCode !== 0) {
      // Non-zero exit but no parsed advisories — note the stderr for
      // debugging without crashing.
      signals.push({
        kind: "yarn-audit",
        severity: "low",
        summary: `yarn audit exited ${exitCode} without parseable advisories`,
        details: { stderrTail: stderr.slice(-500) },
      });
    }

    return signals;
  },
};

export default yarnAuditCollector;

// ---------------------------------------------------------------------------
// Internals — exported for unit tests.
// ---------------------------------------------------------------------------

interface AuditAdvisory {
  module_name: string;
  severity: string; // npm severity string
  title: string;
  url?: string;
  cves?: string[];
  vulnerable_versions?: string;
  patched_versions?: string;
}

/** Pulls the advisory body from one yarn-audit NDJSON envelope, or returns null. */
export function extractAdvisory(raw: unknown): AuditAdvisory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  // Modern yarn: `{ type: "auditAdvisory", data: { advisory: {...} } }`
  if (obj["type"] === "auditAdvisory") {
    const data = obj["data"] as Record<string, unknown> | undefined;
    const advisory = data?.["advisory"] as Record<string, unknown> | undefined;
    if (advisory && typeof advisory["title"] === "string") {
      return advisory as unknown as AuditAdvisory;
    }
  }
  return null;
}

/** Maps an npm severity to our SignalSeverity. */
function mapSeverity(npm: string): Signal["severity"] {
  switch (npm.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

/** Builds a Signal from one advisory. */
export function advisoryToSignal(a: AuditAdvisory): Signal {
  const cves = a.cves && a.cves.length > 0 ? a.cves[0] : undefined;
  const dedupKey = cves
    ? `yarn-audit:${cves}`
    : `yarn-audit:${a.module_name}:${a.title}`;
  return {
    kind: "yarn-audit",
    severity: mapSeverity(a.severity),
    summary: `${a.severity} advisory in ${a.module_name}: ${a.title}`,
    details: {
      module: a.module_name,
      severity: a.severity,
      title: a.title,
      ...(a.url !== undefined && { url: a.url }),
      ...(a.cves !== undefined && a.cves.length > 0 && { cves: a.cves }),
      ...(a.vulnerable_versions !== undefined && {
        vulnerable: a.vulnerable_versions,
      }),
      ...(a.patched_versions !== undefined && {
        patched: a.patched_versions,
      }),
    },
    dedupKey,
  };
}

// ---------------------------------------------------------------------------
// Subprocess wrapper. Exported as the test seam.
// ---------------------------------------------------------------------------

export interface YarnAuditResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SIGKILL_GRACE_MS = 2_000;

export async function runYarnAudit(
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<YarnAuditResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("yarn", ["audit", "--json"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const sigtermTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      const sigkillTimer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }, timeoutMs);
    sigtermTimer.unref();

    proc.on("error", (err) => {
      clearTimeout(sigtermTimer);
      resolve({
        exitCode: -1,
        stdout,
        stderr,
        error: err.message,
        ...(timedOut && { timedOut: true }),
      });
    });

    proc.on("close", (code) => {
      clearTimeout(sigtermTimer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        ...(timedOut && { timedOut: true }),
      });
    });
  });
}
