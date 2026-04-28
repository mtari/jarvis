import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AnthropicClient,
  ChatResponse,
} from "../../orchestrator/anthropic-client.ts";
import { loadBrain } from "../../orchestrator/brain.ts";
import { brainDocsFile, brainFile, dbFile, planDir } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import { runOnboard } from "./onboard.ts";

function fixedClient(text: string): AnthropicClient {
  return {
    async chat() {
      const response: ChatResponse = {
        text,
        blocks: [
          { type: "text", text, citations: null } as Anthropic.TextBlock,
        ],
        stopReason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        redactions: [],
      };
      return response;
    },
  };
}

const BRAIN_FOR = (app: string): string => `<brain>
{
  "schemaVersion": 1,
  "projectName": "${app}",
  "projectType": "app",
  "projectStatus": "active",
  "projectPriority": 3,
  "stack": { "runtime": "node22" }
}
</brain>`;

describe("runOnboard", () => {
  let sandbox: InstallSandbox;
  let silencer: ConsoleSilencer;
  let repoRoot: string;
  let docsDir: string;

  beforeEach(async () => {
    sandbox = await makeInstallSandbox();
    silencer = silenceConsole();
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-onboard-repo-"));
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2),
    );
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-onboard-docs-"));
  });

  afterEach(() => {
    silencer.restore();
    sandbox.cleanup();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it("validates --app and --repo are required", async () => {
    expect(await runOnboard([])).toBe(1);
    expect(await runOnboard(["--app", "demo"])).toBe(1);
    expect(await runOnboard(["--repo", repoRoot])).toBe(1);
  });

  it("rejects an --app name that doesn't match the kebab pattern", async () => {
    expect(
      await runOnboard(
        ["--app", "DemoApp", "--repo", repoRoot],
        { client: fixedClient(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("rejects a relative --repo path", async () => {
    expect(
      await runOnboard(
        ["--app", "demoapp", "--repo", "relative/path"],
        { client: fixedClient(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("rejects a missing vault", async () => {
    expect(
      await runOnboard(
        ["--app", "demoapp", "--repo", repoRoot, "--vault", "ghost"],
        { client: fixedClient(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("refuses to overwrite an existing brain", async () => {
    const code1 = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code1).toBe(0);

    const code2 = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code2).toBe(1);
  });

  it("writes a valid brain.json + docs.json + plans dir + app-onboarded event", async () => {
    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);

    const brain = loadBrain(brainFile(sandbox.dataDir, "personal", "demoapp"));
    expect(brain.projectName).toBe("demoapp");
    expect(brain.projectType).toBe("app");

    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    );
    expect(docsJson).toEqual([]);

    expect(
      fs.existsSync(planDir(sandbox.dataDir, "personal", "demoapp")),
    ).toBe(true);

    const db = new Database(dbFile(sandbox.dataDir), { readonly: true });
    try {
      const events = db
        .prepare("SELECT * FROM events WHERE kind = 'app-onboarded'")
        .all() as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload)).toMatchObject({
        app: "demoapp",
        vault: "personal",
      });
    } finally {
      db.close();
    }
  });

  it("absorbs local-file docs into the agent context", async () => {
    const docPath = path.join(docsDir, "spec.md");
    fs.writeFileSync(docPath, "BRAND=tegező");

    let captured = "";
    const captureClient: AnthropicClient = {
      async chat(req) {
        const text = String(req.messages[0]?.content ?? "");
        captured = text;
        const text2 = BRAIN_FOR("demoapp");
        return {
          text: text2,
          blocks: [
            { type: "text", text: text2, citations: null } as Anthropic.TextBlock,
          ],
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
          usage: {
            inputTokens: 50,
            outputTokens: 30,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
          },
          redactions: [],
        };
      },
    };

    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs",
        docPath,
      ],
      { client: captureClient },
    );
    expect(code).toBe(0);
    expect(captured).toContain("BRAND=tegező");

    // Absorbed doc shows up in docs.json
    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(docsJson).toHaveLength(1);
    expect(docsJson[0]?.["retention"]).toBe("absorbed");
  });

  it("caches --docs-keep doc content into brains/<app>/docs/<id>/", async () => {
    const docPath = path.join(docsDir, "guidelines.md");
    fs.writeFileSync(docPath, "House style: terse.");

    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot, "--docs-keep", docPath],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);

    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const cached = docsJson.find((d) => d["retention"] === "cached");
    expect(cached).toBeDefined();
    const cachedFile = String(cached?.["cachedFile"] ?? "");
    const fullPath = path.join(
      sandbox.dataDir,
      "vaults",
      "personal",
      "brains",
      "demoapp",
      cachedFile,
    );
    expect(fs.readFileSync(fullPath, "utf8")).toBe("House style: terse.");
  });

  it("uses an injected fetchUrl for URL docs", async () => {
    const fetched: string[] = [];
    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs",
        "https://example.com/spec",
      ],
      {
        client: fixedClient(BRAIN_FOR("demoapp")),
        fetchUrl: async (url) => {
          fetched.push(url);
          return { content: "fetched-spec-body", contentType: "text/plain" };
        },
      },
    );
    expect(code).toBe(0);
    expect(fetched).toEqual(["https://example.com/spec"]);
  });

  it("--move-docs deletes local source docs after a successful onboard", async () => {
    const absorbedPath = path.join(docsDir, "spec.md");
    const cachedPath = path.join(docsDir, "guidelines.md");
    fs.writeFileSync(absorbedPath, "BRAND=tegező");
    fs.writeFileSync(cachedPath, "House style: terse.");

    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs",
        absorbedPath,
        "--docs-keep",
        cachedPath,
        "--move-docs",
      ],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(absorbedPath)).toBe(false);
    expect(fs.existsSync(cachedPath)).toBe(false);

    // Cached copy is preserved inside jarvis-data
    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const cached = docsJson.find((d) => d["retention"] === "cached");
    expect(cached).toBeDefined();
    const cachedFile = String(cached?.["cachedFile"] ?? "");
    expect(
      fs.existsSync(
        path.join(
          sandbox.dataDir,
          "vaults",
          "personal",
          "brains",
          "demoapp",
          cachedFile,
        ),
      ),
    ).toBe(true);
  });

  it("--move-docs leaves URL docs alone", async () => {
    const localPath = path.join(docsDir, "local.md");
    fs.writeFileSync(localPath, "local body");
    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs",
        localPath,
        "--docs",
        "https://example.com/spec",
        "--move-docs",
      ],
      {
        client: fixedClient(BRAIN_FOR("demoapp")),
        fetchUrl: async () => ({ content: "fetched", contentType: "text/plain" }),
      },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it("does not delete sources when --move-docs is absent", async () => {
    const localPath = path.join(docsDir, "still-here.md");
    fs.writeFileSync(localPath, "stay");
    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs-keep",
        localPath,
      ],
      { client: fixedClient(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(localPath)).toBe(true);
  });

  it("preserves the source file when the onboard agent fails", async () => {
    const localPath = path.join(docsDir, "preserved.md");
    fs.writeFileSync(localPath, "stay");
    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--docs",
        localPath,
        "--move-docs",
      ],
      { client: fixedClient("not a brain") },
    );
    expect(code).toBe(1);
    expect(fs.existsSync(localPath)).toBe(true);
  });
});
