import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "../cli/commands/_test-helpers.ts";
import { dbFile } from "../cli/paths.ts";
import { recordEscalation } from "./escalations.ts";

describe("recordEscalation", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
  });

  function readEscalations(): Array<Record<string, unknown>> {
    const conn = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const rows = conn
        .prepare("SELECT app_id, vault_id, payload FROM events WHERE kind = 'escalation' ORDER BY id")
        .all() as Array<{ app_id: string; vault_id: string; payload: string }>;
      return rows.map((r) => ({
        appId: r.app_id,
        vaultId: r.vault_id,
        ...JSON.parse(r.payload),
      }));
    } finally {
      conn.close();
    }
  }

  it("writes a single `escalation` event with the required fields", () => {
    recordEscalation(dbFile(sandbox.dataDir), {
      kind: "rate-limit",
      severity: "high",
      summary: "Claude Code subscription rate limit hit",
    });
    const events = readEscalations();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "rate-limit",
      severity: "high",
      summary: "Claude Code subscription rate limit hit",
      appId: "jarvis",
      vaultId: "personal",
    });
  });

  it("records optional detail / planId / app when provided", () => {
    recordEscalation(dbFile(sandbox.dataDir), {
      kind: "cash-in-violation",
      severity: "critical",
      summary: "x",
      detail: "stack trace here",
      planId: "2026-04-30-foo",
      app: "erdei-fahazak",
    });
    const events = readEscalations();
    expect(events[0]).toMatchObject({
      detail: "stack trace here",
      planId: "2026-04-30-foo",
      app: "erdei-fahazak",
      appId: "erdei-fahazak",
    });
  });

  it("writes duplicates when called repeatedly (caller-controlled idempotency)", () => {
    recordEscalation(dbFile(sandbox.dataDir), {
      kind: "rate-limit",
      severity: "high",
      summary: "first hit",
    });
    recordEscalation(dbFile(sandbox.dataDir), {
      kind: "rate-limit",
      severity: "high",
      summary: "second hit",
    });
    expect(readEscalations()).toHaveLength(2);
  });
});
