import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunAgentResult,
  RunAgentTransport,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { loadBrain } from "../../orchestrator/brain.ts";
import { brainDocsFile, brainFile, dbFile, planDir } from "../paths.ts";
import {
  makeInstallSandbox,
  silenceConsole,
  type ConsoleSilencer,
  type InstallSandbox,
} from "./_test-helpers.ts";
import type { IntakeIO } from "../../agents/intake.ts";
import { cacheAbsolutePath } from "../../orchestrator/docs.ts";
import { runOnboard } from "./onboard.ts";

function fixedRunResult(text: string): RunAgentResult {
  return {
    text,
    subtype: "success",
    numTurns: 5,
    durationMs: 1234,
    totalCostUsd: 0,
    usage: {
      inputTokens: 50,
      outputTokens: 30,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    },
    permissionDenials: 0,
    errors: [],
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
  };
}

function fixedTransport(text: string): RunAgentTransport {
  return async () => fixedRunResult(text);
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
        { transport: fixedTransport(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("rejects a relative --repo path", async () => {
    expect(
      await runOnboard(
        ["--app", "demoapp", "--repo", "relative/path"],
        { transport: fixedTransport(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("rejects a missing vault", async () => {
    expect(
      await runOnboard(
        ["--app", "demoapp", "--repo", repoRoot, "--vault", "ghost"],
        { transport: fixedTransport(BRAIN_FOR("demoapp")) },
      ),
    ).toBe(1);
  });

  it("refuses to overwrite an existing brain", async () => {
    const code1 = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
    );
    expect(code1).toBe(0);

    const code2 = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
    );
    expect(code2).toBe(1);
  });

  it("writes a valid brain.json + docs.json + plans dir + app-onboarded event", async () => {
    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);

    const brain = loadBrain(brainFile(sandbox.dataDir, "personal", "demoapp"));
    expect(brain.projectName).toBe("demoapp");
    expect(brain.projectType).toBe("app");
    // Multi-repo support: onboard writes brain.repo from --repo flag
    expect(brain.repo?.rootPath).toBe(repoRoot);
    expect(brain.repo?.monorepoPath).toBeUndefined();

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

  it("writes brain.repo.monorepoPath when --monorepo-path is provided", async () => {
    // resolveRepoRoot validates the monorepo path exists, so create the
    // subdir in the fixture repo first.
    fs.mkdirSync(path.join(repoRoot, "apps", "demoapp"), { recursive: true });
    const code = await runOnboard(
      [
        "--app",
        "demoapp",
        "--repo",
        repoRoot,
        "--monorepo-path",
        "apps/demoapp",
      ],
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);
    const brain = loadBrain(brainFile(sandbox.dataDir, "personal", "demoapp"));
    expect(brain.repo?.rootPath).toBe(repoRoot);
    expect(brain.repo?.monorepoPath).toBe("apps/demoapp");
  });

  it("absorbs local-file docs into the agent context", async () => {
    const docPath = path.join(docsDir, "spec.md");
    fs.writeFileSync(docPath, "BRAND=tegező");

    let captured = "";
    const captureTransport: RunAgentTransport = async (resolved) => {
      captured = resolved.prompt;
      return fixedRunResult(BRAIN_FOR("demoapp"));
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
      { transport: captureTransport },
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
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
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
        transport: fixedTransport(BRAIN_FOR("demoapp")),
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
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
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
        transport: fixedTransport(BRAIN_FOR("demoapp")),
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
      { transport: fixedTransport(BRAIN_FOR("demoapp")) },
    );
    expect(code).toBe(0);
    expect(fs.existsSync(localPath)).toBe(true);
  });

  it("auto-skips the intake interview when stdin is not a TTY (default)", async () => {
    // No `hasTty` override → defaultHasTty() returns false in vitest
    let captured = "";
    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      {
        transport: async (resolved) => {
          captured = resolved.prompt;
          return fixedRunResult(BRAIN_FOR("demoapp"));
        },
      },
    );
    expect(code).toBe(0);
    expect(captured).not.toContain("Intake captured");
    // No intake doc registered.
    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(docsJson.find((d) => d["id"] === "intake")).toBeUndefined();
  });

  it("--skip-interview bypasses intake even when a TTY is present", async () => {
    let intakeCalls = 0;
    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot, "--skip-interview"],
      {
        transport: fixedTransport(BRAIN_FOR("demoapp")),
        intakeTransport: async () => {
          intakeCalls += 1;
          return fixedRunResult("");
        },
        hasTty: () => true,
      },
    );
    expect(code).toBe(0);
    expect(intakeCalls).toBe(0);
  });

  it("runs the intake interview when a TTY is present, persists intake.md, registers it as a cached doc, and feeds it into the brain extraction", async () => {
    // Scripted IO + transport for the intake agent
    const answers = ["Saw a parking gap.", "Renters waste 20+ minutes per trip."];
    let answerIdx = 0;
    const intakeIO: IntakeIO = {
      readUserAnswer: async () => {
        const a = answers[answerIdx++];
        return a !== undefined
          ? { kind: "answer", text: a }
          : { kind: "end" };
      },
      writeOutput: () => {},
    };
    const intakeResponses = [
      `<ask sectionId="origin-story">Why did you start it?</ask>`,
      `<save sectionId="origin-story" status="answered">Saw a parking gap.</save>
<ask sectionId="problem-and-opportunity">What problem does it solve?</ask>`,
      `<save sectionId="problem-and-opportunity" status="answered">Renters waste 20+ minutes per trip.</save>
<done>2 sections captured.</done>`,
    ];
    let intakeIdx = 0;
    let phase2Prompt = "";

    const code = await runOnboard(
      ["--app", "demoapp", "--repo", repoRoot],
      {
        transport: async (resolved) => {
          phase2Prompt = resolved.prompt;
          return fixedRunResult(BRAIN_FOR("demoapp"));
        },
        intakeTransport: async () => {
          if (intakeIdx >= intakeResponses.length) {
            throw new Error("intake out of responses");
          }
          return fixedRunResult(intakeResponses[intakeIdx++]!);
        },
        intakeIO,
        hasTty: () => true,
      },
    );
    expect(code).toBe(0);

    // Intake file persisted
    const intakeFile = cacheAbsolutePath(
      sandbox.dataDir,
      "personal",
      "demoapp",
      "intake",
    );
    expect(fs.existsSync(intakeFile)).toBe(true);
    const intakeText = fs.readFileSync(intakeFile, "utf8");
    expect(intakeText).toContain("# Intake — demoapp");
    expect(intakeText).toContain("Saw a parking gap.");
    expect(intakeText).toContain("Renters waste 20+ minutes per trip.");

    // Brain extraction got the intake doc inline
    expect(phase2Prompt).toContain("ABSORBED DOCS");
    expect(phase2Prompt).toContain("Saw a parking gap.");

    // docs.json has the intake entry
    const docsJson = JSON.parse(
      fs.readFileSync(brainDocsFile(sandbox.dataDir, "personal", "demoapp"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const intakeEntry = docsJson.find((d) => d["id"] === "intake");
    expect(intakeEntry).toBeDefined();
    expect(intakeEntry?.["retention"]).toBe("cached");
    expect(intakeEntry?.["tags"]).toEqual(["intake"]);
    expect(intakeEntry?.["cachedFile"]).toBe("docs/intake/content.txt");
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
      { transport: fixedTransport("not a brain") },
    );
    expect(code).toBe(1);
    expect(fs.existsSync(localPath)).toBe(true);
  });
});
