// Sandbox-pattern tool I/O helpers.
//
// Per MASTER_PLAN.md §7 ("Sandbox-pattern tool I/O") and §13 (Safety rules):
// every Jarvis tool that can produce bulk output saves the raw bytes under
// jarvis-data/sandbox/ and returns only a summary + sandbox path to the
// calling agent. Follow-up narrow tools (extract / grep / count / slice)
// pull specifics on demand.
//
// Phase 0 deliberately defers the implementation. Phase 0's only outbound
// tools are file reads, the GitHub API, and git — none produce bulk output
// large enough to warrant the dance. M3 leaves this file as a typed
// placeholder so the §15 layout matches the doc and so Phase 1 has a clear
// landing spot when scanners (yarn audit, lighthouse, broken-links, axe)
// come online.

export interface SandboxedToolResult {
  /** Short human-readable headline (e.g., "audit found 3 high-severity issues"). */
  headline: string;
  /** Path under jarvis-data/sandbox/<plan-or-step-id>/ where raw output lives. */
  sandboxPath: string;
}

export function notImplemented(): never {
  throw new Error(
    "Sandbox-pattern helpers land in Phase 1 (see orchestrator/sandbox.ts header).",
  );
}
