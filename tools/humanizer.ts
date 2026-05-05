import fs from "node:fs";
import path from "node:path";
import type { AnthropicClient } from "../orchestrator/agent-sdk-runtime.ts";
import { repoRoot } from "../cli/paths.ts";

/**
 * Humanizer — final pass on user-facing text.
 *
 * Per §13 of MASTER_PLAN: any text destined for an external audience
 * (social posts, campaign copy, app marketing content, blog) runs
 * through this tool before publication or PR. Marketer calls it on
 * every post draft; Developer calls it when a plan modifies user-
 * facing text.
 *
 * Implementation: a single Claude call with `prompts/humanizer.md` as
 * the system prompt. The prompt enforces a `<humanized>` + `<changes>`
 * block protocol; this module parses it. Failures (parse errors,
 * empty output, model can't decide) raise `HumanizerError`.
 *
 * Exempt per §13: plans, amendments, PR descriptions, commit
 * messages, code comments, internal logs, Slack messages to the
 * user. Callers know what they own — this module doesn't filter
 * the input by category.
 */

export interface HumanizeInput {
  /** Free-text draft to clean up. */
  text: string;
  /**
   * Optional context tag passed to the model (e.g. "social-post",
   * "blog", "campaign", "marketing-app-copy"). Lets the model adjust
   * register expectations slightly. Free-form; not enforced by the
   * prompt.
   */
  context?: string;
}

export interface HumanizeResult {
  /** The rewritten (or unchanged) text. */
  text: string;
  /**
   * Human-readable change descriptions, one per distinct edit.
   * Empty when nothing was rewritten.
   */
  changes: string[];
  /** True when the model returned `(none)` or no changes — input passed clean. */
  unchanged: boolean;
  /** Bytes saved by the rewrite (input.length − output.length). May be negative. */
  bytesDelta: number;
}

export class HumanizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanizerError";
  }
}

export interface HumanizeDeps {
  client: AnthropicClient;
}

const EMPTY_INPUT_RESULT: HumanizeResult = {
  text: "",
  changes: [],
  unchanged: true,
  bytesDelta: 0,
};

/**
 * Runs the humanizer pass. Empty / whitespace-only input is a no-op
 * (returns the input verbatim, `unchanged: true`) — saves an LLM
 * call when callers reuse the helper as a guard.
 */
export async function humanize(
  input: HumanizeInput,
  deps: HumanizeDeps,
): Promise<HumanizeResult> {
  if (input.text.trim().length === 0) {
    return { ...EMPTY_INPUT_RESULT, text: input.text };
  }

  const userMessage = buildUserMessage(input);
  const response = await deps.client.chat({
    system: loadHumanizerPrompt(),
    cacheSystem: true,
    messages: [{ role: "user", content: userMessage }],
  });

  const parsed = parseHumanizerResponse(response.text);
  return {
    text: parsed.text,
    changes: parsed.changes,
    unchanged: parsed.changes.length === 0,
    bytesDelta: input.text.length - parsed.text.length,
  };
}

interface ParsedResponse {
  text: string;
  changes: string[];
}

/**
 * Pure parser. Pulls `<humanized>...</humanized>` and
 * `<changes>...</changes>` out of the model output. Throws on
 * shape errors so a misbehaving model surfaces fast rather than
 * publishing garbage.
 */
export function parseHumanizerResponse(raw: string): ParsedResponse {
  const humanizedMatch = raw.match(/<humanized>([\s\S]*?)<\/humanized>/);
  if (!humanizedMatch || humanizedMatch[1] === undefined) {
    throw new HumanizerError(
      `humanizer response missing <humanized>...</humanized>. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const humanizedRaw = humanizedMatch[1];
  // The model is instructed to wrap the rewritten text on its own lines
  // inside the block — strip the immediate leading + trailing newline pair
  // we use as a delimiter, but preserve the body's internal whitespace.
  const text = stripWrapperNewlines(humanizedRaw);
  if (text.length === 0) {
    throw new HumanizerError("humanizer returned an empty <humanized> block");
  }

  const changesMatch = raw.match(/<changes>([\s\S]*?)<\/changes>/);
  if (!changesMatch || changesMatch[1] === undefined) {
    throw new HumanizerError(
      "humanizer response missing <changes>...</changes>",
    );
  }
  const changes = parseChangesBody(changesMatch[1]);
  return { text, changes };
}

/**
 * One leading `\n` and one trailing `\n` are part of the block
 * delimiter — drop them. Anything beyond that (blank lines the
 * author / humanizer left intentionally) stays.
 */
function stripWrapperNewlines(s: string): string {
  let out = s;
  if (out.startsWith("\n")) out = out.slice(1);
  if (out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

/**
 * Splits the `<changes>` body into bullet items. Treats:
 *   - `(none)` (case-insensitive, with surrounding whitespace) as no changes
 *   - lines starting with `-` or `*` or `•` as bullet markers (stripped)
 *   - other non-blank lines as continuations of the previous bullet
 *
 * Returns `[]` for the no-change case.
 */
function parseChangesBody(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  if (/^\(none\)$/i.test(trimmed)) return [];

  const out: string[] = [];
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const bulletMatch = line.match(/^[-*•]\s*(.*)$/);
    if (bulletMatch) {
      const value = bulletMatch[1]!.trim();
      if (value.length > 0) out.push(value);
    } else if (out.length > 0) {
      // Continuation — append to the previous bullet so multi-line
      // change descriptions stay together.
      out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    } else {
      // No leading bullet but content present — treat as the first item.
      out.push(line);
    }
  }
  return out;
}

function buildUserMessage(input: HumanizeInput): string {
  const lines: string[] = [];
  if (input.context !== undefined && input.context.trim().length > 0) {
    lines.push(`Context: ${input.context.trim()}`);
    lines.push("");
  }
  lines.push("Draft:");
  lines.push(input.text);
  return lines.join("\n");
}

let cachedPrompt: string | undefined;
function loadHumanizerPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  cachedPrompt = fs.readFileSync(
    path.join(repoRoot(), "prompts", "humanizer.md"),
    "utf8",
  );
  return cachedPrompt;
}
