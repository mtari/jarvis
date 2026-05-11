import { runApprove } from "./commands/approve.ts";
import { runAsk } from "./commands/ask.ts";
import { runBacklog } from "./commands/backlog.ts";
import { runCost } from "./commands/cost.ts";
import { runDaemon } from "./commands/daemon.ts";
import { runDiscussCommand } from "./commands/discuss.ts";
import { runDocs } from "./commands/docs.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runDailyAuditCommand } from "./commands/daily-audit.ts";
import { runProjectAuditCommand } from "./commands/project-audit.ts";
import { runIdeas } from "./commands/ideas.ts";
import { runInbox } from "./commands/inbox.ts";
import { runInstall } from "./commands/install.ts";
import { runLearn } from "./commands/learn.ts";
import { runLogs } from "./commands/logs.ts";
import { runMarketer } from "./commands/marketer.ts";
import { runNotes } from "./commands/notes.ts";
import { runObserveImpact } from "./commands/observe-impact.ts";
import { runOnboard } from "./commands/onboard.ts";
import { runPlan } from "./commands/plan.ts";
import { runPlans } from "./commands/plans.ts";
import { runPosts } from "./commands/posts.ts";
import { runProfile } from "./commands/profile.ts";
import { runReject } from "./commands/reject.ts";
import { runReprioritize } from "./commands/reprioritize.ts";
import { runRevise } from "./commands/revise.ts";
import { runRun } from "./commands/run.ts";
import { runScan } from "./commands/scan.ts";
import { runScout } from "./commands/scout.ts";
import { runSignals } from "./commands/signals.ts";
import { runStatus } from "./commands/status.ts";
import { runTelemetry } from "./commands/telemetry.ts";
import { runTriage } from "./commands/triage.ts";
import {
  runSuppress,
  runSuppressions,
  runUnsuppress,
} from "./commands/suppress.ts";
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
  signals [filters]           Browse recorded signal events. Filters: --app,
                              --vault, --kind, --severity, --since <iso>,
                              --limit N, --format table|json
  learn scan [--since <iso>] [--limit N] [--format table|json]
                              Walk the feedback store + recent plan transitions,
                              surface recurring rejection / revise themes and
                              low-approval plan categories.
  learn draft [--threshold N] [--max-drafts N] [--since <iso>]
                              Run scan, then ask Strategist to draft a meta
                              plan per finding above threshold. Idempotent
                              against the last 14 days.
  marketer prepare <plan-id>  Parse an approved marketing plan's content calendar,
                              humanize each post, persist pending rows to
                              scheduled_posts. Idempotent.
  posts list [--plan <id>] [--app <name>] [--status <s>] [--limit N] [--format table|json]
                              Inspect scheduled_posts rows.
  posts edit <post-id> --inline "<text>" | --file <path>
                              Replace a pending row's content; appends to
                              edit_history. Refuses on already-published rows.
  posts skip <post-id> --reason "<text>"
                              Mark a row as skipped — scheduler won't publish it.
  posts approve <post-id>     Flip an awaiting-review row (single-post plans)
                              to pending so the daemon will publish it.
  posts publish-due [--limit N]
                              Manually fire one publisher tick: pick up due
                              pending rows, publish through registered channel
                              adapters, update statuses. The daemon does this
                              automatically every ~60s when running.
  ideas add [--vault <v>]     Conversational interview that captures one new
                              idea, then appends a structured section to
                              Business_Ideas.md. Pulls out the signal Scout
                              uses to score (strategic fit, effort, impact,
                              dependencies) so scoring isn't guesswork.
  ideas list [--format table|json]
                              List every idea with its score, sorted high
                              score first (unscored last). Marks ideas that
                              already have an auto-drafted plan.
  scout score [--vault <v>]   Score unscored ideas in Business_Ideas.md. Writes
                              score, scoredAt, rationale back to the file and
                              records an idea-scored event per idea.
  scout draft [--threshold N] [--vault <v>]
                              Auto-draft a Strategist plan for each idea scoring
                              ≥ threshold (default 80). Idempotent per idea.
  observe-impact <plan-id> [--vault <name>]
                              Post-merge check: re-runs the analyst collectors
                              against the plan's app and transitions the plan
                              to success/null-result based on whether the
                              original signal still fires. Plan must be in
                              status "shipped-pending-impact".
  suppress <pattern> [--reason "..."] [--expires <iso>]
                              Mute auto-draft for matching signals. Pattern may use
                              glob wildcards (* zero+ chars, ? one char). Examples:
                                yarn-audit:CVE-2026-1234  (exact)
                                yarn-audit:CVE-2026-*     (CVE family)
  unsuppress <pattern-id>     Clear an active suppression
  suppressions [--all]        List active suppressions (--all includes cleared)
  suppressions cleanup [--older-than N]
                              Hard-delete cleared/expired rows (default 90d retention)
  status                      Daemon status, plan counts, last agent call
  notes <app> [--vault <v>] [--append "<text>"]
                              Free-text project notes. With --append, append a
                              timestamped entry; without, open in $EDITOR.
                              Read by Strategist / Scout / Developer for context.
  docs list --app <name> [--vault <v>] [--format table|json]
                              List registered docs for an app.
  docs add --app <name> [--keep] <path-or-url> [--title <t>] [--tags <a,b,c>]
                              Without --keep (absorb mode): Strategist drafts
                              an improvement/meta plan proposing brain changes
                              from the doc; review via the standard plan flow.
                              With --keep (cache mode): full content kept on
                              disk for on-demand reference.
  docs remove --app <name> <id> [--vault <v>]
                              Unregister a doc. Cache files are removed;
                              anything already absorbed into the brain stays.
  ask "<text>"                Translate a natural-language request into one of
                              the supported Jarvis commands and run it.
                              Example: ask "what is on fire?" runs triage.
  discuss --app <name> [--vault <v>] "<topic>"
                              Multi-turn co-owner conversation. Outcomes:
                              draft a plan, save an idea, append a note,
                              create a setup task, or close without one.
  triage [--format markdown|json] [--window-days N]
                              Portfolio summary: critical signals, pending
                              reviews, stuck plans, quiet apps, expiring
                              suppressions. Default 7-day window.
  telemetry [--since <iso>] [--format table|json]
                              System-quality metrics over a window: plan
                              transitions, override rate per plan-type,
                              average revise rounds, escalation count,
                              learning-loop activity.
  daily-audit [--dry-run] [--force] [--format table|json]
                              Manual trigger for the Strategist daily
                              self-audit. Daemon runs hourly; the audit's
                              own 24h idempotency holds it to once per day.
                              --dry-run records the audit but skips
                              Strategist; --force bypasses throughput +
                              idempotency gates.
  project-audit --app <name> | --all [--dry-run] [--force]
                              Daily Strategist audit for each onboarded app
                              (excluding jarvis). Gates: app-paused, already-
                              ran-recently (24h), backlog-full (3-plan cap),
                              no-context (no events in 7d). --force bypasses
                              app-paused, already-ran-recently, no-context.
                              --dry-run records event but skips Strategist.
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
    case "ask":
      return runAsk(rest, { dispatch });
    case "discuss":
      return runDiscussCommand(rest);
    case "docs":
      return runDocs(rest);
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
    case "notes":
      return runNotes(rest);
    case "scan":
      return runScan(rest);
    case "signals":
      return runSignals(rest);
    case "ideas":
      return runIdeas(rest);
    case "scout":
      return runScout(rest);
    case "learn":
      return runLearn(rest);
    case "marketer":
      return runMarketer(rest);
    case "posts":
      return runPosts(rest);
    case "observe-impact":
      return runObserveImpact(rest);
    case "status":
      return runStatus(rest);
    case "telemetry":
      return runTelemetry(rest);
    case "triage":
      return runTriage(rest);
    case "suppress":
      return runSuppress(rest);
    case "unsuppress":
      return runUnsuppress(rest);
    case "suppressions":
      return runSuppressions(rest);
    case "daily-audit":
      return runDailyAuditCommand(rest);
    case "project-audit":
      return runProjectAuditCommand(rest);
    case "version":
      return runVersion(rest);
    default:
      process.stderr.write(`jarvis: unknown command "${command}"\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
