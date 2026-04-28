import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatRequest,
  ChatResponse,
} from "../orchestrator/anthropic-client.ts";
import { OnboardError, runOnboardAgent } from "./onboard.ts";

interface ScriptedClient {
  client: AnthropicClient;
  calls: ChatRequest[];
}

function fixedTextResponse(text: string): ChatResponse {
  return {
    text,
    blocks: [
      { type: "text", text, citations: null } as Anthropic.TextBlock,
    ],
    stopReason: "end_turn",
    model: "claude-sonnet-4-6",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    redactions: [],
  };
}

function scriptedClient(responses: string[]): ScriptedClient {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        if (i >= responses.length) {
          throw new Error("scripted client out of responses");
        }
        return fixedTextResponse(responses[i++]!);
      },
    },
  };
}

const VALID_BRAIN = (app: string): string => `<brain>
{
  "schemaVersion": 1,
  "projectName": "${app}",
  "projectType": "app",
  "projectStatus": "active",
  "projectPriority": 3,
  "stack": { "runtime": "node22", "language": "typescript" },
  "conventions": { "testing": "vitest" }
}
</brain>`;

describe("runOnboardAgent", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-onboard-"));
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { typescript: "*" } }, null, 2),
    );
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Demo project");
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("parses + validates the <brain> JSON and forces projectName to match --app", async () => {
    const { client, calls } = scriptedClient([VALID_BRAIN("orig-name")]);
    const result = await runOnboardAgent({
      client,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [],
      cachedDocs: [],
    });
    expect(result.brain.projectName).toBe("demo-app");
    expect(result.brain.projectType).toBe("app");
    // System prompt was actually loaded
    expect(String(calls[0]?.system ?? "")).toContain("onboarding");
  });

  it("includes absorbed doc content in the user message", async () => {
    const { client, calls } = scriptedClient([VALID_BRAIN("demo-app")]);
    await runOnboardAgent({
      client,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [{ source: "/tmp/spec.md", content: "BRAND_VOICE=tegező" }],
      cachedDocs: [],
    });
    const userMsg = String(calls[0]?.messages[0]?.content ?? "");
    expect(userMsg).toContain("ABSORBED DOCS");
    expect(userMsg).toContain("BRAND_VOICE=tegező");
    expect(userMsg).toContain("/tmp/spec.md");
  });

  it("lists cached docs without their content", async () => {
    const { client, calls } = scriptedClient([VALID_BRAIN("demo-app")]);
    await runOnboardAgent({
      client,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [],
      cachedDocs: [
        { id: "guidelines", source: "/tmp/guidelines.md", summary: "house style" },
      ],
    });
    const userMsg = String(calls[0]?.messages[0]?.content ?? "");
    expect(userMsg).toContain("CACHED DOCS");
    expect(userMsg).toContain("guidelines");
    expect(userMsg).toContain("house style");
  });

  it("throws OnboardError when no <brain> block is in the response", async () => {
    const { client } = scriptedClient(["just chatter"]);
    await expect(
      runOnboardAgent({
        client,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toBeInstanceOf(OnboardError);
  });

  it("throws OnboardError when <brain> contains malformed JSON", async () => {
    const { client } = scriptedClient(["<brain>{ not: valid json }</brain>"]);
    await expect(
      runOnboardAgent({
        client,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("throws OnboardError when the brain doesn't satisfy the Zod schema", async () => {
    const { client } = scriptedClient([
      `<brain>
{
  "schemaVersion": 99,
  "projectName": "x",
  "projectType": "weird",
  "projectStatus": "active",
  "projectPriority": 3
}
</brain>`,
    ]);
    await expect(
      runOnboardAgent({
        client,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toThrow(/schema validation/);
  });

  it("rejects a non-absolute repo root", async () => {
    const { client } = scriptedClient([VALID_BRAIN("x")]);
    await expect(
      runOnboardAgent({
        client,
        app: "x",
        repoRoot: "relative/path",
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toBeInstanceOf(OnboardError);
  });
});
