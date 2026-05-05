import fs from "node:fs";
import path from "node:path";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { repoRoot } from "../paths.ts";

/**
 * `yarn jarvis ask "<text>"`
 *
 * Translate a natural-language request into one of the supported
 * Jarvis CLI commands and run it. Backed by a single LLM call with
 * the command catalog as system prompt; output protocol is one of
 * `<run>` / `<clarify>` / `<refuse>` (see `prompts/ask.md`).
 *
 * Mutating ops are limited to a small allowlist (notes append /
 * scan / scout / suppress / unsuppress). Plan-state changes
 * (approve / reject / revise / cancel) are deliberately routed
 * back to direct commands — the prompt instructs the model to
 * refuse them with a pointer.
 *
 * Recursive-`ask` protection: the dispatcher should reject `ask`
 * pointing at itself, but as a belt-and-braces, this module also
 * refuses to translate `ask` from inside the prompt's allowlist.
 */

export interface AskRunDeps {
  /** Override the LLM client (test seam). */
  buildClient?: () => AnthropicClient;
  /**
   * Override the dispatcher used to run the resolved command (test seam).
   * Production injects `dispatch` from `cli/dispatch.ts`. The dependency
   * is parameterised to break the import cycle between dispatch and ask.
   */
  dispatch?: (argv: string[]) => Promise<number>;
}

export type AskInterpretation =
  | { kind: "run"; command: string; argv: string[]; explanation: string }
  | { kind: "clarify"; question: string }
  | { kind: "refuse"; reason: string };

export class AskParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskParseError";
  }
}

export async function runAsk(
  rawArgs: string[],
  deps: AskRunDeps = {},
): Promise<number> {
  const text = rawArgs.join(" ").trim();
  if (text.length === 0) {
    console.error('ask: text required. Usage: yarn jarvis ask "<text>"');
    return 1;
  }

  const client = deps.buildClient ? deps.buildClient() : createSdkClient();
  let interpretation: AskInterpretation;
  try {
    interpretation = await interpretAsk(text, client);
  } catch (err) {
    console.error(
      `ask: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  switch (interpretation.kind) {
    case "clarify":
      console.log(`Need more info: ${interpretation.question}`);
      return 0;
    case "refuse":
      console.log(interpretation.reason);
      return 1;
    case "run":
      console.log(`→ ${interpretation.explanation}`);
      console.log(
        `  yarn jarvis ${interpretation.command} ${interpretation.argv.slice(1).join(" ")}`,
      );
      console.log("");
      if (!deps.dispatch) {
        console.error(
          "ask: dispatch dependency not wired. Re-run via the CLI entry point.",
        );
        return 1;
      }
      return deps.dispatch(interpretation.argv);
  }
}

/**
 * Single LLM call: catalog as system prompt, free text as user message.
 * Returns the parsed interpretation. Pure-ish — no I/O beyond the
 * client.chat() call.
 */
export async function interpretAsk(
  text: string,
  client: AnthropicClient,
): Promise<AskInterpretation> {
  const systemPrompt = loadAskPrompt();
  const response = await client.chat({
    system: systemPrompt,
    cacheSystem: true,
    messages: [{ role: "user", content: text }],
  });
  return parseAskResponse(response.text);
}

/**
 * Parses one of `<run>` / `<clarify>` / `<refuse>` out of the LLM's
 * response text. Throws AskParseError for any other shape.
 */
export function parseAskResponse(text: string): AskInterpretation {
  const refuseMatch = text.match(/<refuse>([\s\S]*?)<\/refuse>/);
  if (refuseMatch && refuseMatch[1]) {
    const reason = refuseMatch[1].trim();
    if (reason.length === 0) throw new AskParseError("empty refuse block");
    return { kind: "refuse", reason };
  }

  const clarifyMatch = text.match(/<clarify>([\s\S]*?)<\/clarify>/);
  if (clarifyMatch && clarifyMatch[1]) {
    const question = clarifyMatch[1].trim();
    if (question.length === 0) throw new AskParseError("empty clarify block");
    return { kind: "clarify", question };
  }

  const runMatch = text.match(/<run>([\s\S]*?)<\/run>/);
  if (runMatch && runMatch[1]) {
    const body = runMatch[1].trim();
    return parseRunBlock(body);
  }

  throw new AskParseError(
    `response had neither <run>, <clarify>, nor <refuse>. First 200 chars: ${text.slice(0, 200)}`,
  );
}

function parseRunBlock(body: string): AskInterpretation {
  const lines = body.split("\n");
  let command: string | undefined;
  let argsLine: string | undefined;
  let explanation: string | undefined;
  for (const raw of lines) {
    const m = raw.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    switch (key) {
      case "command":
        command = value;
        break;
      case "args":
        argsLine = value;
        break;
      case "explanation":
        explanation = value;
        break;
      default:
        // ignore unknown keys
        break;
    }
  }
  if (!command) {
    throw new AskParseError("<run> block missing `command:` line");
  }
  if (!explanation) {
    throw new AskParseError("<run> block missing `explanation:` line");
  }
  // Belt-and-braces: refuse `ask` recursion at parse time. The system
  // prompt forbids it, but a misbehaving model shouldn't be able to
  // loop the runtime.
  if (command === "ask") {
    return {
      kind: "refuse",
      reason:
        "ask cannot be invoked recursively. Type the command you want directly.",
    };
  }
  // `args:` may legitimately be blank for commands like `inbox` or
  // `triage` that take no args.
  const argv = [command, ...tokenizeArgs(argsLine ?? "")];
  return {
    kind: "run",
    command,
    argv,
    explanation,
  };
}

/**
 * Splits a CLI-style args string into an argv-shaped array. Honours
 * single + double quotes for values containing spaces. Backslash
 * escapes are NOT interpreted — the LLM doesn't need that complexity
 * and the runner accepts plain quoted strings.
 */
export function tokenizeArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}

let cachedPrompt: string | undefined;
function loadAskPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  const promptPath = path.join(repoRoot(), "prompts", "ask.md");
  cachedPrompt = fs.readFileSync(promptPath, "utf8");
  return cachedPrompt;
}
