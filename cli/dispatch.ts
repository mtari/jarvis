import { runApprove } from "./commands/approve.ts";
import { runBacklog } from "./commands/backlog.ts";
import { runCost } from "./commands/cost.ts";
import { runDaemon } from "./commands/daemon.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInbox } from "./commands/inbox.ts";
import { runInstall } from "./commands/install.ts";
import { runLogs } from "./commands/logs.ts";
import { runOnboard } from "./commands/onboard.ts";
import { runPlan } from "./commands/plan.ts";
import { runPlans } from "./commands/plans.ts";
import { runProfile } from "./commands/profile.ts";
import { runReject } from "./commands/reject.ts";
import { runReprioritize } from "./commands/reprioritize.ts";
import { runRevise } from "./commands/revise.ts";
import { runRun } from "./commands/run.ts";
import { runScan } from "./commands/scan.ts";
import { runStatus } from "./commands/status.ts";
import { runVersion } from "./commands/version.ts";

const HELP = `jarvis — autonomous agent system

Usage: yarn jarvis <command> [options]

Setup & lifecycle:
  install [--data-dir <path>] [--remote <url>]
                              First-time setup
  daemon                      Start the long-running local process
  doctor                      Health check
  profile                     Show user profile summary
  profile edit                Open user-profile.json in $EDITOR
  onboard --app <name> --repo <abs-path> [--monorepo-path <subdir>] [--vault <name>] [--docs <path-or-url>]... [--docs-keep <path-or-url>]... [--move-docs]
                              Bring a new app under Jarvis (--move-docs deletes local source docs after a successful onboard; URL docs untouched)

Plans:
  plans [filters]             List plans (filters: --app, --status, --type,
                              --subtype, --priority, --executing, --approved,
                              --pending-review, --format table|json, --limit N)
  plan --app <name> [--type improvement|business|marketing] [--subtype <s>] [--vault <v>] [--no-challenge] "<brief>"
                              Draft a new plan via Strategist
  backlog --app <name> [--meta-only | --no-meta]
                              Show product backlog (3-cap) + meta queue
  reprioritize --app <name> --plan <id> --priority <level>
                              Reorder a backlog plan (low|normal|high|blocking)
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
  cost [--cap N] [--warn-at R] [--format table|json]
                              Current-month token spend, cache hit rate, by agent / plan / model
  logs tail [--file <path>]   Stream today's daemon log (tail -f). Use --file
                              to override the log path.
  scan --app <name> [--vault <v>]
                              Run signal collectors against an onboarded app.
                              Records each finding as a 'signal' event.
                              Exits non-zero on any high/critical severity.
  status                      Daemon status, plan counts, last agent call
  version                     Print Jarvis version
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
    case "daemon":
      return runDaemon(rest);
    case "onboard":
      return runOnboard(rest);
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
    case "backlog":
      return runBacklog(rest);
    case "reprioritize":
      return runReprioritize(rest);
    case "run":
      return runRun(rest);
    case "cost":
      return runCost(rest);
    case "logs":
      return runLogs(rest);
    case "scan":
      return runScan(rest);
    case "status":
      return runStatus(rest);
    case "version":
      return runVersion(rest);
    default:
      process.stderr.write(`jarvis: unknown command "${command}"\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
