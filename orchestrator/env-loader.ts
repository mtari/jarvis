import fs from "node:fs";

export interface LoadEnvOptions {
  /** When true, override an existing process.env value. Default false. */
  override?: boolean;
}

export interface LoadEnvResult {
  loaded: Record<string, string>;
  applied: string[];
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/^﻿/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(
  envPath: string,
  opts: LoadEnvOptions = {},
): LoadEnvResult {
  if (!fs.existsSync(envPath)) {
    return { loaded: {}, applied: [] };
  }
  const content = fs.readFileSync(envPath, "utf8");
  const loaded = parseEnv(content);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(loaded)) {
    if (value === "") continue;
    if (process.env[key] !== undefined && !opts.override) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return { loaded, applied };
}
