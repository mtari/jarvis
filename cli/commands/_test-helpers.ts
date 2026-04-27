import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planDir } from "../paths.ts";
import { runInstall } from "./install.ts";

export interface InstallSandbox {
  dataDir: string;
  tmpRoot: string;
  cleanup: () => void;
}

export interface ConsoleSilencer {
  restore: () => void;
}

export function silenceConsole(): ConsoleSilencer {
  const origLog = console.log;
  const origError = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  console.log = (): void => {};
  console.error = (): void => {};
  process.stdout.write = ((): true => true) as typeof process.stdout.write;
  process.stderr.write = ((): true => true) as typeof process.stderr.write;

  return {
    restore: (): void => {
      console.log = origLog;
      console.error = origError;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

export async function makeInstallSandbox(): Promise<InstallSandbox> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sbx-"));
  const dataDir = path.join(tmpRoot, "jarvis-data");

  const silencer = silenceConsole();
  try {
    const code = await runInstall(["--data-dir", dataDir]);
    if (code !== 0) {
      throw new Error(`install in sandbox returned ${code}`);
    }
  } finally {
    silencer.restore();
  }

  const previousEnv = process.env["JARVIS_DATA_DIR"];
  process.env["JARVIS_DATA_DIR"] = dataDir;

  return {
    dataDir,
    tmpRoot,
    cleanup: (): void => {
      if (previousEnv === undefined) {
        delete process.env["JARVIS_DATA_DIR"];
      } else {
        process.env["JARVIS_DATA_DIR"] = previousEnv;
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

export interface PlanFixtureOptions {
  title?: string;
  type?: "improvement" | "implementation" | "business" | "marketing";
  subtype?: string;
  parentPlan?: string;
  implementationReview?: "required" | "skip" | "auto";
  app?: string;
  priority?: "low" | "normal" | "high" | "blocking";
  destructive?: boolean;
  status?: string;
  author?: string;
}

export function planFixture(opts: PlanFixtureOptions = {}): string {
  const o = {
    title: "Test plan",
    type: "improvement" as const,
    subtype: "new-feature",
    implementationReview: "required" as const,
    app: "jarvis",
    priority: "normal" as const,
    destructive: false,
    status: "awaiting-review",
    author: "strategist",
    ...opts,
  };

  const lines: string[] = [];
  lines.push(`# Plan: ${o.title}`);
  lines.push(`Type: ${o.type}`);
  if (o.subtype) lines.push(`Subtype: ${o.subtype}`);
  if (o.parentPlan) lines.push(`ParentPlan: ${o.parentPlan}`);
  if (o.type === "improvement" && o.implementationReview) {
    lines.push(`ImplementationReview: ${o.implementationReview}`);
  }
  lines.push(`App: ${o.app}`);
  lines.push(`Priority: ${o.priority}`);
  lines.push(`Destructive: ${o.destructive}`);
  lines.push(`Status: ${o.status}`);
  lines.push(`Author: ${o.author}`);
  lines.push(`Confidence: 75 — test fixture`);
  lines.push("");
  lines.push("## Problem");
  lines.push("Test problem.");
  lines.push("");
  lines.push("## Build plan");
  lines.push("Test build.");
  lines.push("");
  lines.push("## Testing strategy");
  lines.push("Test strategy.");
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("- ok");
  lines.push("");
  return lines.join("\n");
}

export function dropPlan(
  sandbox: InstallSandbox,
  planId: string,
  opts: PlanFixtureOptions = {},
): string {
  const planPath = path.join(
    planDir(sandbox.dataDir, "personal", opts.app ?? "jarvis"),
    `${planId}.md`,
  );
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, planFixture(opts));
  return planPath;
}
