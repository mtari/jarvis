import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResolvedOptions,
  RunAgentResult,
  RunAgentTransport,
} from "../orchestrator/agent-sdk-runtime.ts";
import { OnboardError, runOnboardAgent } from "./onboard.ts";

interface ScriptedTransport {
  transport: RunAgentTransport;
  calls: RunAgentResolvedOptions[];
}

function fixedRunResult(text: string): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 5,
    durationMs: 1234,
    totalCostUsd: 0,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  };
}

function scriptedTransport(responses: string[]): ScriptedTransport {
  const calls: RunAgentResolvedOptions[] = [];
  let i = 0;
  const transport: RunAgentTransport = async (resolved) => {
    calls.push(resolved);
    if (i >= responses.length) {
      throw new Error("scripted transport out of responses");
    }
    return fixedRunResult(responses[i++]!);
  };
  return { calls, transport };
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
    const { transport, calls } = scriptedTransport([VALID_BRAIN("orig-name")]);
    const result = await runOnboardAgent({
      transport,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [],
      cachedDocs: [],
    });
    expect(result.brain.projectName).toBe("demo-app");
    expect(result.brain.projectType).toBe("app");
    // System prompt was actually loaded
    const sysPrompt = calls[0]?.systemPrompt;
    const sysText = typeof sysPrompt === "string" ? sysPrompt : "";
    expect(sysText).toContain("onboarding");
  });

  it("includes absorbed doc content in the user message", async () => {
    const { transport, calls } = scriptedTransport([VALID_BRAIN("demo-app")]);
    await runOnboardAgent({
      transport,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [{ source: "/tmp/spec.md", content: "BRAND_VOICE=tegező" }],
      cachedDocs: [],
    });
    const userMsg = calls[0]?.prompt ?? "";
    expect(userMsg).toContain("ABSORBED DOCS");
    expect(userMsg).toContain("BRAND_VOICE=tegező");
    expect(userMsg).toContain("/tmp/spec.md");
  });

  it("lists cached docs without their content", async () => {
    const { transport, calls } = scriptedTransport([VALID_BRAIN("demo-app")]);
    await runOnboardAgent({
      transport,
      app: "demo-app",
      repoRoot,
      absorbedDocs: [],
      cachedDocs: [
        { id: "guidelines", source: "/tmp/guidelines.md", summary: "house style" },
      ],
    });
    const userMsg = calls[0]?.prompt ?? "";
    expect(userMsg).toContain("CACHED DOCS");
    expect(userMsg).toContain("guidelines");
    expect(userMsg).toContain("house style");
  });

  it("throws OnboardError when no <brain> block is in the response", async () => {
    const { transport } = scriptedTransport(["just chatter"]);
    await expect(
      runOnboardAgent({
        transport,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toBeInstanceOf(OnboardError);
  });

  it("throws OnboardError when <brain> contains malformed JSON", async () => {
    const { transport } = scriptedTransport(["<brain>{ not: valid json }</brain>"]);
    await expect(
      runOnboardAgent({
        transport,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("throws OnboardError when the brain doesn't satisfy the Zod schema", async () => {
    const { transport } = scriptedTransport([
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
        transport,
        app: "demo-app",
        repoRoot,
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toThrow(/schema validation/);
  });

  it("rejects a non-absolute repo root", async () => {
    const { transport } = scriptedTransport([VALID_BRAIN("x")]);
    await expect(
      runOnboardAgent({
        transport,
        app: "x",
        repoRoot: "relative/path",
        absorbedDocs: [],
        cachedDocs: [],
      }),
    ).rejects.toBeInstanceOf(OnboardError);
  });
});
