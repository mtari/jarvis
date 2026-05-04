import { parseArgs } from "node:util";
import {
  isSuppressed,
  listSuppressions,
  suppress,
  unsuppress,
} from "../../orchestrator/suppressions.ts";
import { dbFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis suppress <pattern-id> [--reason "..."] [--expires <iso>]`
 *
 * Mutes auto-drafting for a signal pattern. The pattern-id is what shows
 * up as `dedupKey` on signal events (e.g. `yarn-audit:CVE-2026-X`).
 * Existing rows are refreshed (the soft-delete is reset).
 */
export async function runSuppress(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        reason: { type: "string" },
        expires: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`suppress: ${(err as Error).message}`);
    return 1;
  }

  const patternId = parsed.positionals[0];
  if (!patternId) {
    console.error(
      'suppress: pattern-id required. Usage: yarn jarvis suppress <pattern-id> [--reason "..."] [--expires <iso>]',
    );
    return 1;
  }

  const expires = parsed.values.expires;
  if (expires !== undefined) {
    const parsedDate = new Date(expires);
    if (Number.isNaN(parsedDate.getTime())) {
      console.error(
        `suppress: invalid --expires "${expires}" (expected ISO datetime, e.g. 2026-12-31T00:00:00Z)`,
      );
      return 1;
    }
  }

  const dataDir = getDataDir();
  suppress(dbFile(dataDir), {
    patternId,
    pattern: parsed.values.reason ?? patternId,
    ...(parsed.values.reason !== undefined && { reason: parsed.values.reason }),
    ...(expires !== undefined && { expiresAt: new Date(expires).toISOString() }),
  });
  console.log(`✓ Suppressed pattern: ${patternId}`);
  if (expires !== undefined) {
    console.log(`  Expires: ${new Date(expires).toISOString()}`);
  }
  return 0;
}

/**
 * `yarn jarvis unsuppress <pattern-id>` — clears an active suppression.
 * Soft-delete; the row stays for audit. Re-suppress to re-mute.
 */
export async function runUnsuppress(rawArgs: string[]): Promise<number> {
  const [patternId, ...rest] = rawArgs;
  if (!patternId) {
    console.error(
      "unsuppress: pattern-id required. Usage: yarn jarvis unsuppress <pattern-id>",
    );
    return 1;
  }
  if (rest.length > 0) {
    console.error(
      `unsuppress: unexpected extra arguments: ${rest.join(" ")}`,
    );
    return 1;
  }
  const dataDir = getDataDir();
  if (!isSuppressed(dbFile(dataDir), patternId)) {
    console.error(`unsuppress: no active suppression for "${patternId}"`);
    return 1;
  }
  const cleared = unsuppress(dbFile(dataDir), patternId);
  if (!cleared) {
    console.error(`unsuppress: no active suppression for "${patternId}"`);
    return 1;
  }
  console.log(`✓ Cleared suppression: ${patternId}`);
  return 0;
}

/**
 * `yarn jarvis suppressions [--all]` — lists active suppressions, or all
 * including soft-deleted ones with --all.
 */
export async function runSuppressions(rawArgs: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        all: { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`suppressions: ${(err as Error).message}`);
    return 1;
  }

  const dataDir = getDataDir();
  const includeCleared = parsed.values.all === true;
  const rows = listSuppressions(dbFile(dataDir), { includeCleared });

  if (rows.length === 0) {
    console.log(
      includeCleared
        ? "No suppressions on record."
        : "No active suppressions. Pass --all to include cleared rows.",
    );
    return 0;
  }

  for (const r of rows) {
    const status = r.clearedAt ? "cleared" : r.expiresAt ? "expires" : "active";
    const expiry = r.expiresAt
      ? ` (expires ${r.expiresAt})`
      : r.clearedAt
        ? ` (cleared ${r.clearedAt})`
        : "";
    console.log(`  [${status.padEnd(7)}] ${r.patternId}${expiry}`);
    if (r.reason) {
      console.log(`            ${r.reason}`);
    }
  }
  return 0;
}
