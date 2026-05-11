# 🤖 Jarvis — Master Plan

> **Status:** Planning phase complete. Ready for Phase 0 implementation.
> **Core pattern:** idea → plan → your review → autonomous execution.

---

## 📑 Contents

1. [Vision](#1-vision)
2. [How you interact with Jarvis](#2-how-you-interact-with-jarvis)
3. [Agent roster](#3-agent-roster)
4. [The plan artifact](#4-the-plan-artifact)
5. [Plan types](#5-plan-types)
6. [Execution model](#6-execution-model)
7. [Memory model](#7-memory-model)
8. [Analyst: signals & post-merge observation](#8-analyst-signals--post-merge-observation)
9. [Scout: research, triage, idea scoring](#9-scout-research-triage-idea-scoring)
10. [Setup & connections](#10-setup--connections)
11. [Review cadence](#11-review-cadence)
12. [Escalate-within-plan](#12-escalate-within-plan)
13. [Safety rules](#13-safety-rules)
14. [Tech stack](#14-tech-stack)
15. [Repository layout](#15-repository-layout)
16. [Phased build plan](#16-phased-build-plan)
17. [CLI reference](#17-cli-reference)
18. [Resource model](#18-resource-model)
19. [Open items](#19-open-items)

---

## 1. Vision

A multi-agent system that acts as a **thinking partner, autonomous workforce, and content collaborator** across the user's full portfolio: side-project apps, an IT consulting business, and personal-brand content (focus: Hungarian IT sector). Goal: **replace day-job income** through the combined portfolio, not a single product.

**Two-way collaboration.** Jarvis proposes work autonomously _and_ you can hand off ad-hoc: share half-formed ideas, ask Jarvis to do things, discuss without committing to a plan, hand off content for review, or build on your draft. The plan-review pattern remains the gate for autonomous execution; open discussion and content review run alongside it.

Core properties:

- **One pattern for autonomous work:** idea → plan → your review → autonomous execution.
- **Chat alongside plans:** discussion and content-review modes don't require a plan (see §2 → Open channels).
- **Narrow gates:** you review plans, merge PRs, and handle setup tasks. Everything else the system does autonomously.
- **Portfolio-native:** cross-project triage spans apps + consulting + personal brand. Each is treated as a project with its own brain; Scout's weekly triage ranks across the whole portfolio.
- **Self-improving:** Jarvis proposes improvement plans against its own code through the same mechanism.

Non-goals:

- Not a team collaboration tool — single-user by design.
- Not autonomous on irreversible actions (merges to main, business pivots, destructive ops).
- Not a replacement for human judgment on strategic calls.

---

## 2. How you interact with Jarvis

**Four plan-centric interaction types** govern autonomous execution. **Two open channels** support free-form collaboration without committing to a plan.

| #   | Type                      | When it happens                                                                                                          | What you do                                                     |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | **Plan review**           | Agent has drafted a plan (business, improvement, or marketing) — triggered by an Analyst signal **or** your direct brief | Approve, reject, or request modification                        |
| 2   | **Setup task**            | A plan needs a connection/credential you haven't provided (Facebook, Instagram, Postmark, API keys, DNS, OAuth)          | Complete the setup in your chosen tool, mark done               |
| 3   | **Plan amendment review** | Mid-execution, the Developer/Marketer discovered the plan was wrong (missing dep, scope error, API changed)              | Approve amendment, reject, or modify                            |
| 4   | **Escalation**            | Unexpected block or break the system can't resolve                                                                       | Decide path forward; often becomes an amendment or a setup task |

All four surface in your Slack inbox (Phase 1+) or CLI (`yarn jarvis inbox`, Phase 0). Slack is split: `#jarvis-inbox` for routine, `#jarvis-alerts` for escalations.

### How plans get initiated

Plans are drafted by the Strategist via two paths, both converging on the same review experience (type 1):

- **User-initiated.** You state an intent:
  - CLI: `yarn jarvis plan --app erdei-fahazak "Add booking calendar"`
  - Slack: `/jarvis plan erdei-fahazak Add booking calendar`

  **Strategist does not draft blindly.** Before producing a plan, it analyses the current situation (app brain, user profile, recent metrics, active plans, past decisions) and challenges the brief with Socratic "why" questions — surfacing mismatches with your stated goals, duplicated past efforts, or data that contradicts the premise.
  - **Confident path:** intent is clear and well-grounded → Strategist drafts directly. The `## Problem` section records the why-chain it inferred.
  - **Clarification path:** ambiguity or dissonance remains → Strategist asks 1–3 clarifying questions (Slack thread or CLI prompt). You answer → it redrafts or proceeds. Up to 3 rounds; beyond that it drafts with best-effort assumptions under `## Open questions / assumptions`. Each Q/A round is logged to the feedback store (§7 → Feedback store) and feeds the learning loop.

  (Amendment clauses remain reserved for execution-time pause conditions, not draft-time assumptions.)

- **Signal-initiated.** Analyst detects a signal crossing its trigger threshold → asks Strategist to draft a plan → plan review surfaces in your inbox.
- **Bug-initiated.** You hit a bug during manual testing (of a PR or in production). Report it via `yarn jarvis bug --app <name> "<description>" [--repro <file>] [--expected "..."] [--actual "..."] [--severity high|normal|low] [--related-plan <id>]` or `/jarvis bug <app> ...` in Slack. Strategist drafts a `subtype: bugfix` improvement plan; severity maps to priority (`high` → `blocking`, `normal` → `high`, `low` → `normal`). The bug report is logged in the feedback store and, if related to a recently-shipped plan, counted toward Developer's bug-rate telemetry — frequent bugs against the same Developer-run plan class become a learning signal.

### Open channels (no plan commitment)

Four modes operate outside the plan-review flow. All feed the feedback store (§7) so they still inform learning.

- **Discussion (`discuss`).** Multi-turn, multi-agent, multi-output conversation — the way two co-owners talk in a meeting. Strategist leads, Scout pulled in for ideation, Analyst pulled in for facts, Marketer pulled in for content angles. Possible outcomes: a refined brief, an auto-drafted plan, an idea added to `Business_Ideas.md`, a note appended (see below), a setup task created, or just "we talked it through." Each conversation is logged as a `conversation` event. Turn cap 20 with an explicit "wrap this up" exit at any point.
  - CLI: `yarn jarvis discuss --app <name>`
  - Slack: `/jarvis discuss <app> "<topic>"` opens a thread; replies in the thread continue the conversation.
- **Free-text notes.** Each app has a `notes.md` at `<dataDir>/vaults/<vault>/brains/<app>/notes.md` — a free-text whiteboard the user appends to whenever, that Strategist / Scout / Developer all read into their context. Mental model: the meeting whiteboard for the project; the brain (§7) stays the structured spec.
  - CLI: `yarn jarvis notes <app> [--append "..."]` (no `--append` opens `$EDITOR`)
  - Slack: `/jarvis notes <app> <text>` appends with timestamp + author.
- **Natural-language commands (`ask`).** Translate free-text requests like "what's on fire?" or "show me last week's signals for erdei-fahazak" into the underlying CLI commands. Single LLM call routes the intent; ambiguous requests get a clarifying question rather than a guess. Destructive ops (approve / reject / cancel) require an explicit button confirm before execution.
  - CLI: `yarn jarvis ask "<text>"`
  - Slack: `/jarvis ask "<text>"`
- **Content review.** Hand Jarvis a draft (post, blog, video script, newsletter) for critique — voice, structure, persuasion, accuracy, alignment with brand + user-profile voice. Marketer (with Strategist where relevant) returns annotated feedback or a proposed rewrite (humanized per §13). No plan is created; the result is a critique you act on yourself.
  - CLI: `yarn jarvis review-content --app <name> [--file <path> | --inline "<text>"] [--format post|blog|video-script|newsletter]`
  - Slack: paste content in DM with `/jarvis review`, or react to a Slack message with the `:jarvis-review:` emoji.

---

## 3. Agent roster

Six agents. Clear role boundaries.

| Agent          | Role                  | Primary outputs                                                                                    |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| **Jarvis**     | Orchestrator          | Routes work, owns memory, owns connection inventory, owns setup queue, single user contact         |
| **Analyst**    | Reactive signal layer | Stats, anomalies, security/dep watches, post-merge observation, financial tracking, self-telemetry |
| **Scout**      | Proactive discovery   | Market & trend research, competitor monitoring, idea generation + scoring, weekly portfolio triage |
| **Strategist** | Plan author           | Business plans, improvement plans, marketing plans, plan amendments                                |
| **Developer**  | Executor (code)       | Feature branches, commits, PRs with manual-test instructions, test suites                          |
| **Marketer**   | Executor (campaign)   | Post drafts, scheduled content, campaign tracking                                                  |

### Roster rationale

Earlier drafts considered up to 10 agents with a dedicated scrum master, business analyst, context provider, research agent, stats agent, tester, and a synchronous review gate. That's enterprise ceremony for a solo founder. The current roster covers every need because:

- **Jarvis** folds in memory management and context assembly.
- **Analyst** owns reactive work (what's happening) — stats, security, post-merge observation.
- **Scout** owns proactive work (what could happen) — research, idea scoring, portfolio triage. Split from Analyst because reactive and proactive have genuinely different shapes: data-in/triggers-out vs hypothesis-in/opportunities-out.
- **Strategist** covers business planning, requirements, and plan authorship. **Challenges every user brief Socratically** before drafting (see §2 → Clarification path): examines brain + profile + signals + history, asks "why" until the underlying intent is grounded. Never accepts briefs blindly. Sprints are gone, so no scrum master either.
- **Developer** includes test authoring; tests are part of any improvement plan, not a separate agent's concern.
- The review "gate" is replaced by the plan-review pattern — you review one page, not every action.

### Agent permissions

| Resource                                            | Jarvis | Analyst | Scout |                                    Strategist                                     |                            Developer                             |     Marketer      |
| --------------------------------------------------- | :----: | :-----: | :---: | :-------------------------------------------------------------------------------: | :--------------------------------------------------------------: | :---------------: |
| Read repo                                           |   ✅   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |
| Write feature branch                                |   ❌   |   ❌    |  ❌   |                                        ❌                                         |                                ✅                                |        ❌         |
| Open PR                                             |   ❌   |   ❌    |  ❌   |                                        ❌                                         |                                ✅                                |        ❌         |
| Merge to main                                       |   ❌   |   ❌    |  ❌   |                                        ❌                                         |                                ❌                                |        ❌         |
| Read brains                                         |   ✅   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |
| Read user profile                                   |   ✅   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |
| Propose user-profile update                         |   ❌   |   ❌    |  ❌   |                             ✅ (via improvement plan)                             |                                ❌                                |        ❌         |
| Write brain — metrics & signals                     |   ❌   |   ✅    |  ❌   |                                        ❌                                         |                                ❌                                |        ❌         |
| Write brain — research, ideas, priorities           |   ❌   |   ❌    |  ✅   |                                        ❌                                         |                                ❌                                |        ❌         |
| Write brain — connections                           |   ✅   |   ❌    |  ❌   |                                        ❌                                         |                                ❌                                |        ❌         |
| Write brain — initial onboarding draft              |   ❌   |   ❌    |  ❌   |                    ✅ (once per app, during `jarvis onboard`)                     |                                ❌                                |        ❌         |
| Propose brain update (post-onboarding)              |   ❌   |   ❌    |  ❌   | ✅ (via improvement plan — triggered by `docs add`, learning loop, or user brief) |                                ❌                                |        ❌         |
| Write setup queue (`jarvis-data/setup-queue.jsonl`) |   ✅   |   ❌    |  ❌   |                            ✅ (pre-flight auto-queue)                             |                                ❌                                |        ❌         |
| Write plans (`jarvis-data/plans/**`)                |   ❌   |   ❌    |  ❌   |                       ✅ (business, improvement, marketing)                       | ✅ (implementation only — child of an approved improvement plan) |        ❌         |
| Append event log                                    |   ✅   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |
| Call external APIs (read)                           |   ❌   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |
| Call external APIs (write)                          |   ❌   |   ❌    |  ❌   |                                        ❌                                         |              ✅ (git push + GitHub PR/comment API)               | ✅ (social posts) |
| Surface inbox item                                  |   ✅   |   ✅    |  ✅   |                                        ✅                                         |                                ✅                                |        ✅         |

**Nobody merges to main.** Only you do.

> **Slack posting is orchestration, not a capability.** All agents ✅ "Surface inbox item"; Jarvis (orchestrator) translates surfaced items into Slack messages via the Slack adapter. No agent posts to Slack directly.

---

## 4. The plan artifact

Every plan is a markdown file. Three sub-templates — one per plan type — share a common envelope (front-matter + closing sections) and differ in the body. Plans run as long as the work needs: every subsystem named, rollback at a level a different engineer could execute against, every call-site or interface that the change touches enumerated. The earlier "one-page max" cap was relaxed in Phase 2.5 (§16) — short plans hide detail and miss subsystems; long plans surface them, even if review takes longer. The voice rules (terse, active, no padding, no rule-of-three) still apply at every length.

Plans live in `jarvis-data/plans/[app]/[plan-id].md` (git-tracked in the data repo). Template files live in `jarvis/plan-templates/` (git-tracked in the code repo — they ship with Jarvis).

**Plan ID format:** `YYYY-MM-DD-<slug>` — date-prefixed for chronological sort + human-readable slug derived from the plan title (lowercase, hyphenated, ≤40 chars after the date). Collisions on the same date append `-2`, `-3`, etc. Examples: `2026-04-27-add-status-command`, `2026-05-03-rework-plan-state-machine`. Filenames double as plan IDs in CLI commands and front-matter — no separate ID field, no UUIDs to copy around. Implementation plans use the parent ID with an `-impl` suffix: `2026-04-27-add-status-command-impl.md`.

### Shared envelope (all plan types)

**Front-matter** — every plan starts with:

```
# Plan: [title]
Type: business | improvement | marketing | implementation
Subtype: improvement → new-feature | rework | refactor | security-fix | dep-update | bugfix | meta ; marketing → campaign | single-post
ParentPlan: (implementation only) <improvement-plan-id>
ImplementationReview: (improvement only) required | skip | auto  ← default auto: required for new-feature/rework, skip otherwise
App: [app-name or "jarvis" for self-improvement]
Priority: low | normal | high | blocking
Destructive: true | false  ← true requires extra confirmation on approval (see §13)
Status: draft | awaiting-review | approved | executing | paused | blocked | cancelled | done | rejected | shipped-pending-impact | success | null-result | regression
Author: [agent name]
Confidence: [0-100] — [rationale]
```

**Closing sections** — every plan ends with:

```
## Success metric
- Metric: [e.g., "weekly signups on erdei-fahazak"]
- Baseline: [current value + source]
- Target: [absolute or directional]
- Data source: [query, dashboard, or API endpoint]

## Observation window
Defaults: business 90d, marketing/campaign = campaign duration + 15d follow-up (typical 30–45d), marketing/single-post 14d, improvement/new-feature 30d, improvement/rework 21d.
Refactor/security-fix/dep-update/bugfix/meta: no window — N/A + non-regression check only. (Meta covers system-level updates: brain-field extensions, user-profile updates, agent-prompt tweaks.)

## Connections required
- [Connection]: [status — present / missing / needs-refresh]

## Rollback
How to undo this if it goes wrong. Every plan must have one.

## Estimated effort
- Claude calls: [ballpark]
- Your review time: [minutes]
- Wall-clock to ship: [hours or days]

## Amendment clauses
"Pause and amend if..." list. (Execution-time pause conditions.)

## Open questions / assumptions  (optional)
Draft-time uncertainties that won't block review but may need confirmation.
E.g., "Assuming we target single-property bookings only; multi-property expands scope."
```

### Business plan body

```
## Current situation
What's true today — metrics, positioning, momentum.

## Strategy
Vision + positioning. Why this direction for the next observation window.

## Target segment
Who we're building for, specifically.

## Key initiatives
High-level moves. Individual initiatives become improvement or marketing plans.

## Measurable goals
Concrete outcomes by end of window.

## Constraints
Known limits: budget, time, connections, skills.
```

### Improvement plan body

```
## Problem
One paragraph. What signal or brief triggered this plan, AND the inferred **"why"** — the underlying intent Strategist understood after challenging the brief and checking it against current context. Future agents and amendments refer back to this reasoning.

## Build plan
Concrete. Files to change, schemas to add, components, migrations, scripts.

## Testing strategy
Unit + E2E coverage. What we test, why it's enough.

## Acceptance criteria
Bulleted, testable. Developer uses these to know they're done.
```

### Implementation plan body

Authored by **Developer** after an improvement plan is approved (when `ImplementationReview: required` or auto-resolved to required). One page, reviewed via the same approve / revise / reject flow.

```
## Approach
The technical strategy. Why this approach over alternatives Strategist's build plan considered.

## File changes
List of files to add, modify, delete — with rationale per file.

## Schema changes
DB migrations, new tables, indexes, RLS policies. Reversibility notes.

## New dependencies
Packages to add. Size, license, last-publish-date, maintenance signal.

## API surface
New endpoints, modified endpoints, deprecated endpoints. Breaking change calls.

## Testing strategy
Unit + integration + E2E coverage. What's tested, why it's enough, manual-test plan for the eventual PR.

## Risk & rollback
What could go wrong; how we'd recover. Connects to the parent plan's `## Rollback`.

## Open questions
Anything to confirm before coding. Empty when Developer is fully confident.
```

**Lifecycle interaction with parent improvement plan:**

- Improvement plan reaches `approved` (first review = the WHAT and WHY).
- If `ImplementationReview` resolves to `required`: Developer drafts an implementation plan; improvement plan stays in `approved` (not `executing`) until the implementation plan is also approved.
- Implementation plan goes through approve / revise / reject like any plan.
- On implementation approval: parent improvement plan transitions to `executing`; Developer codes per the implementation plan; opens PR.
- If implementation rejected: parent improvement plan is held; Strategist may revise the parent or you can reject it too.

### Marketing plan body

```
## Opportunity
What we're going after and why now.

## Audience
Segment, language, cultural context.

## Channels
Which platforms, in what priority.

## Content calendar
For Subtype=`campaign`: every post's **final text** (pre-humanized per §13), date, channel, asset references. This is what gets scheduled — you will not see each post again before it publishes.
For Subtype=`single-post`: the full finalized post text for this single entry.

## Schedule
When each piece goes live.

## Tracking & KPIs
What we measure during the campaign.
```

### Success metric is mandatory for

- Business plans (no business plan without a goal)
- Marketing plans (campaigns without metrics are theater)
- Improvement plans with subtype `new-feature` or `rework`

For other improvement subtypes (`refactor`, `security-fix`, `dep-update`, `bugfix`, `meta`), `N/A + non-regression check` is acceptable.

### Plan lifecycle (state machine)

```
   draft ◀──── revise (with feedback) ────┐
     │                                    │
     ▼                                    │
  awaiting-review ──reject──▶ rejected (→ suppressed §8)
     │       │
   approve   └─revise (loops back to draft, increments revision count)
     ▼
  approved
     │
     ▼
  executing ──amend──▶ awaiting-review (mid-execution; loops back)
     │
     ▼
    done → shipped-pending-impact → { success | null-result | regression }
```

**Three review actions** (was implicit; now explicit):

- **Approve** — plan moves to `approved` and execution begins.
- **Revise** — plan is kept (intent is right) but needs changes (scope, content, approach). User provides feedback; Strategist redrafts; new revision goes back to `awaiting-review`. Revision count tracked in plan metadata; loops are bounded (default 3 revisions, then escalation).
- **Reject** — plan dead. Suppression rule applies per §8 → Rejection feedback. Distinct from Revise: reject means "don't do this"; revise means "do this differently."

**Other transitions:**

- Any non-terminal state may transition to: `paused`, `blocked`, or `cancelled`. They mean different things:
  - **`paused`** — deliberately halted. Triggered by preemption (a `Priority: blocking` plan took over) or by your explicit action. Resumes automatically when the cause clears.
  - **`blocked`** — waiting on something external. Triggered by a missing connection, an external API outage, rate-limit exhaustion, or a prerequisite plan still in flight. Resumes once the external condition clears.
  - **`cancelled`** — terminated without completion. Triggered by your rejection mid-execution, or by Strategist determining the plan is no longer valid (e.g., the underlying signal was withdrawn). Terminal; does not resume.
- `amended` and `revising` are transient transitions, not rest states. Amend = mid-execution scope discovery; revise = pre-execution feedback. Both loop back through `awaiting-review`, but at different lifecycle points.
- Post-merge tags (`success` / `null-result` / `regression`) are set by Analyst at observation-window close.
- `Priority: blocking` plans preempt the currently-executing plan (pauses it) — see §6 → Preemption.
- **Meta plans** (subtype `meta`) skip `shipped-pending-impact` and transition directly `executing → done`. No observation window applies (per §4 defaults); the non-regression check happens at execution time, not post-merge.

---

## 5. Plan types & backlog

### Business plan (per app)

Slow-changing. Reviewed when it changes significantly (quarterly-ish, or when Scout proposes a pivot). Contains: vision, target customer, success metrics, current strategy, known constraints. The Strategist drafts; Scout feeds in market/competitive research; Analyst feeds in current metrics; you approve.

### Improvement plan

Covers: new feature, rework, refactor, security fix, dependency update, self-improvement to Jarvis itself. Unified type because the flow is identical. The Strategist drafts; Developer executes.

### Implementation plan (child of improvement)

Authored by **Developer** after a parent improvement plan is approved (when `ImplementationReview` resolves to `required`). Captures the technical HOW: file changes, schema changes, dependencies, API surface, testing strategy, risk + rollback. Goes through its own approve / revise / reject review. Decouples WHAT/WHY (Strategist's improvement plan) from HOW (Developer's implementation plan), so you get two distinct review checkpoints — and Developer's technical concerns surface before code is written, not as mid-flight amendments.

**When implementation review fires (default, `ImplementationReview: auto`):**

- `subtype: new-feature` → required
- `subtype: rework` → required
- `subtype: refactor | security-fix | dep-update | bugfix | meta` → skip (technical approach is constrained or obvious)

You can override per plan during the improvement-plan review by setting `ImplementationReview: required` or `skip` explicitly.

### Marketing plan

Covers: campaign or single-post output across formats: **post, blog, video-script, newsletter** (declared per entry in `Content calendar`). Strategist drafts; Marketer executes; humanizer is the final pass per §13. **Two subtypes govern how much upfront review you do and how execution behaves:**

- **`campaign`** — time-boxed, full-content. You ask for a plan covering a period ("April 2026 campaign for erdei-fahazak"). Strategist + Marketer draft the complete plan including **every post's final text** (humanized), schedule, channels, and KPIs. You review **once**. After approval, Marketer schedules every post and publishes on the dates **without per-post review**. Amendments (§12) still fire if reality changes mid-window — a post underperforms sharply, a channel API breaks, a competitor move rewrites the context.
- **`single-post`** — one post, reviewed individually. Drafted when no active campaign covers the current date, or for reactive content that sits outside an existing campaign. Each post surfaces in `#jarvis-inbox`, reviewed and approved (or rejected) before publishing. Triggered by Analyst signals ("feature X shipped, announce it"), Scout opportunities, or your direct brief.

**Which mode fires when:**

- Active `campaign` plan covers this app + today's date → posts run from the plan, no per-post review.
- No active campaign → new marketing activity becomes `single-post` plans.
- Both can coexist: monthly campaign + occasional reactive posts is normal.

**Declaring the subtype:**

- CLI: `yarn jarvis plan --app <name> --type marketing --subtype campaign "April 2026"` or `--subtype single-post "react to competitor launch"`.
- Slack: same `/jarvis plan` command with the flags in the body — e.g., `/jarvis plan erdei-fahazak --type marketing --subtype campaign April 2026`.
- Default `--type marketing` with no subtype → Strategist infers from the brief (time-boxed language → `campaign`; immediate single event → `single-post`).

### Scheduled-post persistence

Once a marketing plan is approved, Marketer **persists each scheduled post to SQLite** (`scheduled_posts` table) — not just the plan markdown. The plan markdown is the declarative source; the table is the authoritative runtime state.

Row schema: `id, plan_id, app, channel, content (humanized), assets[], scheduled_at, status (pending | published | failed | skipped | edited), published_at, published_id, failure_reason, edit_history[]`.

**Daemon scheduler** runs every ~60s, reads `pending` rows with `scheduled_at <= now()`, publishes via the channel tool, updates status. Idempotent — checks status before publishing. Failures retry with exponential backoff up to 3 times, then escalate.

**Crash / restart recovery:** on daemon start, scheduler runs immediately to catch up. Posts whose `scheduled_at + grace_window` (default 1h) has passed without publishing escalate to `#jarvis-alerts` — "Missed window: publish late / skip / reschedule?". State is durable (SQLite); no data lost on restart.

### Edit before publish (no full reject for a typo)

For single posts in review **and** for already-scheduled campaign posts not yet published: edit-then-approve is a first-class action distinct from Revise.

- **Slack:** "Edit content" button on the post review message opens a modal with current text → user edits → "Save & Approve" → the edited version is what gets published.
- **CLI:** `yarn jarvis post edit <post-id> [--file <path> | --inline "<text>"]`. For pending scheduled posts, updates the `scheduled_posts` row in place; for posts under review, updates the plan content + scheduled row on approval.
- **Diff logged** to feedback store (`kind: edit-before-publish`) so the learning loop catches systematic typo / voice corrections.
- **Post-publish edit:** if a typo is spotted after publication, `yarn jarvis post edit <post-id> --post-publish` calls the platform edit API where supported (FB, X); otherwise reports unsupported.

Reject is for "drop this entirely"; revise is "redraft scope"; **edit is "this is fine with these small fixes."**

### Configurable posting schedule

Schedule rules live in each app's brain under `marketing.scheduleRules`:

```json
"marketing": {
  "scheduleRules": {
    "default": {
      "allowedDays": ["mon", "tue", "wed", "thu", "fri"],
      "timesPerDay": 2,
      "preferredHours": ["09:00", "13:00"],
      "timezone": "Europe/Budapest",
      "minSpacingMinutes": 240,
      "blackoutDates": ["2026-12-24", "2026-12-25", "2026-12-31"]
    },
    "channels": {
      "facebook": { /* per-channel overrides */ },
      "instagram": { /* ... */ }
    }
  }
}
```

Marketer respects these rules when proposing the `## Schedule` section of any campaign plan: never schedules outside `allowedDays`, honors blackout dates, spaces posts by `minSpacingMinutes`. Per-plan overrides are allowed but require explicit approval (visible in the campaign plan review).

Edit rules anytime via `yarn jarvis profile edit` (if global) or via a meta plan against the app brain.

**No sprint plan. No sprint review.** Work flows continuously. WIP limit of 1 active feature branch per app prevents sprawl.

### Backlog — 3 improvement plans per project, always

Each project (the apps + `jarvis` itself) maintains a **target backlog depth of 3 improvement plans** — improvement plans in states `{awaiting-review, approved}`. When depth drops below 3, Scout + Strategist propose new improvement plans to top up, drawing from: Analyst signals, Scout's research + weekly triage, and your briefs.

**Scope:** the backlog rule covers **improvement plans only**, and **excludes subtype `meta`**. Marketing plans (both subtypes) and business plans flow on their own cadence and don't count toward the depth-3 cap. A project can have an active campaign, several `single-post` plans awaiting review, a meta brain-update plan queued, and still have a 3-deep improvement backlog concurrently.

**Why meta is exempt:** brain updates, user-profile updates, and agent-prompt updates (subtype `meta`, typically triggered by `docs add`, the learning loop, or observed-pattern scans) are cheap to review and system-level — they shouldn't be blocked by product-work depth or block it in turn.

**Backlog is separate from WIP.** WIP is 1 active plan per project (see §6). Backlog is what's queued next.

### Prioritization

Scout/Strategist assign an initial `Priority` using the scoring in §9 (effort-to-revenue, momentum, market opportunity, your preferences, diversity). Numeric score → `Priority` bucket mapping:

- **≥ 85** → `high`
- **60 – 84** → `normal`
- **< 60** → `low`
- **`blocking`** is never auto-assigned from scoring. Only you, or Strategist for genuine emergencies (active security CVE, production outage, compliance deadline), sets it.

You can reorder at any time:

- **CLI:** `yarn jarvis backlog --app <name>` (show), `yarn jarvis reprioritize --app <name> --plan <id> --priority <level>`
- **Slack:** the `#jarvis-inbox` weekly backlog post has reorder controls per plan.

`Priority` drives execution order when the current WIP plan closes.

### Self-improvement cadence

`jarvis` is a project like any other, target backlog depth of 3. But self-improvement generation is **gated on project throughput** — the system should be shipping project work, not burning cycles on itself.

**Rule:** Strategist tops up the `jarvis` backlog **daily**, and only when **at least one project plan has reached `shipped-pending-impact` in the past 7 days**. No project merges in the rolling 7-day window → the audit skips with `no-throughput`. Until 2026-05-10 this ran only on Fridays; the day-of-week gate was dropped to give the audit a faster feedback loop. The 24h idempotency window enforces once-per-day cadence regardless of how often the daemon ticks.

**Telemetry exceptions bypass the cadence:** circuit-breaker trip, budget > 80%, or a spike in user-override rate → auto-draft an urgent self-improvement plan immediately, regardless of day.

### Trigger summary

| Source                | When                                               | Produces                                    |
| --------------------- | -------------------------------------------------- | ------------------------------------------- |
| Analyst signal        | Threshold crossed (hourly scans)                   | Improvement plan → app backlog              |
| Scout weekly triage   | Monday 6am                                         | Ranked list → approved picks → app backlogs |
| User brief            | Anytime                                            | Plan drafted → app backlog                  |
| Post-merge regression | Analyst mid-window                                 | Rollback plan drafted                       |
| Daily self-audit      | Daily, gated on project throughput (7-day rolling) | Self-improvement plan → `jarvis` backlog    |
| Project audit         | Daily, per non-jarvis onboarded app, gated on app status + backlog depth | Improvement plan → app backlog |
| Telemetry alert       | Any time (circuit break / budget / override spike) | Urgent self-improvement plan                |

---

## 6. Execution model

### Phase 1: local only

**The daemon** — `yarn jarvis daemon` — is started manually. No OS-level autostart in Phase 1; you run it when you sit down to work, stop it when you walk away (or leave it running in a tmux/terminal tab). Trade-off: occasionally forgetting to start after a reboot costs a few hours of missed autonomous work, but no data is lost (SQLite is durable, signals accumulate when the daemon next runs).

**On start, the daemon:**

- Loads brains (SQLite at `jarvis-data/jarvis.db` + `jarvis-data/brains/*/brain.json`).
- Opens the Slack Socket Mode WebSocket.
- Writes `jarvis-data/.daemon.pid` so `yarn jarvis doctor` can detect it.
- Starts internal schedulers: hourly signal collectors; daily events-to-JSONL export + observation sampling + morning digest; Monday 6am Scout triage; daily self-audit (gated on 7-day project-throughput window — see §5); daily project-audit per non-jarvis app (gated on app status + backlog depth — see §5); weekly Umami data archival to the SQLite event log + suppression-expiry sweep.
- Resumes any in-flight plans from `jarvis-data/logs/checkpoints/`.
- Logs to `jarvis-data/logs/daemon-YYYY-MM-DD.log`.

**What still works without the daemon** (read-only CLI, no background loop):

- `yarn jarvis inbox`, `yarn jarvis plans`, `yarn jarvis cost`, `yarn jarvis timeline` — pure SQLite reads.
  - `yarn jarvis timeline [--since 24h]` shows the activity feed: "what did Jarvis do since X" — agent calls, signals collected, plan transitions, PR events.
- `yarn jarvis plan --app X "brief"` — spawns Strategist once in-process and exits; plan waits for daemon to pick it up for any further action.
- `yarn jarvis run <agent> <task> --dry-run` — Developer and Marketer support `--dry-run`: they produce the full output (diff, post content) without side effects (no git commit, no Slack/FB post). For debugging and sanity-checking agents before trusting them live.

**What breaks without it:** Slack slash commands, scheduled jobs, observation samples during off-hours, in-flight plan execution.

**Safety net:** `yarn jarvis doctor` checks daemon liveness, last scan time, last sample time, pending inbox, stale locks (see §7), **and `jarvis-data` repo sync state**: last-commit-at, ahead/behind counts vs remote, unpushed changes, oldest unpushed change. Flags `>7 days` unpushed as a yellow warning, `>30 days` as red. Auto-invoked by `inbox`/`plans` and prints `⚠️ Daemon not running. Start with 'yarn jarvis daemon'.` if appropriate.

`doctor` subcommands:

- `yarn jarvis doctor` — full health check (daemon + locks + data repo sync).
- `yarn jarvis doctor --rebuild-brain <app>` — full brain rebuild from events (see §7 update model).
- `yarn jarvis doctor --clear-stale-lock <app>` — manual fallback if auto-takeover failed.
- `yarn jarvis doctor --data` — data-repo sync detail only.

### Design for future cloud addition

Agents are invocable standalone via CLI (e.g., `jarvis run analyst --task portfolio-scan`). State lives in git-tracked files and the database, never in-process. This means we can add a cloud runner (GitHub Actions, Railway, etc.) later without rewriting agents — we'll just invoke the same CLI on a schedule.

### WIP limits

- Max 1 active feature branch per app.
- Max 1 active plan per app (other plans queue).
- Developer finishes or amends before starting another.

### Preemption by `Priority: blocking`

When a new plan with `Priority: blocking` is approved while another plan is executing for the same app:

- The current plan is moved to `paused` state with a checkpoint.
- The blocking plan runs to completion (or its own amendment/escalation).
- When the blocker closes (`done`, `rejected`, or `cancelled`), the paused plan resumes automatically from its checkpoint.
- `blocking` is reserved for real emergencies (security CVE with exploit, production outage, compliance deadline). Strategist may propose it; you approve it like any plan — but Slack labels it prominently so you see at-a-glance it preempts ongoing work.

### Meta plan execution

Meta plans (subtype `meta`) don't follow the standard Developer-PR path by default. The executor depends on the plan's target:

- **Target in `jarvis-data/**`** (`brain.json`, `user-profile.json`, `docs.json` entries, threshold fields): **Jarvis (orchestrator)** applies the change directly after approval, commits to the data repo if git-tracked, and emits a plan-transition event. No PR — these are config-style writes, not code.
- **Target in `jarvis/**`** (agent prompts under `jarvis/prompts/`, tool code, migrations): **Developer** opens a PR in the code repo with the proposed change. You review and merge like any other code change.

A single meta plan can have mixed targets (e.g., update a brain field AND tweak a prompt); the plan's `## Build plan` lists each target, and each appropriate executor handles its slice. Jarvis applies its direct writes only after any code-side PR has merged — so state stays consistent across repos.

### Checkpointing

Every agent step writes a checkpoint to `jarvis-data/logs/checkpoints/[plan-id].json`:

- current phase
- partial outputs
- what's left
- any external calls made (for idempotency)

Resume = read checkpoint, continue. Crashes don't lose more than the current step.

---

## 7. Memory model

### Per-project brain (derived state)

`jarvis-data/brains/[app]/brain.json` — compact, current-state snapshot. (Path is shorthand; the actual file lives under the project's vault — see §15 → Path convention.)

**Update model:** each event type maps to a specific incremental brain-field update applied in the same SQLite transaction as the event append (e.g., a metric-observation event updates `metrics.latest`; a plan-transition event updates `wip.activePlanId`). Cheap per-event.

**Full rebuild** (scan all events for the app, regenerate brain from scratch) runs only on: daemon start, schema migration, or explicit `yarn jarvis doctor --rebuild-brain <app>`. This keeps steady-state writes fast while still giving us a durable recovery path.

Contains:

```json
{
  "schemaVersion": 1,
  "projectName": "...",
  "projectType": "app | consulting | personal-brand | other",
  "projectStatus": "active | maintenance | paused",
  "projectPriority": 1,
  "stack": { ... },
  "brand": { ... },
  "conventions": { ... },
  "scope": {
    "userTypes": ["primary user persona descriptions"],
    "primaryFlows": ["one-line summaries of the main user journeys / capabilities"],
    "domainRules": ["constraints, business rules, scope limits, opinionated decisions"]
  },
  "features": ["distinct feature / capability strings (optional flat list)"],
  "userPreferences": {
    "voiceOverrides": ["Hungarian informal (tegező) for wedding-planner copy"],
    "areasOfInterest": ["bookings", "SEO"],
    "areasToAvoid": ["anything requiring legal review without me in the loop"],
    "energyHints": ["prefers refactor plans on Sundays, feature plans mid-week"]
  },
  "connections": {
    "facebook": { "status": "connected", "tokenExpiresAt": "...", "capabilities": ["post", "ads"] },
    "instagram": { "status": "missing" }
  },
  "priorities": [{ "id": "...", "title": "...", "score": 85, "source": "signal:signupsDrop" }],
  "alertThresholds": { ... },
  "wip": { "activePlanId": "...", "activeBranch": "..." },
  "metrics": { "latest": { ... } },
  "businessPlanId": "plans/app/business-2026-Q2.md"
}
```

### User profile (global, cross-cutting)

`jarvis-data/user-profile.json` — **a single profile every agent reads.** Contains your identity, personality, goals, preferences, strategies, history, and observed patterns. Applied everywhere: plan drafting, portfolio scoring, post tone, thresholds, style.

**Structure** (abbreviated):

```json
{
  "schemaVersion": 1,
  "identity": {
    "name": "...",
    "timezone": "Europe/Budapest",
    "locale": "hu/en",
    "role": "solo founder",
    "technicalBackground": "..."
  },
  "personality": {
    "workStyle": "...",
    "communicationStyle": "...",
    "decisionStyle": "...",
    "riskTolerance": "..."
  },
  "goals": {
    "primary": "replace day-job income",
    "horizon": "24 months",
    "constraints": ["..."]
  },
  "preferences": {
    "responseStyle": "terse, no fluff",
    "planVerbosity": "one-page",
    "reviewRhythm": "daily + Sunday deep slot",
    "languageRules": ["..."],
    "globalExclusions": [
      "never touch auth without me",
      "no destructive DB ops without explicit `Destructive: true` and second confirmation"
    ]
  },
  "strategies": {
    "portfolio": "...",
    "marketing": "...",
    "development": "..."
  },
  "history": {
    "stackFamiliarity": ["Next.js", "Drizzle", "Supabase"],
    "appsShipped": ["..."],
    "pastDecisions": [{ "date": "...", "decision": "...", "rationale": "..." }]
  },
  "observedPatterns": {
    "rejectionReasons": ["..."],
    "approvedPatterns": ["..."],
    "brandVoiceNotes": ["..."]
  }
}
```

**Who uses it:**

- **Strategist** — plans respect your style, risk tolerance, constraints.
- **Scout** — portfolio scoring's "fit" component draws from `goals` + `preferences`.
- **Marketer** — tone, voice, cultural context.
- **Developer** — user-facing text respects language rules + voice preferences.
- **Analyst** — threshold tuning adapts to `observedPatterns`.
- **Jarvis** — assembles the profile summary into every agent call's context.

**Relationship to per-app `userPreferences`:** the global profile is cross-cutting; per-app `userPreferences` overrides for specific apps (e.g., tegező only for wedding-planner).

**Writes:**

- You edit directly: `yarn jarvis profile edit` opens the file in `$EDITOR`.
- Jarvis may propose updates via an improvement plan (`Type: improvement, App: jarvis, Subtype: meta`) — e.g., "I've noticed you consistently reject Lighthouse signals below 10-point drops; propose adding this to `observedPatterns.rejectionReasons`." You approve like any plan.
- No agent writes directly.

**Prompt caching:** the profile is a stable prefix, marked `cache_control`. Changes invalidate the cache, but since edits are infrequent, cache hit rate stays high.

### Schema versioning

Every brain carries a `schemaVersion`. The user profile also carries a `schemaVersion`. Brain migrations live in `jarvis/migrations/brain/NNN-description.ts`; profile migrations in `jarvis/migrations/profile/`; SQLite migrations in `jarvis/migrations/db/`. Jarvis runs pending migrations in order on daemon start. Migrations ship with the code (not the data) so any fresh install uses the same schema.

**Across vaults:** the brain-migration runner iterates **every vault** (`jarvis-data/vaults/*/brains/*/`) and applies pending migrations to each brain. Brains that arrive later via `git pull` on the data repo get migrated on next read — the runner is idempotent and re-checks `schemaVersion` on every read. Conflicts (e.g., two machines edited the same brain at different schema versions) escalate to `#jarvis-alerts` for manual resolution rather than auto-merging.

### Event log (source of truth)

Events live in **SQLite** at `jarvis-data/jarvis.db` — one DB, shared across all apps, with an `app_id` column on every row. Primary store for queryable history: signals, plan transitions, metric observations, setup-task completions, agent runs, cost telemetry, suppressions (§8), agent circuit-breaker state (§13), and **scheduled posts** (§5 → Scheduled-post persistence). Cross-app queries (portfolio triage, cost reporting, self-telemetry) run here. Brain JSON is derived from events.

### Audit export (git-tracked in the data repo)

A daily internal scheduler exports the day's events to `jarvis-data/brains/[app]/events-YYYY-MM.jsonl` (per app, monthly rotation, append). Tracked in the data repo (not the code repo) for human-readable history, grep-ability, and disaster recovery — if `jarvis.db` corrupts, rebuild from these files.

### Single-writer contract

One agent writes per brain at a time. Enforced via file lock `jarvis-data/brains/[app]/.lock` with **PID + heartbeat** contents:

```json
{
  "pid": 54321,
  "heldSince": "2026-04-22T14:03:00Z",
  "heartbeat": "2026-04-22T14:03:04Z"
}
```

- Writer refreshes `heartbeat` every 2 seconds while it holds the lock.
- Acquirer treats a lock as stale if: `heartbeat` is older than 10s, **OR** the holding PID is no longer alive (`kill -0 <pid>`).
- Stale locks are taken over automatically; no manual cleanup needed after a crash or forced kill.
- `yarn jarvis doctor` also reports any stale locks it finds.

Other agents read freely (no lock needed for reads). Writers update brain AND append events atomically in a single SQLite transaction.

### Research index

`jarvis-data/brains/[app]/research/` holds Scout's research outputs (markdown). Indexed with per-topic freshness TTL (default 30 days, configurable per topic class — pricing is 7 days, architectural decisions are 180 days).

### Project docs (user-provided, per app)

`jarvis-data/brains/[app]/docs/` — your own project context that isn't code and isn't Scout-generated. Sits alongside `research/` but sourced **from you**.

**Two orthogonal dimensions** describe each doc: `kind` (where it came from) and `retention` (whether Jarvis keeps a full copy).

**Source `kind`:**

1. **Local files** — markdown, PDF, plain text.
2. **External URLs** — public pages, share links, Notion public pages.
3. **Authenticated sources** — Google Drive, Notion, private repos. Require a connection setup task first (see §10).

**Retention mode:**

- **`absorbed`** _(default)_ — Strategist reads the doc once and **deeply extracts** project-scoped content into the brain (current situation, brand, conventions, constraints, target segment). A structured summary + extracted facts + tags are kept in `docs.json`. The **original is NOT retained** — safe to delete from your machine. If the doc contains user-level signal (personal preferences, goals, working style), Strategist drafts a **separate** proposed user-profile update plan rather than mutating `user-profile.json` directly.
  - **At onboarding:** absorption happens inline as part of the `jarvis onboard` command; the initial brain draft already includes everything the docs taught.
  - **Post-onboarding:** `docs add` runs Strategist in **propose mode** — it drafts a **brain-update plan** (type `improvement`, subtype `meta`, app `<name>`) listing the fields it wants to extend or modify, with the new summary + extracted facts attached. You review and approve through the standard plan flow. On approval: the brain is extended and the `docs.json` entry is written. No silent brain mutation after the initial onboarding write.
- **`cached`** _(opt-in via `--keep`)_ — full content copied/fetched into `docs/`, refreshable on TTL for URL/authenticated kinds. Use for docs you reference repeatedly (brand guidelines, pricing sheet, ongoing research notes) where Jarvis benefits from loading full content on-demand. Cached docs don't automatically extend the brain — they stay as reference material. If a cached doc contains foundational info you want absorbed, re-add it without `--keep` (or run `docs absorb <id>` to trigger the brain-update plan).

**Doc index** (`docs/docs.json`):

```json
[
  {
    "id": "...",
    "kind": "file | url | drive | notion | ...",
    "retention": "absorbed | cached",
    "source": "original path or URL (may be unreachable if absorbed)",
    "title": "...",
    "tags": ["brand", "pricing", "target-audience"],
    "addedAt": "...",
    "summary": "3–5 sentence summary for context injection",
    "extractedFacts": ["headline facts Strategist pulled during absorption"],
    "hashOrEtag": "... (for cached; absorption fingerprint for absorbed)",
    "refreshedAt": "... (cached only)"
  }
]
```

**Context assembly:** summaries + tags + extracted facts ship with every agent call (cacheable). **Full doc content** is loaded on-demand only for `cached` docs when the active plan's topic matches a doc's tags. `absorbed` docs contribute only through their summary and the information already baked into the brain.

**Refresh policy:** per-source TTL for `cached` (default 30d, tunable). Weekly daemon housekeeping re-fetches; unreachable sources flagged by `yarn jarvis doctor`. `absorbed` docs are not tracked for auto-refresh — re-extract explicitly via `docs reabsorb <id> <path-or-url>` when you have an updated version.

**Where docs live — answering the broader question:**

- **User-supplied docs belong in `jarvis-data/`**, never in the code package. Keeps the code shippable/sellable with zero business-content leakage.
- **External URLs and authenticated sources (cached mode) stay authoritative externally** — Jarvis stores a local cache + summary, not a copy of record. Refreshes on schedule.
- **Read-only is the default.** Jarvis never writes back to the external source.
- **Absorption default** fits the common onboarding case where you hand Jarvis a briefing, spec, or strategy doc, want Jarvis to internalize it, and then delete or archive the original elsewhere.

### Global idea pool

`jarvis-data/ideas/` — unbuilt ideas, scored periodically by Scout. Sources: Business_Ideas.md, Scout's own suggestions based on market signals, user dumps.

### Feedback store & learning loop

Every structured user feedback action lands in SQLite (`feedback` table) with `id, kind, actor, target_type, target_id, note, context_snapshot, timestamp`. Captured kinds:

- Plan **approve** (optionally with note), **revise** (with feedback — keeps plan alive, redraft loop), and **reject** (with category — plan dead, suppression applies).
- **Modification** notes when user changes a plan at approval time.
- **Clarification answers** during Strategist's Socratic gate (§2) — each round of Q/A is a feedback entry tied to the plan id.
- **Reprioritizations**, **unblocks**, **unpauses**, **rollback decisions**.
- **Free-form comments** via `yarn jarvis comment --target <id> "note"` or Slack thread replies.

**Learning loop — proposal-based, never silent.** Jarvis does not mutate its own prompts, thresholds, or profile state directly from feedback:

1. Analyst runs a periodic pass over `feedback` (weekly via the learn-tick service, daily via the self-audit, or ad-hoc via `yarn jarvis learn --scan`).
2. Detects recurrent patterns: clusters of rejects with the same reason, modification notes that repeat, Socratic answers that consistently contradict agent defaults.
3. Proposes an improvement plan (type `improvement`, subtype `meta`). The plan's `App:` depends on the target:
   - `user-profile.json` (observedPatterns, preferences, strategies) → `App: jarvis`
   - Agent prompts in `jarvis/prompts/` → `App: jarvis`
   - Per-app brain (`conventions`, `alertThresholds`, `brand`) → `App: <that app>`
4. You approve or reject through the standard plan-review flow.

Learning is auditable (every change is a merged PR), reversible (revert the PR), and user-approved. No hidden state updates anywhere in the system.

### Logs

`jarvis-data/logs/activity-YYYY-MM.jsonl` — structured log of every agent action. Rotated monthly. Queryable via `yarn jarvis timeline` with filters: `--plan <id>`, `--agent <name>`, `--kind signal|plan|pr|cost`, `--since 24h`. Single CLI for all activity queries.

### Context budget & prompt caching

Each agent type has a per-call budget that's **measured, not guessed**. Phase 0–1 runs with generous initial budgets (~100K tokens); Phase 2 tightens per-agent budgets based on telemetry from real calls (p95 actual usage + 50% headroom).

Jarvis assembles context: system prompt + per-app brain summary + plan-in-progress + recent relevant events. Raw history stays on disk; summaries go into prompts. Prevents context drift as events accumulate.

**Prompt caching is first-class.** Stable prefixes are marked with `cache_control` so repeated calls within Claude's 5-minute cache TTL pay ~10% of the cached-content rate. Cached segments:

- System prompt per agent (stable across calls)
- Per-app brain summary (changes at most daily)
- Plan-in-progress header (stable across a plan's execution steps)

Typical cache hit on repeated calls: 60–80% of tokens. Lets agents see more context without paying for it repeatedly.

### Sandbox-pattern tool I/O (context-mode for Jarvis itself)

Every Jarvis tool that can produce bulk output follows the sandbox pattern: save raw output to a file under `jarvis-data/sandbox/`, return only a **summary + sandbox path** to the calling agent. Agents query specifics via follow-up tools (`extract`, `grep`, `count`, `slice`) rather than ingesting raw data. This is Jarvis's own version of the context-mode discipline (mirrors the same pattern Claude Code uses) — keep agent context lean.

**Tool categories that follow the pattern:**

- `read_doc(path)` → `{ summary, tags, extractedFacts, sandboxPath }` — not full content.
- `fetch_url(url)` → `{ summary, contentType, sandboxPath }` — not raw HTML/PDF.
- `query_events(sql)` → `{ rowCount, sample (≤10), sandboxPath }` — not full result set.
- `run_command(cmd)` → `{ exitCode, headline, sandboxPath }` — not full stdout/stderr.
- `lighthouse_run(url)`, `axe_scan(url)`, `broken_links_crawl(app)` → `{ scores, regressions, sandboxPath }` — not full report.

**Follow-up tools** (cheap, narrow):

- `extract(sandboxPath, query | regex)` → matched fragments only.
- `count(sandboxPath, predicate)` → counts only.
- `grep(sandboxPath, pattern)` → matching lines only.
- `slice(sandboxPath, range)` → byte / line / row range.

**Sandbox lifecycle:**

- Files live at `jarvis-data/sandbox/<plan-id-or-step-id>/`.
- Cleared automatically on plan completion (`done`, `cancelled`, observation-window close).
- Daily sweep removes orphans older than 7 days.
- Gitignored — sandbox content is transient, not audit material (the plan, summary, and extracted facts that landed in the brain or `docs.json` are the audit record).

**Why this matters:** without the pattern, an agent reading a 50KB doc burns ~12K tokens per call. With the pattern, the agent sees a 200-token summary and pulls specifics on demand at ~50 tokens each. Fewer tokens = lower cost (§18), faster cycles, higher cache hit rate. Self-telemetry (§8) tracks per-agent context efficiency; budget overruns trigger an Analyst pattern that proposes tool refactors via the meta plan flow.

---

## 8. Analyst: signals & post-merge observation

Analyst is reactive: watch everything, filter aggressively, only a tiny fraction of signals become plan triggers. (Proactive research and portfolio triage belong to Scout — §9.)

### Signal sources

- **App metrics:** Umami (traffic, funnel, source attribution — self-hosted) + Supabase (signups, active users, conversions, revenue when live).
- **Security:** `yarn audit`, GitHub Dependabot alerts, monitored CVE feeds.
- **Dependency health:** outdated majors, deprecated packages, security advisories.
- **Link health:** periodic broken-link crawl per app.
- **Performance:** Lighthouse runs, Web Vitals drift.
- **Accessibility:** axe-core scans, WCAG regression detection.
- **Content freshness:** last-updated detection on key pages.
- **Portfolio financials:** revenue / cost per app, runway, profitability curve.
- **Self-telemetry:** Jarvis's own plan-success rate, your override rate, escalation frequency, feedback patterns (see §7 → Feedback store), **bug rate per shipped plan** (bugs reported within the observation window, attributed to the originating Developer run).

### Filter → trigger

Raw signals land in the event log. A signal becomes a plan trigger only if:

1. It crosses a per-signal-type severity threshold, OR
2. It accumulates with related signals above a compound threshold.

Unfiltered signals remain queryable (`yarn jarvis timeline --kind signal`) but don't generate inbox noise.

### Tunable

Every threshold lives in the brain. Over time the Analyst proposes threshold adjustments based on which signals produced useful plans.

### Post-merge observation (closing the learning loop)

When a plan's PR merges, Analyst starts the plan's observation window:

1. Merge event logged in SQLite against the plan ID.
2. During the window, Analyst samples the plan's `Success metric` on a cadence: **daily for windows ≤ 30 days, weekly for windows > 30 days**.
3. At window close, Analyst tags the plan:
   - `success` — target hit (or directional improvement holds)
   - `null-result` — metric unchanged within noise
   - `regression` — metric dropped below baseline with statistical confidence

Tagged plans feed self-telemetry. Strategist reads these when drafting new plans ("last 3 header-rework plans were null-results — tighten the hypothesis or drop this class of change").

### Regression handling (tiered)

When Analyst detects a regression mid-window:

- **Minor (< 20% drop from baseline):** flag to `#jarvis-inbox`. You decide whether to investigate or let the window close naturally.
- **Major (≥ 20% drop):** Analyst asks Strategist to auto-draft a rollback plan (type `improvement` / subtype `rework`, action: "revert PR #X"); surfaces to `#jarvis-alerts` for your approval.

Thresholds per-metric live in the brain under `alertThresholds` and are tunable.

### Rejection feedback (suppressing re-triggered plans)

When you reject a plan, the Reject action asks you to pick a category. The category + the triggering signal pattern get stored, and Analyst honors the resulting suppression rule before triggering a replacement plan.

| Category                 | Suppression                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-worth-effort`       | 90 days                                                                                                                                                                                                   |
| `signal-unreliable`      | Indefinite — until you unblock, or pattern recurs 3× with higher severity                                                                                                                                 |
| `wrong-timing`           | 30 days                                                                                                                                                                                                   |
| `duplicate-of-approved`  | Until the approved plan's observation window closes                                                                                                                                                       |
| `scope-wrong` _(legacy)_ | Use the **Revise** action instead — keeps the plan alive and feeds your feedback to Strategist for a redraft. Reject + scope-wrong is preserved for backward compatibility but routes to the Revise flow. |
| `other`                  | 30 days — your note travels forward with future similar-signal reports                                                                                                                                    |

**Unblocking before the timer expires:**

- **CLI:** `yarn jarvis unblock <pattern-id>` (also `yarn jarvis suppressions` to list active ones)
- **Slack:** Monday digest of active suppressions in `#jarvis-inbox` with an "Unblock" button per row
- **Automatic escalation:** when a suppressed pattern re-fires with severity above its original level, Analyst surfaces a "suppressed pattern escalating — review?" card instead of respecting the suppression

**Storage:** suppressions live in SQLite (`suppressions` table) with fields: `pattern_id`, `category`, `expires_at`, `origin_plan_id`, `note`.

---

## 9. Scout: research, triage, idea scoring

Scout is proactive: market research, trend monitoring, competitor tracking, idea generation, and weekly portfolio triage. Pulls from public web + your Business_Ideas.md + Analyst's metrics (read-only). Writes its findings into `research/` per app and `memory/ideas/` globally.

### Weekly portfolio triage

Scout runs a weekly pass: **where should this week's autonomous effort go?**

### Scoring inputs (per app and per idea)

- Effort-to-revenue distance
- Current momentum (Analyst's trend data on key metrics)
- Market opportunity (Scout's own research)
- Fit with your energy / stated preferences
- Diversity bonus (to avoid monotony — see §1)

### Output

A ranked list:

```
This week's focus:
1. erdei-fahazak — signups plateaued; improvement plan proposed
2. wedding-planner — stable; low-effort polish improvements queued
3. [new idea] "local-event-listing" — scored 82; recommend short validation plan
```

You review the triage; approved picks drive the week's plans. Variety is ensured by mixing one new-thing plan per N maintenance plans (configurable).

### New idea generation

Scout scans Business_Ideas.md + current market signals + your stated domains, scores promising candidates, and surfaces top ones in the weekly triage. Each surfaced idea can become a business plan (for deeper validation) or a throwaway if rejected.

### Portfolio attention & anti-starvation

Each project's brain carries:

- `projectStatus: active | maintenance | paused` (default `active`)
- `projectPriority: 1–5` (1 = lowest, 5 = highest; default `3`)

These shape Scout's weekly triage and Analyst's signal-to-trigger thresholds.

**Triage scoring** (Scout, every Monday pass):

- Per-app score = `projectPriority × signalIntensity × ageBoost × statusMultiplier`.
  - `signalIntensity` — aggregated severity of unaddressed signals for the app this week.
  - `ageBoost` — `1.0` baseline; `+0.2` per week the app has gone without an executed plan, capped at `2.0`.
  - `statusMultiplier` — `active` = 1.0; `maintenance` = 0.3 (only security / dep / regression-driven plans surface); `paused` = 0.0 (no triage entries; in-flight plans complete or cancel).

**Anti-starvation guarantees:**

1. **Monthly floor** — every `active` project surfaces in triage at least once per calendar month regardless of computed score. Prevents low-priority apps going dark.
2. **Stale-plan auto-bump** — any plan in `awaiting-review` for >14 days gets `Priority` bumped one tier (low → normal → high); >30 days escalates to `#jarvis-alerts` as "stale plan review needs decision."
3. **Untouched-app warning** — `yarn jarvis status` and the Monday triage flag any active project with `lastExecutedPlanAt` older than 30 days.

**User-controllable:**

- `yarn jarvis project priority --app <name> --weight <1-5>` — change priority weight.
- `yarn jarvis project status --app <name> --status <active|maintenance|paused>` — change status.
- These writes go through Jarvis (orchestrator); changes log as feedback events for telemetry.

**Default behavior on first onboarding:** `active` + priority `3` so new projects compete fairly until you tune them.

---

## 10. Setup & connections

### Connection inventory

Lives in each brain (see §7). Tracks: status, token expiry, capabilities unlocked, setup steps if missing.

### Setup queue

`jarvis-data/setup-queue.jsonl` — typed tasks. CLI: `yarn jarvis setup` (work through queue interactively), `yarn jarvis setup --done <task-id>` (mark a single task complete), `yarn jarvis setup --skip <task-id>` (skip with reason). Task types:

- `oauth`: URL to visit, token to paste
- `api-key`: service name, where to store
- `ui-action`: third-party tool, steps list
- `dns`: record type, value, host
- `purchase`: domain/service, recommended provider

### Pre-flight

Before a plan enters your inbox, Strategist checks its `Connections required`. Missing ones auto-queue as setup tasks attached to the plan. Your inbox shows plan + any required setups as a unit.

### Batching

Setup tasks for the upcoming week collect into a single weekly block. When you want, run `jarvis setup` and work through them in one sitting.

### App onboarding

New apps enter Jarvis via `yarn jarvis onboard --app <name> --repo <path-or-url> [--monorepo-path apps/<name>] [--vault <vault-name>] [--docs <paths-or-urls>...] [--docs-keep <paths-or-urls>...] [--skip-interview]`.

The **`--vault`** flag picks which `jarvis-data/vaults/<name>/` the project's brain + plans + research + docs live under. Default is the configured default vault (`personal` out of the box; change via `yarn jarvis vault set-default`). Vaults are tracked subdirectories of the single `jarvis-data` git repo (see §15) and serve as organizational + audience boundaries — projects sharing a vault share an audience. Phase 5's public `showcase` is the one case where vault privacy diverges from the rest; see §15 → Phase 5 architecture. Move a project later via `yarn jarvis vault move --app <name> --to <vault>` if needs change.

**Onboarding runs in two phases.**

**Phase 1 — Intake interview** (interactive). Jarvis walks you through a structured conversation about the business: origin story, problem, solution, market, traction, business model, competition, team, financials, risks, vision, blockers — 50+ sections in total, audience-tailored from your first answer (mentor / investor / co-owner). Output is `vaults/<vault>/brains/<app>/docs/intake/content.txt`, registered as a cached doc with id `intake` in `docs.json`. Driven by [`prompts/strategist-intake.md`](../prompts/strategist-intake.md) + [`agents/intake.ts`](../agents/intake.ts). User controls termination: type `/skip` to skip a question, `/end` (or Ctrl-D) to wrap up early — the agent saves what it has and marks unanswered required sections as partial. Auto-skipped when stdin is not a TTY (CI, daemon, tests) and bypassable with `--skip-interview` for repos where you've already absorbed the equivalent docs.

**Phase 2 — Brain extraction** (non-interactive). Strategist inspects the repo (package.json, Drizzle config, app directory structure, Vercel deploy URL, existing `.env` keys to detect connections) and drafts a complete brain. The Phase 1 intake doc and any `--docs` arguments feed in as the absorbed-doc corpus. **Repo files outrank intake on technical claims** (stack, conventions); **intake outranks repo on business claims** (target users, brand voice, domain rules, priorities). Strategist also looks at sibling directories that touch the app (`agents/<app>/`, `cron-jobs/<app>/`, etc.) and surfaces them in `conventions.relatedComponents`; un-absorbed siblings of the absorbed docs land in `conventions.unprocessedDocs`.

If `--docs` is provided, each doc is **absorbed** by default (see §7 → Project docs retention modes): Strategist reads it, extracts project-scoped content into `brain.json`, and keeps a structured summary in `docs.json`. The original is **not retained** — safe to delete from your machine. If a doc contains user-level signal (personal preferences, goals, working style), Strategist queues a **separate proposed user-profile update plan** (subtype `meta`) — surfacing **after** onboarding completes and the initial brain is committed. This keeps onboarding focused on the project and avoids interleaving user-profile decisions with brain review. Add `--docs-keep` instead of `--docs` when you want the full content cached for repeated reference (brand guidelines, pricing sheet). Authenticated sources queue a setup task until OAuth completes. You review the generated `brain.json`, fill in brand voice + initial priorities + alert thresholds, and commit.

This mirrors the idea → plan → review → execute pattern: the brain itself is the drafted artifact; you approve or edit.

**Onboarding supports two repo shapes** (see also use cases #8–9):

- **Single-project repo** — `--repo` points at the root; Strategist inspects the whole tree.
- **Monorepo sub-app** — `--repo` at root + `--monorepo-path` to the app directory; Strategist scopes inspection to that subtree.

**App-name uniqueness:** `--app <name>` must be **globally unique across all vaults**. `onboard` rejects collisions with a hint: "An app called `wedding-planner` already exists in vault `personal`. Suggested names: `wedding-planner-client-acme`, `wedding-planner-v2`." This keeps `--app <name>` unambiguous in every other command (`plan`, `bug`, `vault move`, `status`, etc.) without forcing a `--vault` disambiguator.

**Docs can be added post-onboarding** too: `yarn jarvis docs add --app <name> <path-or-url>` (see §17).

**Onboarding is user-initiated, never automatic.**

Apps come online when you run `yarn jarvis onboard --app <name>` — there is no scheduled rollout. You decide when each project (existing app, new app, consulting, personal-brand) is ready. The very first brain Jarvis owns is its own (`jarvis`) — Phase 0 builds a self-improving system that can ship PRs against its own code before any real app is onboarded. After Phase 0, you onboard erdei-fahazak, kapcsolodjki, wedding-planner, hodi-group, or any new project at your own pace.

---

## 11. Review cadence

Your throttle: **10–15 hours/week**, split across two slot types plus buffer. The daily inbox is the **venue** where plan reviews, PR reviews, and setup tasks actually happen — not additional time on top of them.

### Daily inbox (where most work happens)

~1 hr/day on weekdays + ~30 min each weekend day = **~6 hrs/week**.

Surfaced:

- Urgent escalations (rare)
- PRs awaiting review + manual testing
- Plan reviews due (including plan amendments)
- Pending setup tasks (batched to weekly unless blocking)
- Plan rejections (with category picker — see §8 → Rejection feedback)

Fast items (simple PR merge, one-line setup, clear approve/reject) close on the spot. Substantial plan reviews can be deferred to that day's deeper engagement.

### Weekly deeper slot

You pick a day (e.g., Sunday). **~1–2 hrs/week.**

Used for:

- Business plan reviews / updates
- Scout's Monday portfolio triage review
- Setup task batch (any not blocking a plan)
- Self-improvement plans for Jarvis itself
- Rejected-plan retrospectives (Analyst surfaces patterns — "these 3 rejects hit the same signal category")
- Active suppression digest (unblock candidates)

### Buffer

**~3–6 hrs/week** for spikes: heavy amendment reviews, manual testing of complex PRs, unexpected escalations, occasional deep dives into metrics.

### Inbox delivery channel

- **Phase 0:** CLI only (`yarn jarvis inbox`). No external deps.
- **Phase 1 onward:** Slack (Socket Mode, local daemon) becomes the primary surface. CLI stays forever for admin and debug.
- **Channel split:**
  - `#jarvis-inbox` — routine: plan reviews, setup tasks, PR ready, daily morning summary.
  - `#jarvis-alerts` — escalations, budget/quota warnings, anything needing same-day attention.
- Interactive Block Kit messages carry **Approve / Revise / Reject** actions (see §4 → Plan lifecycle). **Revise** opens a free-form feedback prompt → Strategist redrafts and re-surfaces. **Reject** opens a category picker (see §8 → Rejection feedback). Amendments stay threaded on the original plan message.

---

## 12. Escalate-within-plan

During autonomous execution, the executor (Developer or Marketer) must halt and surface rather than guess forward when:

- Acceptance criteria can't be met as written.
- A required connection is missing or broken.
- Tests pass but the behavior seems wrong (heuristic — ask for human eye).
- The plan's rollback condition triggered.
- Any `Amendment clause` from the plan fires.

### Amendment flow

1. Executor writes amendment proposal referencing the original plan.
2. Appears in your inbox tagged `amendment`.
3. You approve, reject (cancel plan), or modify.
4. Approved amendment → execution resumes from checkpoint with updated plan.

Amendments are a normal part of the loop, not a failure. Strategist learns from amendment rates and adjusts plan specificity.

### Implementation status (Phase 2, PRs #34–#36, #38)

CLI + Slack surfaces wired end-to-end:

- **AMEND output protocol** from Developer (`AMEND` line, `Reason:` line, multi-line proposal). Precedence: AMEND > BLOCKED > DONE. Detected by `parseAmendmentResponse` in `agents/developer.ts`.
- **Checkpoint** at `<dataDir>/logs/checkpoints/<planId>.json` capturing branch, sha, modified files, reason, and proposal — best-effort capture; failures log `amendment-checkpoint-error` but don't abort the amendment.
- **Plan body update**: a stacked `## Amendment proposal (mid-execution, YYYY-MM-DD)` section is appended so the user reviewing the plan in their inbox sees context inline with the original plan.
- **State transition**: `executing → awaiting-review` with an `amendment-proposed` event recorded.
- **Inbox tagging**: CLI `yarn jarvis inbox` separates "Pending amendment reviews" from "Pending plan reviews" with an `[AMEND]` row tag.
- **Slack surface** (PR #38): `runSurfaceTick` routes amendment-state plans to `surfaceAmendmentReview`, which posts a distinct Block Kit message to `#jarvis-inbox` with reason + proposal context, branch / sha / modified-file count, and Approve & resume / Revise / Reject buttons. Idempotent on the `amendment-proposed` event id; re-amend on resume produces a fresh post.
- **Auto-resume** (`executePlan({resume: true})`): plan-executor detects resume state via `isAmendmentResume`, skips `assertCleanMain`, runs Developer with a resume-mode prompt that explains the dirty-tree expectation. On DONE, records `amendment-applied`, deletes the checkpoint.
- **Reject cleanup** (CLI + Slack): both `yarn jarvis reject <id>` and the Slack reject button remove the checkpoint after a successful rejection (best-effort no-op for non-amendment plans).

---

## 13. Safety rules

- **Main branch is sacred.** Developer never pushes to main, never force-pushes, never rewrites history on any branch.
- **You merge, always.** No auto-merge, even on green CI.
- **Manual-test hook on every PR.** Developer adds a `## Manual test plan` section to the PR description so you know what to poke.
- **Secrets scanner pre-Claude.** Every outbound prompt passes through a regex-based redactor covering: Anthropic, OpenAI, AWS, GitHub, Stripe, Postmark, Supabase, Vercel, Doppler keys + generic JWT + full `.env` fragments. Matches → `[REDACTED_SECRET]` + log + inbox entry. Known limitations acknowledged: regex won't catch obfuscated or encoded secrets — design prompts to not need raw secrets in the first place.
- **No destructive ops autonomously.** DB drops, `rm -rf`, force-push, license changes, public-repo flips — all require plans with `Destructive: true` in the front-matter. Approval requires a second confirmation: Slack asks for a secondary button click, CLI requires `yarn jarvis approve <id> --confirm-destructive`. Strategist must set this flag whenever the Build plan includes any irreversible op.
- **Timeouts:** any agent step that blocks > 30 min escalates and releases its lock.
- **Rate-limit aware:** the agent runtime listens for `SDKRateLimitEvent` from the Claude Agent SDK and for `rate_limit` on assistant-message errors. On hit, the plan-executor pauses, posts to `#jarvis-alerts` with the reset time, and resumes automatically after the window expires. Other external APIs (GitHub, Umami, Slack) wrap with exponential backoff; 429s log as signals. See §18.
- **Backup check:** restore smoke-test runs on first `yarn jarvis install` (so you know the restore path works before you need it) AND monthly thereafter. Rebuilds SQLite from JSONL exports into a scratch dir and verifies row counts match.
- **Dry-run mode:** Developer and Marketer accept `--dry-run` to produce outputs with no side effects (no git commit, no Slack/FB post). Use when onboarding a new agent version or debugging suspicious behavior.
- **Humanizer pass on user-facing text.** Any text destined for an external audience (social posts, campaign copy, app marketing content, blog) runs through `jarvis/tools/humanizer.ts` before publication or PR. The humanizer is a Claude call with style rules from the Wikipedia "Signs of AI writing" guide — strips inflated symbolism, rule-of-three, em-dash overuse, vague attributions, and promotional language. **Applies to:** all Marketer outputs, Developer outputs when a plan touches user-facing text (per the repo `CLAUDE.md` writing style). **Exempt:** plans, amendments, PR descriptions, commit messages, code comments, internal logs, Slack messages to you.
- **Sandbox-pattern tool I/O (context-mode discipline).** Every tool that can produce bulk output (file reads, URL fetches, command runs, SQL queries, scanner reports) saves raw output to `jarvis-data/sandbox/` and returns only a summary + path to the calling agent. Agents query specifics via narrow follow-up tools (`extract`, `grep`, `count`, `slice`). No agent ingests raw bulk data into its prompt. See §7 → Sandbox-pattern tool I/O for tool list, follow-up surface, and lifecycle.
- **Don't accept briefs blindly.** Strategist applies a Socratic challenge gate to every user brief (see §2 → Clarification path). It analyses brain + profile + signals + past plans, asks "why" until the underlying intent is grounded, and only then drafts. Up to 3 clarification rounds; beyond that, drafts with assumptions flagged under `## Open questions / assumptions`. Applies symmetrically when you brief Scout for research or Marketer for a one-off — "accept and execute" is not the default.

### Quality circuit breaker (per agent)

Each agent's recent outcomes (approved, rejected, dismissed, reworked) are tracked in SQLite (`agent_state` table, rolling window). When an agent's failure rate crosses its trip threshold, the circuit breaker fires in a tiered way.

| Agent                   | Tier         | Trip threshold                                     | Behavior when tripped                                                           |
| ----------------------- | ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Strategist (code plans) | Hard pause   | > 50% rejected on last 6 plans of subtype ≠ `meta` | Drafts no new code plans until unpaused                                         |
| Strategist (meta plans) | Hard pause   | > 80% rejected on last 10 plans of subtype `meta`  | Drafts no new meta plans until unpaused; code-plan drafting continues           |
| Developer               | Hard pause   | > 50% PR rework on last 4                          | Writes no code until unpaused                                                   |
| Marketer                | Hard pause   | > 40% rejected / off-brand on last 5               | Drafts no posts until unpaused                                                  |
| Scout                   | Soft pause   | > 80% dismissed opportunities on last 10           | Keeps running; outputs carry a `quality-flagged` badge until unpaused           |
| Analyst                 | Soft pause   | > 70% noise on last 10 anomalies                   | Keeps collecting; flagged signals require manual review before triggering plans |
| Jarvis                  | Never paused | —                                                  | Orchestrator stays up no matter what                                            |

**When tripped:**

- Escalation to `#jarvis-alerts` with rolling outcome history and three buttons: `[Review recent outputs]`, `[Unpause — accept risk]`, `[Keep paused]`.
- CLI fallback: `yarn jarvis unpause <agent> [--scope <code|meta|both>]` after investigation. Default `both`. For Strategist's split breaker, `--scope code` or `--scope meta` targets one rolling window; for other agents the flag is a no-op.
- **Stale-pause reminder:** if an agent stays paused for >24 hours, the daemon re-posts a reminder to `#jarvis-alerts` ("Strategist (meta) still paused since 2026-04-26 — investigate or `unpause`?"). Repeats every 24h until resolved. Stops you forgetting that an agent is silent.

**Listing current breaker state:** `yarn jarvis breakers` shows every agent's state (active / paused), scope (Strategist's code vs meta), threshold, current rolling rate, last-N outcome summary, and tripped-at timestamp. `yarn jarvis breakers --tripped` filters to currently paused agents only.

**Thresholds are opening defaults.** After a few weeks of real use, self-telemetry (§8) will show whether any is too tight or too loose; Analyst proposes adjustments via an improvement plan against Jarvis itself.

**Why split Strategist's breaker by code vs meta:** meta plans (learning-loop proposals, speculative profile updates) have naturally higher rejection rates than feature/rework plans — you won't codify every observed pattern. Tracking them in the same rolling window would trip the hard pause on normal meta-plan churn. Separate windows keep the code-plan quality signal intact while permitting meta's looser acceptance rate.

---

## 14. Tech stack

| Layer                      | Choice                                                              | Notes                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager            | **yarn**                                                            |                                                                                                                                                                                                                                                                            |
| Language                   | **TypeScript** (strict)                                             |                                                                                                                                                                                                                                                                            |
| Runtime                    | **Node + tsx**                                                      |                                                                                                                                                                                                                                                                            |
| LLM runtime                | **`@anthropic-ai/claude-agent-sdk`** driving the local `claude` CLI | Runs every agent under the user's Claude Code subscription (Pro/MAX) — the SDK spawns the `claude` subprocess which uses the local auth at `~/.claude/`. No `ANTHROPIC_API_KEY` required. See §18 for the resource model.                                                  |
| App DB (per onboarded app) | **Postgres via Drizzle**                                            | Apps Jarvis works on, not Jarvis itself.                                                                                                                                                                                                                                   |
| Jarvis own DB              | **SQLite via `better-sqlite3`**                                     | File-based, no extra infra. Synchronous API keeps the single-writer-lock + atomic-write model simple; native bindings ship prebuilt for darwin/linux/win.                                                                                                                  |
| DB migrations              | **Custom lightweight runner**                                       | Numbered TS files in `jarvis/migrations/db/`, `jarvis/migrations/brain/`, `jarvis/migrations/profile/`. Each exports `up()` / `down()`. Runner records applied versions in a `_migrations` table; ~100 LOC. Avoids dragging in `umzug` or Drizzle Kit for Jarvis's own DB. |
| Unit tests                 | **Vitest**                                                          |                                                                                                                                                                                                                                                                            |
| E2E tests                  | **Playwright**                                                      |                                                                                                                                                                                                                                                                            |
| Secrets (Phase 1)          | **`.env`**                                                          | `jarvis-data/.env` holds Jarvis's own secrets (Slack tokens, Umami credentials, etc.); per-app `.env` files stay where they are. Doppler if/when it becomes unwieldy. **No Anthropic API key** — the agent runtime authenticates through the local `claude` CLI (§18).     |
| Data location              | **`$JARVIS_DATA_DIR`** env var                                      | Default `../jarvis-data` relative to the Jarvis repo root. Separates user-specific state from shippable code (§15).                                                                                                                                                        |
| User interface (Phase 0)   | **CLI** (`yarn jarvis ...`)                                         | Admin and debug surface, retained forever                                                                                                                                                                                                                                  |
| User interface (Phase 1+)  | **Slack** (Socket Mode)                                             | Primary surface; split channels `#jarvis-inbox` + `#jarvis-alerts`                                                                                                                                                                                                         |
| Git hosting                | **GitHub**                                                          | Two GitHub remotes: the Jarvis code repo, and `jarvis-data/` (one repo containing all vaults; shared root state is gitignored).                                                                                                                                            |
| App deploy                 | **Vercel**                                                          | For onboarded apps; not for Jarvis itself (Phase 1 is local-only — see §6).                                                                                                                                                                                                |
| Analytics (apps)           | **Umami** (self-hosted)                                             | DB on existing Supabase Postgres; app on Vercel free tier; cookieless, GDPR-friendly; programmatic API for Analyst                                                                                                                                                         |
| Scheduled jobs             | None Phase 1                                                        | Add later when cloud execution joins                                                                                                                                                                                                                                       |

---

## 15. Repository layout

**Jarvis lives in its own standalone repo — never inside an applications monorepo.** The repo at `~/Projects/jarvis/` IS the code package. Code and data are split into two sibling directories on disk: the Jarvis code repo, and `jarvis-data/` next to it. Each is a separate git history. `jarvis-data/` is a single git repo: vaults are tracked subdirectories, and the shared root layer (`jarvis.db`, `.env`, `logs/`, `sandbox/`, `ideas/`, `setup-queue.jsonl`, `user-profile.json`, `.daemon.pid`, brain `.lock` files) is gitignored. Jarvis code reads the data location from `$JARVIS_DATA_DIR` (default: `../jarvis-data` relative to the code repo root).

```
~/Projects/
├── jarvis/                          ← CODE REPO — single git remote, shippable/sellable
│   ├── docs/                        ← living documentation — ships with the code
│   │   ├── MASTER_PLAN.md           ← this doc — single source of truth
│   │   └── USE_CASES.md             ← living catalog of user journeys
│   ├── agents/
│   │   ├── jarvis.ts                ← orchestrator
│   │   ├── analyst.ts               ← reactive signals
│   │   ├── scout.ts                 ← proactive research & triage
│   │   ├── strategist.ts
│   │   ├── developer.ts
│   │   └── marketer.ts
│   ├── prompts/                     ← per-agent system prompts (.md)
│   ├── tools/
│   │   ├── github.ts
│   │   ├── umami.ts
│   │   ├── supabase.ts
│   │   ├── search.ts                ← research (mock first)
│   │   ├── humanizer.ts             ← AI-writing-style rewriter (see §13)
│   │   ├── social/{facebook.ts, instagram.ts}
│   │   └── scanners/{yarn-audit, lighthouse, broken-links, axe, content-freshness}.ts
│   ├── integrations/
│   │   └── slack/                   ← Socket Mode bot, Block Kit builders, action handlers
│   ├── orchestrator/
│   │   ├── router.ts
│   │   ├── bus.ts
│   │   ├── context-budget.ts
│   │   ├── sandbox.ts               ← sandbox-pattern tool I/O helpers (§7, §13) — Phase 1+
│   │   └── redactor.ts              ← secrets scanner
│   ├── cli/index.ts                 ← `yarn jarvis ...`
│   ├── daemon.ts                    ← long-running local process
│   ├── migrations/
│   │   ├── db/                      ← SQLite schema migrations
│   │   ├── brain/                   ← brain schema migrations
│   │   └── profile/                 ← user-profile schema migrations
│   ├── plan-templates/              ← business / improvement / marketing / implementation
│   ├── CLAUDE.md                    ← repo conventions for Claude Code (added in Phase 0)
│   ├── package.json
│   └── tsconfig.json
│
└── jarvis-data/                     ← DATA — single git repo, one remote
    ├── .git/                        ← parent repo .git — vaults are tracked subdirs
    │
    │  -- shared root layer (gitignored: transient state, secrets, binary DB) --
    ├── jarvis.db                    ← single SQLite for cross-portfolio queries (events, signals, telemetry, suppressions, agent_state, feedback, scheduled_posts, vault_state)
    ├── user-profile.json            ← shared global personalization
    ├── setup-queue.jsonl            ← shared
    ├── ideas/                       ← shared global idea pool
    ├── sandbox/                     ← shared transient (§7) — cleared on plan completion + daily sweep
    ├── logs/                        ← shared
    │   ├── activity-YYYY-MM.jsonl
    │   ├── daemon-YYYY-MM-DD.log
    │   └── checkpoints/
    ├── .env                         ← shared secrets
    ├── .daemon.pid
    │
    │  -- vault layer (tracked subdirectories of the jarvis-data repo) --
    └── vaults/
        ├── personal/                ← DEFAULT vault — your private side projects
        │   ├── brains/
        │   │   ├── jarvis/          ← the system improving itself (Phase 0 first project)
        │   │   │   ├── brain.json
        │   │   │   ├── docs/        ← user-provided project docs
        │   │   │   │   └── docs.json
        │   │   │   ├── research/    ← Scout's outputs
        │   │   │   ├── events-YYYY-MM.jsonl
        │   │   │   └── .lock        ← gitignored (PID heartbeat, runtime only)
        │   │   ├── erdei-fahazak/
        │   │   ├── kapcsolodjki/
        │   │   ├── wedding-planner/
        │   │   └── hodi-group/
        │   └── plans/
        │       ├── jarvis/*.md
        │       ├── erdei-fahazak/*.md
        │       └── ...
        ├── consulting/              ← client work; same repo, same privacy posture as `personal`
        │   ├── brains/
        │   └── plans/
        └── showcase/                ← Phase 5 — see Phase 5 note below; public showcase requires extraction or a submodule
            ├── brains/
            └── plans/
```

**Path convention in this doc:** paths starting `jarvis/…` live under the **code repo root**. Paths starting `jarvis-data/…` live under `$JARVIS_DATA_DIR`. Project-scoped paths shown as `jarvis-data/brains/[app]/...` and `jarvis-data/plans/[app]/...` are **shorthand for** `jarvis-data/vaults/<vault>/brains/[app]/...` and `jarvis-data/vaults/<vault>/plans/[app]/...`. The vault is chosen at onboard time (default `personal`) and recorded in the project's brain.

**Two git histories:**

1. **Code repo** — the Jarvis source tree itself; one remote (private during Phase 0–4, optionally made public per the Phase 5 Track A choice).
2. **`jarvis-data/` repo** — one git history, one remote. All vaults under `vaults/` are tracked subdirectories. The shared root layer (`jarvis.db`, `user-profile.json`, `.env`, `logs/`, `sandbox/`, `ideas/`, `setup-queue.jsonl`, `.daemon.pid`, brain `.lock` files) is **gitignored** — never committed. The DB and secrets are backed up via your own mechanism (Time Machine, manual copy).

**Vaults & privacy posture:** all vaults live in the same `jarvis-data/` repo, so they share one privacy posture (the data repo's remote). Vaults still serve as organizational and audience boundaries — `personal` for your private side projects, `consulting` for client work, etc. Phase 5's `showcase` (public proof project) is the one case where vault-level privacy differs from the rest; see "Phase 5 — public showcase architecture" below for how that gets handled.

**Living documentation.** `MASTER_PLAN.md` and `USE_CASES.md` live inside `jarvis/docs/` — they ship with the code. Updates to either flow through the same plan-review pattern as code changes (improvement plan with `subtype: meta` against the `jarvis` project; Developer's PR includes the doc update).

**Distribution later:** because the code repo is already standalone, packaging Jarvis (npm publish, open-sourcing the repo as Phase 5 Track A) is a remote-and-license change — no extraction step needed.

### Data repo commit cadence

Writes to tracked files in `jarvis-data/` (anything under `vaults/`) commit to the data repo's local git automatically; pushing to the remote is a separate, scheduleable operation.

| Write                                                | Local commit                                                                                                                                   | Default push trigger             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Brain field update (incremental, per event)          | File write is atomic with the SQLite event-append transaction; the **git commit** for that file change is squashed hourly to avoid commit spam | Daily 03:00 + on plan completion |
| Plan transition (state change, revision, amendment)  | On transition                                                                                                                                  | On plan completion               |
| Plan content (Strategist draft, Developer impl plan) | On write                                                                                                                                       | On plan completion               |
| Scheduled-post row writes                            | Hourly batched                                                                                                                                 | Daily 03:00                      |
| Research outputs (Scout)                             | On write                                                                                                                                       | Daily 03:00                      |
| Project docs (`docs.json` + cached content)          | On write                                                                                                                                       | On change                        |

`yarn jarvis data push` triggers a manual push anytime (or just use `git -C $JARVIS_DATA_DIR push` directly).

**Push debouncing:** automatic pushes are debounced with a 30-second coalesce window. Multiple plan completions in quick succession produce a single push, not N. Manual `data push` bypasses debouncing.

### Phase 5 — public showcase architecture

`personal`, `consulting`, and any other private vaults all share the data repo's remote. The Phase 5 public showcase (Track B) is the only case where vault-level privacy must differ. When that phase lands, choose one of:

- **Separate repo** for `vaults/showcase/` (extract at Phase 5 entry; the `showcase` vault becomes its own git repo with a public remote, sibling to the others). Simplest, but `vault move --to showcase` becomes a cross-repo operation.
- **Git submodule** at `vaults/showcase/` pointing at a public remote. Keeps the addressing the same; adds submodule plumbing to install/clone.

Decision deferred to Phase 5 entry — both are tractable, the choice depends on how often projects move into/out of `showcase`.

**File-write atomicity:** the "atomic with SQLite transaction" guarantee in the table is implemented as tempfile + fsync + atomic rename, sequenced **after** the SQLite transaction commits. On SQLite rollback, the prior file version is preserved (no partial writes ever land on disk). This is the standard pattern; mentioned here so the implementer knows the guarantee isn't free.

### CLAUDE.md

Once the code-repo structure is in place, write `jarvis/CLAUDE.md` (the repo-level conventions file Claude Code reads when working in this repo) covering: how to run Jarvis (`yarn jarvis ...`), per-app brain location, how to add a new signal source, and the writing-style rules referenced by the §13 humanizer pass.

---

## 16. Phased build plan

### Phase 0 — Self-bootstrapping system (Week 1–2)

**Goal:** build a minimum Jarvis that can improve its own code via the standard approve-and-execute flow. **No real app onboarded yet** — Jarvis is its own first project.

**Prerequisites (one-time, before `yarn jarvis install`):**

- Code repo exists at `~/Projects/jarvis/` (this repo) with a private GitHub remote configured. Phase 0's exit-criteria PR target.
- **Claude Code installed and authenticated locally.** Jarvis runs every agent via the `@anthropic-ai/claude-agent-sdk`, which spawns the local `claude` CLI subprocess. The CLI inherits your Pro/MAX subscription auth from `~/.claude/`. Verify before install: `claude --version` returns ≥ 2.x. No `ANTHROPIC_API_KEY` is needed.

**Build order:**

- **Repo skeleton:** `package.json`, `tsconfig.json` (strict), `tsx` runtime, `vitest`, `better-sqlite3`, `@anthropic-ai/claude-agent-sdk` pinned. `jarvis/CLAUDE.md` written per §15.
- **SQLite layer:** custom migration runner (numbered TS files in `jarvis/migrations/db/`, `migrations/brain/`, `migrations/profile/`; runner records applied versions in a `_migrations` table). Initial DB migration creates `events`, `agent_state`, `feedback`, `suppressions`, `scheduled_posts`, `vault_state` tables (most stay unused until later phases — schema is forward-looking so we don't break things on phase boundaries).
- **Brain schema (Zod) + loader/saver** with atomic-write semantics (tempfile + fsync + rename, sequenced after the SQLite transaction commits per §15 atomicity note).
- **Single-writer lock** with PID + heartbeat per §7.
- **Secrets redactor** (`jarvis/orchestrator/redactor.ts`) — regex coverage per §13. Unit-tested before any LLM call lands.
- **Agent SDK runtime wrapper** (`jarvis/orchestrator/agent-sdk-runtime.ts`): one-shot `runAgent({systemPrompt, userPrompt, tools, cwd, maxTurns, canUseTool})` helper around `query()` from `@anthropic-ai/claude-agent-sdk`. Sets `permissionMode: "bypassPermissions"` so the daemon never blocks on prompts. Captures the result message — token usage, `total_cost_usd` (informational under the subscription), `num_turns`, `permission_denials`, any `errors`. Listens for `SDKRateLimitEvent` and surfaces a structured `RateLimitedError` so the plan-executor can pause and resume per §18. Redactor still runs on the user prompt + system prompt before they leave the process. **Sandbox-pattern helpers (`orchestrator/sandbox.ts`) are deferred to Phase 1+** — Phase 0's only tools are SDK built-ins (Read, Write, Bash, Grep), the GitHub CLI via Bash, and git, none of which need bulk-output sandboxing yet. The file is created with a TODO header; tools wired up later.
- **Plan templates** (`jarvis/plan-templates/`) for improvement, implementation, business, marketing — even though only improvement+implementation are exercised in Phase 0. Plan loader/parser handles front-matter + body sections per §4. Plan-ID format per §4 (`YYYY-MM-DD-<slug>`).
- **Plan state machine** end-to-end: `draft → awaiting-review → approved → executing → done`, plus `revise`/`reject` transitions and the parent-improvement ↔ implementation-plan two-phase approval flow per §4.
- **`yarn jarvis install`:** verifies `claude --version` (fails fast if Claude Code isn't installed or auth is missing), creates `jarvis-data/` (at `$JARVIS_DATA_DIR` or `../jarvis-data`), writes `.env` stub (Slack tokens commented out — no Anthropic key), initializes `jarvis.db`, runs migrations, runs `git init` at the `jarvis-data/` root and writes the canonical `.gitignore` (per §15 — shared root layer is gitignored, vaults/ is tracked), **creates the default `personal` vault directory** at `vaults/personal/`, seeds the `jarvis` brain inside `vaults/personal/brains/jarvis/` (the system itself, `projectType: other`), creates the user-profile template at `jarvis-data/user-profile.json` (identity + preferences fields blank, you fill before first Strategist run), runs the restore smoke-test, and prints next-steps:
  ```
  ✓ Installed. Claude Code 2.1.x detected — agents will run under your subscription.
  ✓ Default vault `personal` created. jarvis-data git repo initialized (no remote).
  → Fill in profile: yarn jarvis profile edit
  → Add a remote:    git -C $JARVIS_DATA_DIR remote add origin <git-url>
  → Add more vaults: yarn jarvis vault create <name>
  → First plan:      yarn jarvis plan --app jarvis "<your first self-improvement>"
  ```
- **Restore smoke-test details:** `install` seeds one synthetic event (kind `install-marker`, payload `{seed: true}`) into `jarvis.db`, exports it to a temporary JSONL file, rebuilds a scratch DB from the JSONL, asserts row counts and event payload match, then deletes the synthetic event from the live DB. Proves the restore path works on day zero so it's not first-tested during a real incident (§13 backup check).
- **CLI skeleton:** `install`, `inbox`, `run`, `doctor`, `profile`, `profile edit`, `plan`, `plans`, `approve`, `revise`, `reject`. Anything else from §17 is wired in later phases.
- **Strategist (minimal):** drafts improvement plans for the `jarvis` project only. Socratic challenge gate is **CLI stdin Q/A** in Phase 0 (Slack thread variant ships with the Slack adapter in Phase 1). Up to 3 clarification rounds per §2.
- **Developer (minimal):** reads `jarvis/` code, drafts implementation plans when `ImplementationReview` resolves to `required` (default for `new-feature`/`rework`), branches, commits, opens PRs against this repo's GitHub remote with `## Manual test plan` per §13. Fired manually via `yarn jarvis run developer <plan-id>`; the command auto-detects mode (draft impl plan vs execute) from the plan's `Type` + `ImplementationReview`. Auto-trigger on plan transitions lands with the daemon in Phase 1+.
- **Plan review flow end-to-end via CLI** (`approve` / `revise` / `reject`).

**Exit:** you brief Jarvis with a small self-improvement (e.g., "add `yarn jarvis status` summary command") → Strategist drafts the improvement plan with Socratic challenge → `yarn jarvis approve <id>` → `yarn jarvis run developer <id>` (Developer drafts the implementation plan; subtype `new-feature` → impl review required) → `yarn jarvis approve <impl-id>` → `yarn jarvis run developer <impl-id>` (Developer codes, runs typecheck/tests, opens a PR with `## Manual test plan`) → you review and merge. The full self-bootstrap loop validates **before any real app is onboarded**.

### Phase 1 — Capability expansion + Slack (Week 3–5)

**Goal:** extend the proven Phase 0 loop with broader plan types, the Slack surface (plan-review only), and the onboard command. Apps come online when you choose, not on a schedule.

**Build order (locked):**

1. **Daemon + checkpointing** (§6). Long-running local process (`yarn jarvis daemon`) Slack Socket Mode needs. Resumes in-flight plans from `jarvis-data/logs/checkpoints/`. The daemon also runs a **plan-executor** service that auto-fires Developer on approved plans for the `jarvis` app (Mode A drafts the impl plan; Mode B branches/codes/PRs). Mid-execution amendment + escalation still defer to Phase 2.
2. **Strategist extensions.** Drafts business plans and marketing plans (subtypes `campaign` and `single-post`; format-aware: post / blog / video-script / newsletter). Improvement plan drafting from Phase 0 unchanged.
3. **Backlog management** (§5). `yarn jarvis backlog --app <name>`, `yarn jarvis reprioritize`, the 3-improvement-plan cap rule + meta-queue split.
4. **Revision loops** (§4). `revise <id> "<feedback>"` actually re-runs Strategist with the feedback in context — the plan flips awaiting-review → draft → awaiting-review with new content addressing the feedback. Bounded at 3 revisions; the 4th attempt refuses with an escalation message. Amendment flow + escalate-within-plan (§12) defer to Phase 2 — they need daemon-driven background execution to pause/resume plans, which lands alongside Analyst's signal collectors.
5. **`yarn jarvis cost`** (§18). Per-plan / per-agent **call count + token volume + duration** readout from the `events` table. Defaults to a daily cap (Phase 1: 150 calls/day) since agents run under your Claude Code subscription — see §18 for the resource model. `total_cost_usd` from each agent run is shown as informational only.
6. **Slack adapter (foundation)**: Socket Mode bot, `#jarvis-inbox` + `#jarvis-alerts` channel split, Block Kit for **plan-review** (improvement / impl / business / marketing single-post), action handlers for approve / revise / reject, slash commands `/jarvis plan` and `/jarvis bug`. Block Kit for setup-task / amendment / escalation / scheduled-post review **deferred** to Phase 1.5 or absorbed into Phase 2.
7. **`yarn jarvis onboard --app <name> --repo <path> [--monorepo-path <subdir>] [--vault <vault-name>] [--docs <paths-or-urls>...] [--docs-keep <paths-or-urls>...]`** (§10). Strategist drafts an initial brain from repo inspection + absorbs docs (local files + public URLs). Authenticated sources (Drive, Notion) deferred to Phase 2.

**Deferred from Phase 1:**

- **Humanizer tool** — moved to Phase 3 alongside Marketer (no caller in Phase 1; deduplicates the previous double-listing).
- **Umami install** — moved to Phase 2 alongside Analyst's signal collectors (the data is only useful once Analyst can read it).
- **Slack Block Kit beyond plan-review** — landed in Phase 1.5/2 as the use cases arrive.

**Exit:** `erdei-fahazak` is onboarded as the first real app, plans of all three types flow through Slack plan-review, and at least one real-project plan has shipped to main.

### Phase 2 — Analyst + Scout (Week 5–6) — complete (modulo external)

**Shipped (PRs #17–#43):**

- ✅ **Analyst** — signal collector framework + `yarn-audit`, `broken-links`, and `content-freshness` collectors (PRs #17, #21, #22). Hourly daemon sweep across every onboarded app with `brain.repo` configured (#18). Auto-draft hand-off to Strategist when signals at/above a severity threshold land (#19). Suppressions table with glob pattern matching (#20, #24) plus per-tick GC of expired/cleared rows (#23). Per-vault SQL signals listing CLI (#25). Post-merge observation primitive `observeImpact` + auto-fire on `shipped-pending-impact` plans aged ≥24h (#28, #29). Weekly triage report (CLI `yarn jarvis triage` + daemon-driven Monday-morning file write at `<dataDir>/triage/<date>.md`, PRs #26, #27).
- ✅ **Scout** — `Business_Ideas.md` format + parser (#30). LLM-driven scoring with strict `<score>` JSON protocol (#31). Top-N recommendations in the triage report with an "unscored" hint that drives the user to `yarn jarvis scout score` (#32). Auto-draft of high-scoring ideas to Strategist via `yarn jarvis scout draft` (#33).
- ✅ **§12 amendment flow + escalate-within-plan** — AMEND text protocol from Developer, checkpoint capture, plan-body update, `[AMEND]` inbox tag, auto-resume from checkpoint after approval, checkpoint cleanup on reject (PRs #34–#36). Slack amendment review surface with proposal context + approve/revise/reject buttons (#38). See §12 for the full implementation status.
- ✅ **Slack-primary buildout** — Slack now surfaces every actionable plan event and every notable system event:
  - **Amendment review surface** in `#jarvis-inbox` (#38)
  - **Critical-signal alerts** to `#jarvis-alerts` with severity tag + Suppress button (#39)
  - **Triage delivery** to `#jarvis-inbox` (file + Monday-morning post, with the daemon's weekly job) (#40)
  - **Setup tasks** as Block Kit with Mark done / Skip… buttons + skip-reason modal; new `orchestrator/setup-tasks.ts` primitives (#41)
  - **Slash commands** — `/jarvis plan|bug|inbox|triage` (#42)
  - **Runtime escalation alerts** to `#jarvis-alerts` for rate-limit hits and cash-in violations, with Acknowledge button + audit event; `recordEscalation` primitive in `orchestrator/escalations.ts` (#43)

**Deferred to later phases:**

- **Marketer in executor pool** — blocked on the Phase 3 Marketer agent build.
- **Umami install + metrics collector** — needs a Vercel deploy + Supabase Postgres + script tags on apps. Code-side metrics collector lands once the deploy is in place; until then the Umami API call returns no data.
- **Scheduled-post review** Slack surface — depends on Marketer (Phase 3).
- **Slash-command coverage gaps** — `/jarvis scout score|draft`, `/jarvis scan`, `/jarvis approve|revise|reject <id>` aren't slash-aliased yet. Buttons cover the approve/revise/reject path; the rest lands as polish if/when the typing rate justifies it.
- **Multi-vault Slack channel mapping** — current architecture assumes one inbox + one alerts channel for the whole portfolio; multi-vault mapping is a Phase 4+ refinement.

**Exit (met):** Slack is the primary inbox. Every plan review, amendment, signal alert, triage report, setup task, and runtime escalation reaches the user in `#jarvis-inbox` or `#jarvis-alerts` with enough context to decide approve / revise / reject / acknowledge without dropping into the CLI. The original Phase 2 exit (Monday triage report influencing what plan gets drafted next) shipped via the Analyst + Scout tracks; the Slack-primary buildout makes that surface the default channel.

### Phase 2.5 — Conversational interface (between Phase 2 and Phase 3)

**Goal:** make Jarvis feel like a peer, not a CLI. Lower the friction on three axes: free-form context capture, plan size, and how the user gives direction.

**Scope:**

1. **Plan size cap relaxation** — prompts in `prompts/strategist-*.md` drop "one page max" / "3-5 lines per section". Plans run as long as needed for clarity (see §4): every subsystem named, rollback at a level a different engineer could execute, but no padding. Trade-off: the original cap guarded against rambling plans; we accept that risk to recover detail.

2. **Free-text notes** — each app gets a `notes.md` at `<dataDir>/vaults/<vault>/brains/<app>/notes.md`. The user appends free-form thoughts whenever, and Strategist / Scout / Developer all read it into their context. Mental model: the meeting whiteboard for the project; the brain (§7) stays the structured spec. New CLI: `yarn jarvis notes <app> [--append "..."]`. New Slack: `/jarvis notes <app> <text>`.

3. **Natural language → commands** — single LLM call routes free-text requests like "what's on fire?" into existing commands (here: `triage`). Ambiguous requests get a clarifying question rather than a guess. Destructive ops (approve / reject / cancel) require an explicit button confirm. New CLI: `yarn jarvis ask "<text>"`. New Slack: `/jarvis ask "<text>"`. Removes the "memorize every subcommand" burden — `--help` becomes a fallback, not a daily tool.

4. **Discussion mode** — multi-turn, multi-agent, multi-output conversation in a Slack thread or a CLI loop. Strategist leads; Scout / Analyst / Marketer pulled in by topic. Outputs include a plan draft, a `Business_Ideas.md` entry, a note appended (per #2), a setup task, or just a closed conversation. Logged as `conversation` events. New CLI: `yarn jarvis discuss --app <name>`. Slack: `/jarvis discuss <app> "<topic>"` opens a thread. Turn cap 20 with explicit "wrap this up" exit. Replaces the original `chat` command (which was specced but unbuilt — see §17).

**Recommended order:** 1 → 2 → 3 → 4. #1 is a tiny prompt edit; #2 is foundational (other features read notes); #3 removes the memorize-every-command burden; #4 lands last because it's the biggest and benefits from #2 (notes as one possible output) and the docs system below (notes alone aren't enough for grounded discussion).

**Companion track — docs system** (`docs add / list / refresh / reabsorb / remove`). Already specified in §10 + §17 but unbuilt. Lands as part of Phase 2.5 since adding a URL / PDF / file is a natural extension of adding a note. Two modes:

- **Cache mode** (`docs add --keep <path-or-url>`) — retains full content, refreshes on TTL. Useful for living references (a partner's API docs, an evolving brand guide).
- **Absorb mode** (`docs add <path-or-url>`) — drafts a brain-update plan from doc content. Useful for one-shot artifacts (a kickoff brief, a competitor PDF).

**Exit:** the user can run a full daily session in Slack — open a discussion, drop a note, ask a natural-language question, see the output — without remembering any specific command name. Plans are detailed enough to execute against.

### Phase 3 — Marketer + marketing plan loop (Week 7–8)

- Marketer agent
- Facebook tool (requires setup task per Page; per-app credentials via `brain.connections.facebook`)
- **Extend Strategist** to draft marketing plans, including subtype detection from the brief (campaign vs single-post)
- Marketing plan templates (both subtypes) + execution routing
- **Humanizer tool** (`jarvis/tools/humanizer.ts`) — loads style rules from the Wikipedia "Signs of AI writing" guide; Marketer calls it as a final pass on every post draft, Developer calls it when a plan modifies user-facing text
- Retry / backoff in the post-publisher for transient adapter failures (5xx / 429 / network) before marking a row failed
- First marketing campaign shipped

**Exit:** a real marketing plan approved, executed, with posts live and tracked.

**Deferred to post-Phase-3 (nice-to-have, not blocking exit):**

- **Instagram adapter** — mirrors the FB adapter shape, but IG Graph API has a two-step flow (create container, then publish). Same per-app `brain.connections.instagram` pattern as FB. Lands when an IG-first project arrives.
- **Image / video uploads on Facebook** — `/photos` + `/videos` endpoints. Today posts with non-empty `Assets:` fail loud rather than silently text-publishing.
- **Schedule rules consultation** (`brain.marketing.scheduleRules` per §10) — preferredHours / allowedDays / blackoutDates to pick `scheduledAt` automatically. Today posts use the entry's `Date:` + a fixed 09:00 UTC default.

### Phase 4 — Full self-improvement flywheel (Week 9+)

**Note:** self-improvement against `jarvis/` started in Phase 0 (every Phase 0–3 capability you ship is itself a self-improvement plan you reviewed). Phase 4 closes the **autonomous** flywheel — meta plans flowing without you initiating them.

- Daily self-audit (gated on 7-day project throughput per §5) running on schedule
- Analyst's learning loop on the feedback store running weekly + on-demand (`yarn jarvis learn --scan`)
- Meta plans flowing for brain / profile / prompt / threshold updates without you prompting them
- Self-telemetry (plan-success rate, your override rate, escalation frequency, bug rate per shipped plan, context-efficiency, feedback patterns) feeding the proposals

**Exit:** in a representative week, Jarvis proposes ≥1 meta plan unprompted that demonstrably improves a quality metric (override rate drops, escalation frequency drops, plan-success rate climbs).

### Phase 5 — Public proof / showcase (Week 12+)

**Goal:** demonstrate Jarvis publicly without exposing any private business data.

Two complementary tracks:

**Track A — Jarvis builds itself in public.**

- Make the `jarvis/` code repo public on GitHub.
- Developer agent's PRs are visible — outsiders see ongoing self-improvement plans, prompt iterations, agent refinements as they happen.
- A clean PR history _is_ the proof: "an agent system that built itself." `jarvis/docs/` (this plan + use cases) doubles as developer documentation.
- All `jarvis-data/` (brains, plans, profile, feedback, secrets) stays private per the §15 split — zero business leakage.

**Track B — A purpose-built public showcase project.**

- Promote `vaults/showcase/` to a public-remote home — at Phase 5 entry, pick the architecture per §15 → "Phase 5 — public showcase architecture" (separate repo or git submodule). The other vaults stay in the private `jarvis-data` repo unchanged.
- Onboard a new project into this vault: `yarn jarvis onboard --app <showcase-name> --vault showcase ...`. E.g., a Hungarian IT community resource: job board, event aggregator, OSS contribution leaderboard, monthly newsletter. Owned by Jarvis from day one.
- The showcase project's code repo is open-sourced; its brain + plans + research live in the `showcase` vault (public via the chosen architecture).
- Marketing plans for the showcase double as content for the personal-brand project (videos / blog posts: "how Jarvis built X this week"). Hits your "become known in Hungarian IT" goal.
- Provides external metrics (visits, signups, GitHub stars, newsletter subs) that demonstrate Jarvis-driven outcomes without exposing your apps or consulting clients.

**What stays private regardless of which track:**

- The `jarvis-data` repo (containing `personal`, `consulting`, and any other private vaults) — pushed only to a private remote you control.
- The gitignored shared root layer (`jarvis.db`, `user-profile.json`, `setup-queue.jsonl`, `sandbox/`, `ideas/`, `logs/`, `.env`, `.daemon.pid`, brain `.lock` files) — never committed, anywhere.
- IT-consulting business details (clients, deliverables, rates) — `consulting` vault inside the private data repo.
- User profile + observed patterns + feedback table + learning-loop history — shared root layer, always gitignored.

**Choice of showcase project deferred** — see §19 → Open items.

### Deferred to later phases

- Cloud scheduled runners (GitHub Actions / Railway)
- Web UI dashboard
- Email notifications (if Slack ever goes down or needs a backup channel)
- Voice interface
- Trello integration (only if plan queue outgrows file-based)
- Doppler (only if `.env` becomes unwieldy)

---

## 17. CLI reference

All commands prefixed `yarn jarvis ...`. Grouped by purpose.

### Setup & lifecycle

| Command                                                                                                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`                                                                                                                                                     | First-time setup. Verifies `claude --version` (fails fast if Claude Code isn't installed or local auth is missing — agents won't run without it). Creates `jarvis-data/` (at `$JARVIS_DATA_DIR` or `../jarvis-data`), writes `.env` stub (no Anthropic key — agents authenticate via the local `claude` CLI per §18), initializes `jarvis.db`, runs migrations from `jarvis/migrations/`, seeds `brains/` structure, runs restore smoke-test. |
| `daemon`                                                                                                                                                      | Start the long-running local process (see §6). Manual start; no OS-level autostart in Phase 1.                                                                                                                                                                                                                                                                                                                                                |
| `doctor`                                                                                                                                                      | Health check: daemon liveness, last scan, last sample, pending inbox, stale locks. Auto-invoked by other commands.                                                                                                                                                                                                                                                                                                                            |
| `doctor --rebuild-brain <app>`                                                                                                                                | Full brain rebuild from events (see §7 update model).                                                                                                                                                                                                                                                                                                                                                                                         |
| `doctor --clear-stale-lock <app>`                                                                                                                             | Manual lock clear if auto-takeover fails.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `onboard --app <name> --repo <path-or-url> [--monorepo-path apps/<name>] [--vault <vault-name>] [--docs <paths-or-urls>...] [--docs-keep <paths-or-urls>...] [--skip-interview]` | Two-phase onboarding (see §10): Phase 1 conversational intake captured to `docs/intake/`, Phase 2 brain extraction from repo + intake + cached docs. `--vault` selects the data vault (default `personal`). `--docs` → absorbed. `--docs-keep` → cached. `--skip-interview` (or non-TTY stdin) bypasses Phase 1.                                                                                                                                                                                                                                                                |
| `vault list`                                                                                                                                                  | Show all vaults: name, project count, default flag. (Git remote / push status applies to the whole `jarvis-data` repo — see `data status`.)                                                                                                                                                                                                                                                                                                   |
| `vault create <name>`                                                                                                                                         | Create a new vault subdirectory under `jarvis-data/vaults/`. No per-vault git init — vaults live in the parent `jarvis-data` repo.                                                                                                                                                                                                                                                                                                            |
| `vault set-default <name>`                                                                                                                                    | Set the default vault for new onboards (when `--vault` is omitted).                                                                                                                                                                                                                                                                                                                                                                           |
| `vault rename <old> <new>`                                                                                                                                    | Rename a vault. Renames the directory (`vaults/<old>/` → `vaults/<new>/`) and updates `vault_id` everywhere in SQLite. Commits the rename to the data repo. Refuses if the new name collides.                                                                                                                                                                                                                                                 |
| `vault delete <name>`                                                                                                                                         | Delete a vault. Refuses if it still contains projects — hint: "move projects out first via `vault move --app <name> --to <other-vault>`." Safe-by-default; never silently drops project data.                                                                                                                                                                                                                                                 |
| `vault move --app <app-name> --to <vault-name>`                                                                                                               | Move a project across vaults safely: (1) pause any executing plan for the app + checkpoint, (2) relocate `brains/<app>/` + `plans/<app>/` between vault dirs, (3) update `app_id` ↔ `vault_id` mapping in SQLite, (4) commit the move in the data repo, (5) resume the plan from checkpoint.                                                                                                                                                  |
| `data status`                                                                                                                                                 | Show `jarvis-data` git status: branch, ahead/behind vs remote, unpushed-change count, oldest unpushed change.                                                                                                                                                                                                                                                                                                                                 |
| `data push`                                                                                                                                                   | Commit pending writes + push the `jarvis-data` repo to its remote (with the §15 push-debounce window).                                                                                                                                                                                                                                                                                                                                        |
| `data pull`                                                                                                                                                   | Pull the `jarvis-data` repo from its remote.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs list --app <name>`                                                                                                                                      | List docs registered for an app (retention, tags, last refresh).                                                                                                                                                                                                                                                                                                                                                                              |
| `docs add --app <name> <path-or-url>`                                                                                                                         | Absorb a new doc. Post-onboarding this drafts a **brain-update plan** for your review; on approval, brain is extended and summary + extracted facts land in `docs.json`.                                                                                                                                                                                                                                                                      |
| `docs add --app <name> --keep <path-or-url>`                                                                                                                  | Cache a new doc; retain full content and refresh on TTL. Does not auto-extend the brain.                                                                                                                                                                                                                                                                                                                                                      |
| `docs absorb --app <name> <id>`                                                                                                                               | Promote an existing cached doc into absorbed mode — drafts a brain-update plan (subtype `meta`) from the doc's full content.                                                                                                                                                                                                                                                                                                                  |
| `docs remove --app <name> <id>`                                                                                                                               | Unregister a doc (local cache removed; anything already baked into the brain stays).                                                                                                                                                                                                                                                                                                                                                          |
| `docs refresh --app <name> [<id>]`                                                                                                                            | Re-fetch cached URL / Drive / Notion docs and regenerate summaries. Absorbed docs aren't tracked for auto-refresh; use `docs reabsorb` to re-extract from an updated version.                                                                                                                                                                                                                                                                 |
| `docs reabsorb --app <name> <id> <path-or-url>`                                                                                                               | Re-supply an absorbed doc (or its replacement) for deeper re-extraction; drafts a new brain-update plan.                                                                                                                                                                                                                                                                                                                                      |
| `profile`                                                                                                                                                     | Show a summary of the current user profile.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `profile edit`                                                                                                                                                | Open `jarvis-data/user-profile.json` in `$EDITOR`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `notes <app>`                                                                                                                                                 | Open `<dataDir>/vaults/<vault>/brains/<app>/notes.md` in `$EDITOR` for free-text project notes. Read by Strategist / Scout / Developer when constructing context. Mental model: meeting whiteboard. The brain stays the structured spec; notes are where you drop in-flight thoughts.                                                                                                                                                         |
| `notes <app> --append "<text>"`                                                                                                                               | Append a timestamped line to the app's `notes.md` without opening the editor. Slack equivalent: `/jarvis notes <app> <text>`.                                                                                                                                                                                                                                                                                                                 |
| `version`                                                                                                                                                     | Print the Jarvis package version (read-only).                                                                                                                                                                                                                                                                                                                                                                                                 |

### Plan workflow

| Command                                                                                                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan --app <name> "<brief>"`                                                                                                                | User-initiated plan draft. Strategist runs once in-process and exits. Add `--type` and `--subtype` to force a kind. Add `--no-challenge` to skip the Socratic gate (escape hatch; tracked in `observedPatterns`).                                                                                                                                                                                                                                                          |
| `plan --app <name> --type marketing --subtype campaign "<brief>"`                                                                            | Full-content time-boxed marketing plan; after your single approval, Marketer executes every post without per-post review.                                                                                                                                                                                                                                                                                                                                                  |
| `plan --app <name> --type marketing --subtype single-post "<brief>"`                                                                         | One post, reviewed individually in `#jarvis-inbox` before publishing.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `plans [--app <name>] [--status <state>] [--type <type>] [--subtype <s>] [--priority <p>] [--since 7d] [--format table\|json]`               | List plans with filters. Read-only; works without daemon. Examples: `plans --status approved` (all approved across portfolio), `plans --status executing --app erdei-fahazak` (in-flight for one app), `plans --status awaiting-review --since 14d` (pending reviews older than 14 days). Default format is a table: id, type/subtype, app, status, priority, last-modified, author.                                                                                       |
| `plans --executing`                                                                                                                          | Convenience alias for `plans --status executing` (across all apps).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `plans --approved`                                                                                                                           | Convenience alias for `plans --status approved` (queued or about to execute).                                                                                                                                                                                                                                                                                                                                                                                              |
| `plans --pending-review`                                                                                                                     | Convenience alias for `plans --status awaiting-review`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `backlog --app <name>`                                                                                                                       | Show two sections: **Product backlog** (capped at 3 improvement plans, ordered by priority — see §5) and **Meta queue** (uncapped; subtype `meta` plans: brain updates, profile updates, prompt tweaks).                                                                                                                                                                                                                                                                   |
| `backlog --app <name> --meta-only`                                                                                                           | Show only the meta queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `backlog --app <name> --no-meta`                                                                                                             | Show only the product backlog.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `reprioritize --app <name> --plan <id> --priority <level>`                                                                                   | Reorder backlog. `<level>` ∈ {low, normal, high, blocking}.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `approve <id>`                                                                                                                               | Approve a plan for execution.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `approve <id> --confirm-destructive`                                                                                                         | Required when plan has `Destructive: true` (see §13).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `revise <id> "<feedback>"`                                                                                                                   | Send the plan back to `draft` with your feedback. Strategist redrafts and re-surfaces in `awaiting-review` with revision count incremented. Distinct from `reject` — keeps the plan alive. Default revision cap: 3; beyond that, escalation.                                                                                                                                                                                                                               |
| `reject <id> [--category <cat>] [--note "..."]`                                                                                              | Reject the plan; suppression rule applies per §8. Use `revise` instead if you want a redraft.                                                                                                                                                                                                                                                                                                                                                                              |
| `run developer <plan-id>`                                                                                                                    | Fire Developer on a plan. Auto-detects mode from the plan's `Type` + `ImplementationReview`: improvement plan with `ImplementationReview: required` (or `auto`-resolved-to-required) → drafts the implementation plan; implementation plan, or improvement plan with `ImplementationReview: skip` → executes (branch → write → typecheck → test → commit → push → PR). Phase 0 fires manually after each `approve`; Phase 1+ daemon will auto-trigger on plan transitions. |
| `run <agent> <task>`                                                                                                                         | Direct agent invocation for other agents (testing, manual operation).                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run <agent> <task> --dry-run`                                                                                                               | Developer / Marketer only: produce outputs with no side effects.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cancel <id>`                                                                                                                                | Cancel an in-flight plan; transitions to `cancelled` (terminal). Logged as feedback for the learning loop.                                                                                                                                                                                                                                                                                                                                                                 |
| `bug --app <name> "<description>" [--repro <file>] [--expected "..."] [--actual "..."] [--severity high\|normal\|low] [--related-plan <id>]` | Report a bug. Strategist drafts a `subtype: bugfix` improvement plan; severity maps to priority. Bug report logged to feedback store and counted toward Developer's bug-rate telemetry if attributable to a shipped plan. Slack equivalent: `/jarvis bug <app> ...`.                                                                                                                                                                                                       |
| `post edit <post-id> [--file <path> \| --inline "<text>"] [--post-publish]`                                                                  | Edit a scheduled or published post. Pre-publish: updates the `scheduled_posts` row + plan content. Post-publish: calls the platform edit API where supported (FB, X). Edit logged as feedback.                                                                                                                                                                                                                                                                             |
| `post reschedule <post-id> --to <ISO-datetime>`                                                                                              | Move a pending post's `scheduled_at`. Honors brain `marketing.scheduleRules`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `post skip <post-id> [--reason "..."]`                                                                                                       | Mark a pending post as `skipped` (won't publish).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `post list --app <name> [--status pending\|published\|failed]`                                                                               | List scheduled posts for an app.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pause --app <name>`                                                                                                                         | Stop generating new improvement plans for this app until you `resume`. Existing in-flight plans continue. Shortcut for `project status --status paused`.                                                                                                                                                                                                                                                                                                                   |
| `resume --app <name>`                                                                                                                        | Re-enable improvement plan generation. Shortcut for `project status --status active`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `project priority --app <name> --weight <1-5>`                                                                                               | Set project's relative priority (default 3). Higher = more triage attention. See §9 → Portfolio attention.                                                                                                                                                                                                                                                                                                                                                                 |
| `project status --app <name> --status <active\|maintenance\|paused>`                                                                         | Set project status: `active` (full attention), `maintenance` (security/deps only), `paused` (no new plans).                                                                                                                                                                                                                                                                                                                                                                |
| `project list [--status <s>]`                                                                                                                | List all onboarded projects with their priority, status, and last-executed-plan timestamp.                                                                                                                                                                                                                                                                                                                                                                                 |

### Inbox & setup queue

| Command                                    | Purpose                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox`                                    | Show pending plan reviews, PRs, setup tasks, amendments, escalations.                                                                                                                                           |
| `setup`                                    | Work through the setup queue interactively.                                                                                                                                                                     |
| `setup --done <task-id>`                   | Mark a single setup task complete.                                                                                                                                                                              |
| `setup --skip <task-id>`                   | Skip a setup task (with reason).                                                                                                                                                                                |
| `dnd [--until <date>] [--note "<reason>"]` | Enter Do-Not-Disturb. Slack notifications mute; inbox queues silently; in-flight plans pause at next safe checkpoint. On exit (or `dnd --off`), pending items surface as a single "while you were away" digest. |
| `dnd --off`                                | Exit DND immediately; trigger the catch-up digest.                                                                                                                                                              |

### Project review & status

| Command                                              | Purpose                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review --app <name>`                                | Strategist + Scout produce a consolidated review (current state, business plan, risks, backlog, post-merge outcomes, alternatives) and enter an interactive back-and-forth in Slack thread or CLI. Output is optionally a new business plan update or a cluster of improvement plan proposals. |
| `status --app <name>`                                | Consolidated snapshot: app spec from brain, active business plan, active/upcoming marketing plans, recent metrics + trends, open improvement backlog, pending setups, recent plan outcomes, tripped breakers, active suppressions. Read-only — works without daemon.                           |
| `ideas add [--vault <v>]`                            | Conversational interview that captures one new idea, then appends a structured section to `Business_Ideas.md`. Pulls out the signal Scout uses (strategic fit, effort, impact, dependencies) so scoring isn't guesswork. Records an `idea-added` event. Driven by [`prompts/strategist-idea-intake.md`](../prompts/strategist-idea-intake.md) + [`agents/idea-intake.ts`](../agents/idea-intake.ts). Refuses without a TTY.                |
| `ideas list [--format table\|json]`                  | Show every idea with its score, sorted high → low (unscored last). Marks ideas that already have an auto-drafted plan via the `idea-drafted` event. Default format is a vertical block per idea.                                                                                               |
| `scout score [--vault <v>]`                          | Score every unscored idea in `Business_Ideas.md` via Scout. Writes score, scoredAt, rationale back into the file; records one `idea-scored` event per idea. Re-scoring requires deleting the `Score:` line.                                                                                    |
| `scout draft [--threshold N] [--vault <v>]`          | Auto-draft a Strategist plan for each idea scoring ≥ threshold (default 80) and not already drafted. Records `idea-drafted` events; idempotent on idea id.                                                                                                                                     |
| `triage [--format markdown\|json] [--window-days N]` | Portfolio summary: critical signals not yet drafted, plans awaiting review, stuck plans, quiet apps, expiring suppressions, top Scout recommendations. Default 7-day window. The daemon also writes the report to `<dataDir>/triage/<YYYY-MM-DD>.md` every Monday at 9am local.                |

### Open channels (no plan commitment)

| Command                                                                                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discuss --app <name>`                                                                                             | Multi-turn, multi-agent, multi-output conversation — the way two co-owners talk in a meeting. Strategist leads; Scout / Analyst / Marketer pulled in by topic. Outputs include a plan draft, a `Business_Ideas.md` entry, a note appended (see `notes`), a setup task, or just a closed conversation. Logged as `conversation` events. Turn cap 20; explicit "wrap this up" exit at any point. Slack: `/jarvis discuss <app> "<topic>"` opens a thread. Replaces the original `chat` command (specced but unbuilt). |
| `ask "<text>"`                                                                                                     | Translate a natural-language request into one or more Jarvis commands and run them (with button confirm gate for destructive ops). Useful when you don't remember the exact subcommand. Slack: `/jarvis ask "<text>"`.                                                                                                                                                                                                                                                                                              |
| `review-content --app <name> [--file <path> \| --inline "<text>"] [--format post\|blog\|video-script\|newsletter]` | Hand Jarvis a draft for critique. Marketer (and Strategist where relevant) return annotated feedback or proposed rewrite. No plan is created.                                                                                                                                                                                                                                                                                                                                                                       |

### Observability

| Command                                                                                                              | Purpose                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeline`                                                                                                           | Unified activity feed. Filters: `--plan <id>`, `--agent <name>`, `--kind signal\|plan\|pr\|cost`, `--since 24h`.                                                                                                                                                                                                                     |
| `cost`                                                                                                               | Call count + token volume + cache hit rate per plan / agent / model for the current month. Daily cap (default 150 calls/day) since agents run under the subscription. `total_cost_usd` shown for informational tracking. Flags `--cap <N>`, `--warn-at <ratio>`, `--by-day`, `--format table\|json` per §18.                         |
| `logs tail [--file <path>]`                                                                                          | Stream today's daemon log (`tail -f`-style). `--file` overrides the default log path.                                                                                                                                                                                                                                                |
| `scan --app <name> [--vault <v>]`                                                                                    | Run signal collectors against an onboarded app: `yarn-audit`, `broken-links`, `content-freshness`. Records each finding as a `signal` event. Exits non-zero on any high/critical severity (CI / pre-commit friendly).                                                                                                                |
| `signals [--app <n>] [--vault <v>] [--kind <k>] [--severity <s>] [--since <iso>] [--limit N] [--format table\|json]` | Browse recorded signal events. Most-recent-first. Default limit 50.                                                                                                                                                                                                                                                                  |
| `observe-impact <plan-id> [--vault <name>]`                                                                          | Post-merge "did the fix hold?" check. For a plan in `shipped-pending-impact`, re-runs collectors and transitions the plan to `success` if the original triggering signal is gone, `null-result` if still present. Records an `impact-observed` event with the verdict. Daemon also auto-fires this on plans aged ≥24h in that state. |

### Suppression & circuit breaker

| Command                                                 | Purpose                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suppress <pattern> [--reason "..."] [--expires <iso>]` | Mute auto-draft for matching signals. Pattern may use glob wildcards (`*` zero+ chars, `?` one char). Examples: `yarn-audit:CVE-2026-1234` (exact); `yarn-audit:CVE-2026-*` (CVE family).                                                     |
| `unsuppress <pattern>`                                  | Lift an active suppression. Match is exact on the stored pattern (pass the same string used at `suppress` time). Equivalent to the spec's `unblock`.                                                                                          |
| `suppressions [--all]`                                  | List active suppressions. `--all` includes cleared (soft-deleted) rows.                                                                                                                                                                       |
| `suppressions cleanup [--older-than N]`                 | Hard-delete cleared/expired rows beyond the retention window (default 90 days). Daemon runs this once per analyst tick; the CLI subcommand is for one-off cleanup or testing.                                                                 |
| `breakers [--tripped] [--format table\|json]`           | List all agent circuit breakers with state (active / paused), scope (for Strategist's code vs meta split), threshold, current rolling rate, last-N outcome summary, and tripped-at timestamp if paused. `--tripped` shows only paused agents. |
| `unpause <agent> [--scope <code\|meta\|both>]`          | Unpause an agent that tripped its quality circuit breaker (see §13). Default `both`; scope distinguishes Strategist's code vs meta windows (no-op for other agents).                                                                          |

### Feedback & learning

| Command                          | Purpose                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feedback`                       | Show recent feedback events. Filters: `--target <plan-id \| agent>`, `--kind <reject \| approve \| answer \| modify \| comment>`, `--since 24h`.       |
| `feedback forget <id>`           | Mark a feedback entry as excluded from future learning passes (not deleted; auditability preserved).                                                   |
| `comment --target <id> "<note>"` | Log a free-form feedback entry against a plan, agent, or signal.                                                                                       |
| `learn --scan`                   | Trigger an ad-hoc pass over the feedback store. Analyst produces improvement plans if patterns warrant. Normally runs weekly via the learn-tick service.    |
| `learn --preview`                | Dry-run — show current feedback clusters and draft plan ideas without creating plans. Useful for sensing whether feedback has been "heard."            |

### Slack slash equivalents

| Slash command                       | Equivalent CLI                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/jarvis plan <app> <brief>`        | `yarn jarvis plan --app <app> "<brief>"`                                                                                                                                                                                  |
| `/jarvis bug <app> <description>`   | `yarn jarvis bug --app <app> "<description>"` — drafts a `subtype: bugfix` improvement plan.                                                                                                                              |
| `/jarvis inbox`                     | `yarn jarvis inbox` (rendered as Slack blocks, ephemeral).                                                                                                                                                                |
| `/jarvis triage`                    | `yarn jarvis triage` posted in-channel (visible to the room).                                                                                                                                                             |
| `/jarvis scout score`               | `yarn jarvis scout score`                                                                                                                                                                                                 |
| `/jarvis scout draft [--threshold N]` | `yarn jarvis scout draft [--threshold N]`                                                                                                                                                                                |
| `/jarvis ideas add`                 | `yarn jarvis ideas add` — opens a thread; each thread reply is one user answer. Saves to `Business_Ideas.md` when the agent emits `<idea>`. Persistence: `idea-intake-started` / `idea-intake-message` / `idea-intake-closed` events. |
| `/jarvis ideas list`                | `yarn jarvis ideas list` — ephemeral message, mrkdwn formatting.                                                                                                                                                          |
| `/jarvis daily-audit [--dry-run] [--force]` | `yarn jarvis daily-audit ...` — manually fires the audit. Daemon already runs it once per day; this is for testing the gates or seeing the bundled brief.                                                          |
| `/jarvis project-audit --app <name> \| --all [--dry-run] [--force]` | `yarn jarvis project-audit ...` — manually fires the per-app project audit. Daemon runs hourly; each app's 24h idempotency gate enforces once-per-day. `--app` targets one app; `--all` runs all non-jarvis apps. `--dry-run` records event but skips Strategist; `--force` bypasses app-paused, already-ran-recently, and no-context gates. |
| `/jarvis notes <app> <text>`        | `yarn jarvis notes <app> --append "<text>"`                                                                                                                                                                               |
| `/jarvis ask "<text>"`              | `yarn jarvis ask "<text>"`                                                                                                                                                                                                |
| `/jarvis discuss <app> "<topic>"`   | `yarn jarvis discuss --app <app> "<topic>"` — opens a thread; replies become user turns. Shares the `app.message` thread router with `ideas add`.                                                                         |
| Plan-review buttons in Slack        | `approve`, `reprioritize`, reject-with-category                                                                                                                                                                           |
| Setup-task buttons in Slack         | `setup --done`, `setup --skip`                                                                                                                                                                                            |
| Suppression-digest buttons          | `unblock`                                                                                                                                                                                                                 |

---

## 18. Resource model

Jarvis runs every agent under the user's existing Claude Code subscription (Pro or MAX). The runtime is the `@anthropic-ai/claude-agent-sdk` driving the local `claude` CLI subprocess; the subprocess inherits auth from `~/.claude/`. **There is no `ANTHROPIC_API_KEY`, no per-token billing, and no separate Anthropic account for Jarvis.** This section explains what _is_ metered (subscription rate limit) and how the daemon stays a good citizen.

### What's metered

- **Rate limit, not dollars.** Claude Code subscriptions (Pro and MAX) have a 5-hour rolling rate-limit window — every Claude call (yours, Jarvis's) shares that bucket. There is no monetary cost per call.
- **Cap is now `calls/day`.** Default 150 calls/day across all agents (Strategist + Developer + Marketer + Analyst + Scout combined). Tunable via `yarn jarvis cost --cap <N>`. Approaching the cap → non-critical agents pause; `#jarvis-alerts` escalation. **Hard cap is per UTC day**, not rolling; resets at 00:00 UTC.
- **Subscription rate-limit handling.** The Agent SDK emits `SDKRateLimitEvent` and surfaces `error: 'rate_limit'` on assistant messages. The agent-runtime wrapper translates either into a `RateLimitedError`. The plan-executor catches it, pauses Developer fires, posts to `#jarvis-alerts` with the reset time, and resumes automatically when the window opens. Other agents' fires are also paused for the duration.

### Telemetry (still collected, semantics shifted)

Every agent run is recorded as an `agent-call` event in `jarvis.db` with:

- `agent`, `planId`, `model`, `numTurns`, `durationMs`, `permissionDenials`
- `usage`: `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheCreationTokens` (still tracked — useful as an effort signal, surfaces caching effectiveness)
- `totalCostUsd`: returned by the SDK on the result message; **informational only** under the subscription. Aggregate it for "what would this have cost on the API" reporting; do not use it for cap enforcement.

`yarn jarvis cost` shows:

- Total calls today / month, with `--cap <N>` warning at the configured ratio (default 80%)
- Cache hit rate (single most actionable knob — high cache rate = cheap calls, low = prompt assembler needs tightening)
- Token volume per plan / agent / model
- `total_cost_usd` aggregate (informational; labeled "would-have-been API cost")
- `--by-day` opt-in for the daily breakdown
- `--format json` for scripting

### Expected agent volume (Phase 1)

| Agent                                           | Typical fires/day              |
| ----------------------------------------------- | ------------------------------ |
| Strategist (drafts + redrafts + clarifications) | 5–15                           |
| Developer (impl plan drafts + execute fires)    | 3–8, each consuming many turns |
| Onboard (Strategist variant)                    | only on `yarn jarvis onboard`  |
| Future Analyst / Scout / Marketer               | TBD per phase                  |

A typical Developer execute fire spans many `numTurns` (each turn = one Claude call), so the practical daily ceiling is set more by **turns** than by **fires**. The default 150-call cap accommodates 5 Developer fires of ~20 turns each plus 50 Strategist/clarification calls — well within MAX's 5-hour rolling window for typical use.

### Safety against runaway loops

- **Per-fire `maxTurns` cap.** Set on every `query()` call. Default 60 (Developer execute), 30 (Strategist draft), 15 (Strategist redraft). Hits → SDK returns `result.subtype: "error_max_turns"`; plan transitions to `BLOCKED`; alert.
- **Per-day `maxCalls` cap.** Aggregate of all agent calls across the daemon. Default 150. Hits → daemon pauses the plan-executor service; alert. Resumes at 00:00 UTC.
- **Subscription rate-limit pause.** On `SDKRateLimitEvent`, plan-executor pauses; resumes at the reset time the SDK reports.

### Why no per-dollar cap

The subscription is flat-rate; spending more or fewer turns doesn't change the bill. The actual scarce resource is **rate-limit headroom shared with the user's interactive work** — capping calls/day directly is the right surrogate.

### Migration note

Pre-pivot deployments have `agent-call` events recorded with API per-token billing semantics. The `cost` command treats both formats: events emitted before the pivot show their original USD; events after show subscription-mode telemetry. The `byMonth` and `byDay` rollups annotate which mode each event used.

---

## 19. Open items

Pick up these when relevant — none blocks Phase 0.

1. **First notification channel beyond CLI** — Slack, email, native OS notification? Decide when CLI inbox friction appears.
2. **Trello or file-only plan board** — stay file-based until plan volume demands a board view.
3. **Search API for Analyst research** — Tavily vs Brave vs Firecrawl. Mock interface in Phase 2, pick when real research calls start.
4. **Authentication for Jarvis itself** — Phase 1 assumes only you run it locally. If you ever add a web UI or remote trigger, needs auth design.
5. **Error observability tool** — JSONL logs + CLI grep is Phase 1. If multi-agent debugging gets painful, consider a proper trace viewer.
6. **Plan-quality feedback loop** — how the Strategist learns from approved vs rejected plans. Phase 4 territory.
7. **OS-level daemon autostart** (launchd on macOS) — deferred. Accept manual `yarn jarvis daemon` start for now. Reconsider after a few weeks of real use if "I forgot to start" becomes annoying.
8. **Phase 0 seed self-improvement** — pick a concrete first improvement plan against the `jarvis` project itself before starting Phase 0 build (so there's a real target for the first self-bootstrap run). Candidate shapes: "add a `status --app` summary command", "tighten the Strategist plan-length prompt", "add a Slack message preview for plan reviews". User picks.
9. **Vector DB for doc / research retrieval** (e.g., `pgvector` on existing Supabase) — defer. Revisit only when self-telemetry shows retrieval-miss rate > 10%, or doc + research corpus exceeds ~100 entries per app. Tag-based retrieval is sufficient at smaller scale.
10. **Phase 5 showcase project pick** — choose a purpose-built public project to onboard as proof Jarvis works. Candidates: Hungarian IT job board, conference / meetup event aggregator, OSS contribution leaderboard for Hungarian devs, monthly Hungarian IT newsletter. Constraints: small, open-sourceable, provides a clear content angle for the personal-brand project. Decide when Phase 4 (full self-improvement flywheel) is stable.

---

_End of plan. Start with Phase 0 Week 1._
