import { runInstall } from "./commands/install.ts";
import { runProfile } from "./commands/profile.ts";
import { runStub } from "./commands/stubs.ts";

const HELP = `jarvis — autonomous agent system

Usage: yarn jarvis <command> [options]

Setup & lifecycle:
  install [--data-dir <path>] [--remote <url>]
                              First-time setup
  doctor                      Health check (stub — M2 follow-up)
  profile                     Show user profile summary
  profile edit                Open user-profile.json in $EDITOR

Plans:
  plans [filters]             List plans (stub — M2 follow-up)
  plan --app <name> "<brief>" Draft a new plan (stub — M4)
  approve <id>                Approve a plan (stub — M2 follow-up)
  revise <id> "<note>"        Send back to draft (stub — M2 follow-up)
  reject <id>                 Reject a plan (stub — M2 follow-up)

Inbox:
  inbox                       Show pending reviews (stub — M2 follow-up)

Utilities:
  run <agent> <task>          Direct agent invocation (stub — M3+)
  help, --help, -h            Show this message

For full reference see docs/MASTER_PLAN.md §17.
`;

const STUB_COMMANDS = new Set([
  "doctor",
  "inbox",
  "plans",
  "approve",
  "revise",
  "reject",
  "plan",
  "run",
]);

export async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "install":
      return runInstall(rest);
    case "profile":
      return runProfile(rest);
    default:
      if (STUB_COMMANDS.has(command)) {
        return runStub(command);
      }
      process.stderr.write(`jarvis: unknown command "${command}"\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
