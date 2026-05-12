export interface SlashArgsParsed {
  app?: string;
  type?: string;
  rest: string;
  parseError?: string;
}

/**
 * Parses the raw argument string after a `/jarvis plan` or `/jarvis bug`
 * subcommand, respecting double-quoted segments and consuming `--app <val>`
 * and `--type <val>` flag pairs.
 *
 * When no `--` flags are present the first token is the app and the
 * remainder is the brief (positional fallback, preserves today's working
 * invocations).
 */
export function parseSlashArgs(raw: string): SlashArgsParsed {
  const tokens = tokenize(raw);

  let hasFlags = false;
  let app: string | undefined;
  let type: string | undefined;
  let parseError: string | undefined;
  const restTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--app") {
      hasFlags = true;
      const val = tokens[i + 1];
      if (!val || val.startsWith("--")) {
        parseError = "Missing value after --app";
        break;
      }
      app = val;
      i += 1;
    } else if (tok === "--type") {
      hasFlags = true;
      const val = tokens[i + 1];
      if (!val || val.startsWith("--")) {
        parseError = "Missing value after --type";
        break;
      }
      type = val;
      i += 1;
    } else if (tok.startsWith("--")) {
      hasFlags = true;
      // Unknown flag — skip without consuming a value
    } else {
      restTokens.push(tok);
    }
  }

  if (parseError) return { rest: "", parseError };

  if (!hasFlags) {
    // Positional fallback: first token = app, remainder = brief
    const [first, ...remaining] = tokens;
    return {
      ...(first !== undefined && { app: first }),
      rest: remaining.join(" "),
    };
  }

  return {
    ...(app !== undefined && { app }),
    ...(type !== undefined && { type }),
    rest: restTokens.join(" "),
  };
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
