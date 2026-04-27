export const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

interface PatternDef {
  kind: string;
  regex: RegExp;
}

const PATTERNS: PatternDef[] = [
  {
    kind: "anthropic-key",
    regex: /\bsk-ant-(?:api|admin|sid)\d{2}-[A-Za-z0-9_-]{40,}/g,
  },
  {
    kind: "openai-key",
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { kind: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "stripe-key",
    regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  },
  {
    kind: "doppler-token",
    regex: /\bdp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9.\-_]{20,}/g,
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "env-secret",
    regex:
      /\b[A-Z][A-Z0-9_]*?(?:SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^\s'"]+/g,
  },
];

export interface RedactionMatch {
  kind: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  matches: RedactionMatch[];
}

export function redact(input: string): RedactionResult {
  const raw: RedactionMatch[] = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input)) !== null) {
      raw.push({ kind, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
  }

  if (raw.length === 0) return { text: input, matches: [] };

  raw.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start),
  );
  const resolved: RedactionMatch[] = [];
  let cursor = 0;
  for (const m of raw) {
    if (m.start < cursor) continue;
    resolved.push(m);
    cursor = m.end;
  }

  let result = "";
  let pos = 0;
  for (const m of resolved) {
    result += input.slice(pos, m.start);
    result += REDACTION_PLACEHOLDER;
    pos = m.end;
  }
  result += input.slice(pos);

  return { text: result, matches: resolved };
}

export function hasSecrets(input: string): boolean {
  return redact(input).matches.length > 0;
}
