import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../../orchestrator/atomic-write.ts";

export interface CacheEntry<T> {
  cachedAt: number;
  ttlMs: number;
  value: T;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheOptions {
  nowMs?: number;
  ttlMs?: number;
}

export function getCached<T>(
  cacheDir: string,
  key: string,
  opts: CacheOptions = {},
): T | null {
  const nowMs = opts.nowMs ?? Date.now();
  const filePath = path.join(cacheDir, `${key}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  let entry: CacheEntry<T>;
  try {
    entry = JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
  if (nowMs - entry.cachedAt > entry.ttlMs) return null;
  return entry.value;
}

export function setCached<T>(
  cacheDir: string,
  key: string,
  value: T,
  opts: CacheOptions = {},
): void {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, `${key}.json`);
  const entry: CacheEntry<T> = { cachedAt: nowMs, ttlMs, value };
  atomicWriteFileSync(filePath, JSON.stringify(entry, null, 2) + "\n");
}
