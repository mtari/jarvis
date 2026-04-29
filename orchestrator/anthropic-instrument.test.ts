import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnthropicClient, ChatResponse } from "./agent-sdk-runtime.ts";
import {
  buildAgentCallRecorder,
  instrumentClient,
} from "./anthropic-instrument.ts";
import { runMigrations } from "../migrations/runner.ts";

function makeStubClient(model: string = "claude-sonnet-4-6"): {
  client: AnthropicClient;
  callCount: () => number;
} {
  let count = 0;
  const client: AnthropicClient = {
    async chat() {
      count += 1;
      const response: ChatResponse = {
        text: "ok",
        blocks: [
          { type: "text", text: "ok", citations: null } as Anthropic.TextBlock,
        ],
        stopReason: "end_turn",
        model,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
      return response;
    },
  };
  return { client, callCount: () => count };
}

describe("instrumentClient", () => {
  it("calls emit with request, response, and durationMs after each chat", async () => {
    const { client } = makeStubClient();
    const captured: Array<{ durationMs: number; model: string }> = [];
    const wrapped = instrumentClient(client, (info) => {
      captured.push({
        durationMs: info.durationMs,
        model: info.response.model,
      });
    });
    await wrapped.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toBe("claude-sonnet-4-6");
    expect(captured[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("swallows emitter errors so the call still resolves", async () => {
    const { client } = makeStubClient();
    const wrapped = instrumentClient(client, () => {
      throw new Error("emitter blew up");
    });
    const response = await wrapped.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.text).toBe("ok");
  });
});

describe("buildAgentCallRecorder", () => {
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-instrument-"));
    dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    try {
      await runMigrations(
        db,
        path.join(import.meta.dirname, "..", "migrations", "db"),
      );
    } finally {
      db.close();
    }
    cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("flush writes one agent-call event per chat call", async () => {
    const { client } = makeStubClient();
    const recorder = buildAgentCallRecorder(client, dbPath, {
      app: "jarvis",
      vault: "personal",
      agent: "strategist",
    });

    await recorder.client.chat({
      messages: [{ role: "user", content: "first" }],
    });
    await recorder.client.chat({
      messages: [{ role: "user", content: "second" }],
    });
    recorder.flush();

    const verify = new Database(dbPath, { readonly: true });
    try {
      const events = verify
        .prepare("SELECT * FROM events WHERE kind = 'agent-call' ORDER BY id")
        .all() as Array<{ payload: string; app_id: string; vault_id: string }>;
      expect(events).toHaveLength(2);
      expect(events[0]?.app_id).toBe("jarvis");
      const decoded = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(decoded["agent"]).toBe("strategist");
      expect(decoded["model"]).toBe("claude-sonnet-4-6");
      expect(decoded["inputTokens"]).toBe(100);
    } finally {
      verify.close();
    }
  });

  it("attaches planId from ctx at flush time, even if assigned mid-flight", async () => {
    const { client } = makeStubClient();
    const recorder = buildAgentCallRecorder(client, dbPath, {
      app: "jarvis",
      vault: "personal",
      agent: "strategist",
    });
    await recorder.client.chat({ messages: [{ role: "user", content: "x" }] });
    recorder.ctx.planId = "2026-04-27-late-attach";
    recorder.flush();

    const verify = new Database(dbPath, { readonly: true });
    try {
      const event = verify
        .prepare("SELECT payload FROM events WHERE kind = 'agent-call'")
        .get() as { payload: string };
      expect(JSON.parse(event.payload).planId).toBe("2026-04-27-late-attach");
    } finally {
      verify.close();
    }
  });

  it("flush is a no-op when no calls were captured", async () => {
    const { client: _client } = makeStubClient();
    const recorder = buildAgentCallRecorder(_client, dbPath, {
      app: "jarvis",
      vault: "personal",
      agent: "developer",
    });
    recorder.flush();
    const verify = new Database(dbPath, { readonly: true });
    try {
      const events = verify
        .prepare("SELECT * FROM events WHERE kind = 'agent-call'")
        .all();
      expect(events).toEqual([]);
    } finally {
      verify.close();
    }
  });

  it("flush clears the buffer (re-flush writes nothing)", async () => {
    const { client } = makeStubClient();
    const recorder = buildAgentCallRecorder(client, dbPath, {
      app: "jarvis",
      vault: "personal",
      agent: "developer",
    });
    await recorder.client.chat({ messages: [{ role: "user", content: "x" }] });
    recorder.flush();
    recorder.flush();

    const verify = new Database(dbPath, { readonly: true });
    try {
      const events = verify
        .prepare("SELECT * FROM events WHERE kind = 'agent-call'")
        .all();
      expect(events).toHaveLength(1);
    } finally {
      verify.close();
    }
  });
});
