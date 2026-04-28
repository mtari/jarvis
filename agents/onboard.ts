import fs from "node:fs";
import path from "node:path";
import type { AnthropicClient } from "../orchestrator/anthropic-client.ts";
import {
  brainSchema,
  type BrainInput,
} from "../orchestrator/brain.ts";
import { runAgentLoop, type AgentToolCall } from "../orchestrator/tool-loop.ts";
import { repoRoot as defaultRepoRoot } from "../cli/paths.ts";
import { createDeveloperTools } from "../tools/developer-tools.ts";

export class OnboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardError";
  }
}

export interface AbsorbedDoc {
  source: string;
  /** Doc body inlined into the user message for Strategist to absorb. */
  content: string;
}

export interface CachedDocSummary {
  /** Doc id used in docs.json (slug). */
  id: string;
  source: string;
  /** Short user-supplied or fetched summary; the agent doesn't re-extract. */
  summary?: string;
}

export interface OnboardAgentInput {
  client: AnthropicClient;
  /** Project name from --app. The brain uses this verbatim as projectName. */
  app: string;
  /** Absolute path to the repo (or monorepo subdirectory) Strategist inspects. */
  repoRoot: string;
  absorbedDocs: ReadonlyArray<AbsorbedDoc>;
  cachedDocs: ReadonlyArray<CachedDocSummary>;
  maxIterations?: number;
  onToolCall?: (call: AgentToolCall) => void;
}

export interface OnboardAgentResult {
  brain: BrainInput;
  iterations: number;
}

const PROMPT_PATH = "prompts/strategist-onboard.md";

let cachedPrompt: string | null = null;
function loadOnboardPrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(defaultRepoRoot(), PROMPT_PATH),
    "utf8",
  );
  return cachedPrompt;
}

function buildOnboardContext(input: OnboardAgentInput): string {
  const lines: string[] = [];
  lines.push(`Project app id: ${input.app}`);
  lines.push(`Repo root: ${input.repoRoot}`);
  lines.push("");
  lines.push("Inspect the repo via read_file and list_dir, then emit the brain JSON.");
  if (input.absorbedDocs.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("ABSORBED DOCS (extract project-scoped content into the brain):");
    for (const doc of input.absorbedDocs) {
      lines.push("");
      lines.push(`<doc source="${doc.source}">`);
      lines.push(doc.content);
      lines.push(`</doc>`);
    }
  }
  if (input.cachedDocs.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("CACHED DOCS (kept on disk; do not re-extract — listed for awareness only):");
    for (const doc of input.cachedDocs) {
      lines.push(
        `- ${doc.id} — ${doc.source}${doc.summary ? `: ${doc.summary}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Runs Strategist in onboard mode. Inspects the repo via read-only tools,
 * absorbs any provided docs, returns a parsed-and-validated brain ready to
 * persist.
 */
export async function runOnboardAgent(
  input: OnboardAgentInput,
): Promise<OnboardAgentResult> {
  if (!path.isAbsolute(input.repoRoot)) {
    throw new OnboardError(
      `repoRoot must be absolute, got "${input.repoRoot}"`,
    );
  }
  if (!fs.existsSync(input.repoRoot)) {
    throw new OnboardError(`repoRoot does not exist: ${input.repoRoot}`);
  }

  const tools = createDeveloperTools({ repoRoot: input.repoRoot });
  const readOnly = {
    read_file: tools.read_file,
    list_dir: tools.list_dir,
  };

  const result = await runAgentLoop({
    client: input.client,
    system: loadOnboardPrompt(),
    cacheSystem: true,
    initialMessages: [{ role: "user", content: buildOnboardContext(input) }],
    tools: readOnly,
    ...(input.maxIterations !== undefined && {
      maxIterations: input.maxIterations,
    }),
    ...(input.onToolCall !== undefined && { onToolCall: input.onToolCall }),
  });

  const brainMatch = result.finalText.match(/<brain>([\s\S]*?)<\/brain>/);
  if (!brainMatch || !brainMatch[1]) {
    throw new OnboardError(
      "Strategist's response had no <brain> block. First 200 chars: " +
        result.finalText.slice(0, 200),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(brainMatch[1].trim());
  } catch (err) {
    throw new OnboardError(
      `<brain> contained invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Force projectName to match --app; Strategist sometimes paraphrases.
  if (parsed && typeof parsed === "object") {
    (parsed as Record<string, unknown>)["projectName"] = input.app;
  }

  let brain: BrainInput;
  try {
    brain = brainSchema.parse(parsed);
  } catch (err) {
    throw new OnboardError(
      `brain JSON failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { brain, iterations: result.iterations };
}
