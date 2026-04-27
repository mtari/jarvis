import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { loadProfile } from "../../orchestrator/profile.ts";
import { getDataDir, profileFile } from "../paths.ts";

export async function runProfile(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];
  const dataDir = getDataDir();
  const filePath = profileFile(dataDir);

  if (!fs.existsSync(filePath)) {
    console.error(
      `profile: no profile at ${filePath}. Run 'yarn jarvis install' first.`,
    );
    return 1;
  }

  if (subcommand === "edit") {
    const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
    execFileSync(editor, [filePath], { stdio: "inherit" });
    return 0;
  }

  if (subcommand !== undefined && subcommand !== "show") {
    console.error(
      `profile: unknown subcommand "${subcommand}". Try 'profile' or 'profile edit'.`,
    );
    return 1;
  }

  const profile = loadProfile(filePath);
  const lines: string[] = [];
  lines.push(`User profile (schemaVersion ${profile.schemaVersion})`);
  lines.push(`  Path: ${filePath}`);
  lines.push(`  Identity:`);
  lines.push(`    Name: ${render(profile.identity.name)}`);
  lines.push(`    Timezone: ${render(profile.identity.timezone)}`);
  lines.push(`    Locale: ${render(profile.identity.locale)}`);
  lines.push(`    Role: ${render(profile.identity.role)}`);
  lines.push(`  Goals:`);
  lines.push(`    Primary: ${render(profile.goals.primary)}`);
  lines.push(`    Horizon: ${render(profile.goals.horizon)}`);
  lines.push(`  Preferences:`);
  lines.push(`    Response style: ${render(profile.preferences.responseStyle)}`);
  lines.push(`    Plan verbosity: ${render(profile.preferences.planVerbosity)}`);
  lines.push(`    Review rhythm: ${render(profile.preferences.reviewRhythm)}`);
  lines.push(`    Language rules: ${renderList(profile.preferences.languageRules)}`);
  lines.push(`    Global exclusions: ${renderList(profile.preferences.globalExclusions)}`);
  console.log(lines.join("\n"));
  return 0;
}

function render(value: string): string {
  return value === "" ? "<empty>" : value;
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "<empty>" : values.join(", ");
}
