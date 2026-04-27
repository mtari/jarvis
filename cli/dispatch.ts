import { runApprove } from "./commands/approve.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInbox } from "./commands/inbox.ts";
import { runInstall } from "./commands/install.ts";
import { runPlan } from "./commands/plan.ts";
import { runPlans } from "./commands/plans.ts";
import { runProfile } from "./commands/profile.ts";
import { runReject } from "./commands/reject.ts";
import { runRevise } from "./commands/revise.ts";
import { runRun } from "./commands/run.ts";

const HELP = `jarvis — autonomous agent system

Usage: yarn jarvis <command> [options]

Setup & lifecycle:
  install [--data-dir <path>] [--remote <url>]
                              First-time setup
  doctor                      Health check
  profile                     Show user profile summary
  profile edit                Open user-profile.json in $EDITOR

Plans:
  plans [filters]             List plans (filters: --app, --status, --type,
                              --subtype, --priority, --executing, --approved,
                              --pending-review, --format table|json)
  plan --app <name> [--type improvement] [--subtype <s>] [--vault <v>] [--no-challenge] "<brief>"
                              Draft a new plan via Strategist
  approve <id> [--confirm-destructive]
                              Approve a plan
  revise <id> "<feedback>"    Send back to draft with feedback
  reject <id> [--category <cat>] [--note "..."]
                              Reject a plan

Inbox:
  inbox                       Show pending plan reviews + setup tasks

Utilities:
  run developer <plan-id>     Fire Developer (auto-detects: draft impl plan vs execute)
  run <agent> <task>          Other agents not yet wired (Phase 1+)
  help, --help, -h            Show this message

For full reference see docs/MASTER_PLAN.md §17.
`;

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
    case "doctor":
      return runDoctor(rest);
    case "plans":
      return runPlans(rest);
    case "inbox":
      return runInbox(rest);
    case "approve":
      return runApprove(rest);
    case "revise":
      return runRevise(rest);
    case "reject":
      return runReject(rest);
    case "plan":
      return runPlan(rest);
    case "run":
      return runRun(rest);
    default:
      process.stderr.write(`jarvis: unknown command "${command}"\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
