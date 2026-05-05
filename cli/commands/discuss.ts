import { parseArgs } from "node:util";
import { runDiscuss, DiscussError } from "../../agents/discuss.ts";
import { brainExists } from "../../orchestrator/brain.ts";
import {
  createSdkClient,
  type AnthropicClient,
} from "../../orchestrator/agent-sdk-runtime.ts";
import { buildAgentCallRecorder } from "../../orchestrator/anthropic-instrument.ts";
import { loadEnvFile } from "../../orchestrator/env-loader.ts";
import {
  createStdinPrompter,
  type Prompter,
} from "../../agents/strategist.ts";
import { brainFile, dbFile, envFile, getDataDir } from "../paths.ts";

/**
 * `yarn jarvis discuss --app <name> [--vault <v>] "<topic>"`
 *
 * Opens a multi-turn co-owner conversation with Jarvis. Outcomes:
 * draft a plan, save an idea, append a note, create a setup task,
 * or close without an artifact.
 */

export interface DiscussCommandDeps {
  client?: AnthropicClient;
  prompter?: Prompter;
}

export async function runDiscussCommand(
  rawArgs: string[],
  deps: DiscussCommandDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        app: { type: "string" },
        vault: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`discuss: ${(err as Error).message}`);
    return 1;
  }

  const app = parsed.values.app;
  const vault = parsed.values.vault ?? "personal";
  if (!app) {
    console.error(
      'discuss: --app is required. Usage: yarn jarvis discuss --app <name> "<topic>"',
    );
    return 1;
  }
  const topic = parsed.positionals.join(" ").trim();
  if (topic.length === 0) {
    console.error(
      'discuss: topic required. Usage: yarn jarvis discuss --app <name> "<topic>"',
    );
    return 1;
  }

  const dataDir = getDataDir();
  loadEnvFile(envFile(dataDir));

  if (!brainExists(brainFile(dataDir, vault, app))) {
    console.log(
      `discuss: app "${app}" in vault "${vault}" has no brain yet — discussing without project context. Onboard with \`yarn jarvis onboard --app ${app}\` first if you want grounded answers.`,
    );
  }

  const baseClient: AnthropicClient = deps.client ?? createSdkClient();
  const recorder = buildAgentCallRecorder(baseClient, dbFile(dataDir), {
    app,
    vault,
    agent: "strategist",
    mode: "subscription",
  });
  const prompter = deps.prompter ?? createStdinPrompter();

  try {
    const result = await runDiscuss({
      client: recorder.client,
      app,
      vault,
      dataDir,
      topic,
      prompter,
    });
    recorder.flush();

    console.log("");
    console.log(`Conversation ${result.conversationId}: ${result.outcome}`);
    if (result.refId) console.log(`  Ref: ${result.refId}`);
    console.log(`  Turns: ${result.turns}`);
    return 0;
  } catch (err) {
    recorder.flush();
    if (err instanceof DiscussError) {
      console.error(`discuss: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
