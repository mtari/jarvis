# Jarvis — Use Cases

Format: **User wants to X.** Constraint or context.

---

## Installation & setup

1. **User wants to install Jarvis for the first time.** Runs `yarn jarvis install`; Jarvis creates `jarvis-data/` at `$JARVIS_DATA_DIR` (or `../jarvis-data`), writes `.env` stub, initializes SQLite, runs migrations.
2. **User wants to start the daemon.** Manual `yarn jarvis daemon`; no OS-level autostart in Phase 1.
3. **User wants to check system health.** `yarn jarvis doctor` reports daemon liveness, last scan, pending inbox, stale locks.
4. **User forgot to start the daemon after reboot.** Any CLI command auto-invokes `doctor` and prints a start reminder.
5. **User wants to recover from a stale file lock.** `doctor --clear-stale-lock <app>` as manual fallback; auto-takeover handles most cases.
6. **User wants to rebuild a corrupted brain.** `doctor --rebuild-brain <app>` scans events, regenerates `brain.json` from scratch.
7. **User wants to verify backups are restorable.** Monthly automated smoke test; first run during `install`.

## App onboarding

8. **User wants to onboard a project. Onboarded project is a normal repo, so it only contains one single project.** `yarn jarvis onboard --app <name> --repo <path-or-url>` — Strategist inspects the repo root, drafts a brain, user reviews and commits.
9. **User wants to onboard a project. Onboarded project is in a monorepo, so it contains multiple projects.** `yarn jarvis onboard --app <name> --monorepo-path apps/<name>` — Strategist detects the target app's subpath from workspace config and scopes inspection to that directory only; other sibling projects are ignored for this brain.
10. **User wants to onboard an existing app with live traffic.** Umami script tag added during Phase 1; 2–4 weeks of baseline accrues before Phase 2 signals go live.
10a. **User wants Jarvis to interview them about the project before drafting the brain.** Phase 1 of `yarn jarvis onboard` — interactive 50+ section conversation (origin story, traction, business model, risks, vision). Captured to `docs/intake/content.txt` and registered as a cached doc. Phase 2 brain extraction reads it back. Type `/skip` per question, `/end` to wrap up early.
10b. **User wants to skip the intake interview.** `yarn jarvis onboard --app <name> --repo <path> --skip-interview` — Phase 2 runs without an intake. Auto-skipped when stdin isn't a TTY (CI, daemon, tests).
11. **User wants to evaluate an idea from Business_Ideas.md.** Scout scores it against market + preferences; surfaces in next weekly triage.
11a. **User wants to add a new idea conversationally.** `yarn jarvis ideas add` (or Slack `/jarvis ideas add` — opens a thread; replies become answers). Walks 5–6 cluster questions covering audience, why-now, expected outcome, effort, risks. Appends a structured section to `Business_Ideas.md` so Scout can score it without guessing.
11b. **User wants to see all ideas with scores at a glance.** `yarn jarvis ideas list` (or `/jarvis ideas list`). Sorted high → low; unscored last. Marks ideas that already have an auto-drafted plan.
12. **User wants Scout to generate new ideas.** Scout scans market signals + user's stated domains; adds scored candidates to `jarvis-data/ideas/`.

## Plan creation

13. **User wants an improvement via one-liner brief.** `yarn jarvis plan --app <name> "Add booking calendar"` — Strategist drafts; thin briefs list uncertainties under `Open questions`.
14. **User wants a plan from a detected signal.** Analyst signal crosses threshold → Strategist auto-drafts → inbox.
15. **User wants a plan from Scout's triage.** Monday digest picks approved → Strategist drafts.
16. **User wants a business plan update.** Quarterly cadence or Scout-proposed pivot.
17. **User wants a month-long marketing campaign.** `--type marketing --subtype campaign "April 2026"` — full content, one-time review, autonomous execution.
18. **User wants a single marketing post.** `--type marketing --subtype single-post "react to competitor launch"` — reviewed individually.
19. **User wants a self-improvement plan.** `--app jarvis "add brain-migration dry-run support"`.
20. **User wants a rollback plan after a regression.** Analyst auto-drafts (≥20% drop) or proposes after minor regression.

## Plan review & approval

21. **User reviews a plan in Slack.** Block Kit message with Approve / Modify / Reject buttons.
22. **User rejects a plan with a reason.** Category picker: not-worth-effort / signal-unreliable / wrong-timing / duplicate-of-approved / scope-wrong / other.
23. **User wants to modify a plan before approving.** `yarn jarvis revise <id> "drop the multi-property scope; just single-property bookings for v1"` (or Slack Revise button + free-form feedback). Strategist redrafts and re-surfaces in awaiting-review; revision count increments. Distinct from reject — keeps the plan alive. Default cap: 3 revisions, then escalation if still not converging.
24. **User wants to approve a destructive plan.** Second confirmation required: Slack button or CLI `--confirm-destructive`.
25. **User wants to see the 3-plan backlog for an app.** `yarn jarvis backlog --app <name>`.
26. **User wants to reprioritize the backlog.** `yarn jarvis reprioritize --app <name> --plan <id> --priority <level>` or Slack reorder.
27. **User wants to force a plan to run now.** Set `Priority: blocking` — preempts current WIP, pauses the active plan.

## Plan execution

28. **User wants a plan to execute after approval.** Developer branches, commits, opens PR with manual-test section. For improvement plans where `ImplementationReview` resolves to `required` (default for `new-feature` / `rework`), Developer first drafts an **implementation plan** (technical HOW: file changes, schema, deps, tests, risk) — separate one-page artifact reviewed via the same approve / revise / reject flow. Coding starts only after the implementation plan is approved.
29. **User wants to see PRs awaiting review.** Inbox surfaces them with test plan embedded.
30. **User wants to manually test a PR before merging.** PR has `## Manual test plan` section.
31. **User wants to merge the PR.** Only you can — no auto-merge, even on green CI.
32. **User wants to dry-run an agent.** `run <agent> <task> --dry-run` — Developer/Marketer produce outputs with no side effects.

## Amendment, escalation, recovery

33. **Executor discovers the plan was wrong mid-flight.** Amendment drafted, surfaces in inbox, user approves/rejects/modifies.
34. **Agent hits a missing connection.** Plan → `blocked` state; setup task queued to `setup-queue.jsonl`.
35. **Agent times out (>30 min).** Escalates, releases lock, logs state.
36. **Agent can't meet acceptance criteria.** Halts; surfaces escalation with three proposed paths.
37. **User is on holiday; system hits a block.** Escalation queues silently; on return, CLI/Slack shows pending.
38. **User wants to cancel an in-flight plan.** CLI or Slack → plan → `cancelled` (terminal).

## Post-merge observation

39. **User merges a PR.** Analyst starts observation window (daily for ≤30d, weekly for >30d).
40. **Analyst detects a minor regression (<20%).** Flags to `#jarvis-inbox`; user decides.
41. **Analyst detects a major regression (≥20%).** Auto-drafts rollback plan to `#jarvis-alerts` for approval.
42. **Observation window closes.** Plan tagged success / null-result / regression; feeds self-telemetry.
43. **User wants to see what shipped this month worked.** `timeline --kind plan` or per-plan status check.

## Marketing

44. **User asks Jarvis to create a marketing plan for a time (month, quarter — depending on the ask).** Campaign subtype. Jarvis generates a full plan including every post's final content, schedule, channels, KPIs. User reviews once; after approval, Marketer publishes every post on the scheduled dates without per-post review. Without an active campaign plan covering the date, individual posts surface in Slack for per-post review (single-post subtype — see §5).
45. **A scheduled post underperforms sharply mid-campaign.** Amendment triggered; user reviews whether to pause/adjust.
46. **User wants a reactive post now.** Single-post subtype; reviewed in Slack before publishing.
47. **Marketing plan needs a platform credential.** Setup task pre-flight — plan attached to setup block in inbox.
48. **User wants the Marketer to humanize outputs automatically.** Every post draft passes through `tools/humanizer.ts` before publishing.

## Portfolio management

49. **User wants the weekly portfolio triage.** Monday 6am Scout digest in `#jarvis-inbox`.
50. **User wants to see where autonomous effort should go.** Ranked list with score + "focus reason" per app.
51. **User wants to pause work on one app.** `yarn jarvis pause --app <name>` — stops generating new improvement plans for that app; in-flight plans continue. Resume with `yarn jarvis resume --app <name>`.
52. **User wants to start a new app from an idea.** Approve idea → Scout drafts business plan → onboarding + initial improvement backlog.
53. **User wants variety in the autonomous output.** Diversity bonus in scoring; one new-thing plan per N maintenance.

## Self-improvement

54. **Daily self-audit runs.** Strategist tops up `jarvis` improvement backlog IF ≥1 project plan shipped in the past 7 days. The daemon ticks hourly; the audit's 24h idempotency window holds it to one effective run per day. (Was Friday-only until 2026-05-10.)
55. **Telemetry trips an alert.** Circuit breaker / budget / override spike → urgent self-improvement plan drafted immediately.
56. **User wants Jarvis to fix itself.** `plan --app jarvis "brief"` — same flow as app improvements.
57. **Jarvis ships a PR against its own code.** Reviewed + merged by you; tagged post-merge.

## Safety, quality, circuit breaker

58. **Agent exceeds rejection threshold.** Strategist/Developer/Marketer → hard pause; Scout/Analyst → soft pause.
59. **User wants to unpause an agent.** Slack button on the breaker-trip message pre-fills the correct scope; CLI: `unpause <agent> [--scope code|meta|both]` (default `both`; relevant only for Strategist's split breaker).
60. **A suppressed pattern re-fires with higher severity.** Auto-escalates past suppression; surfaces in inbox.
61. **User wants to unblock a suppression early.** Monday digest button or `unblock <pattern-id>`.
62. **Agent attempts a destructive op.** Blocked unless plan has `Destructive: true` + second confirmation.
63. **Jarvis is about to send a prompt containing a secret.** Redactor strips it pre-send; logs + inbox entry.

## Cost & observability

64. **User wants to see this month's Claude spend.** `yarn jarvis cost` — per-plan, per-agent, cache hit rate.
65. **Budget reaches 80% of cap.** Alert → urgent self-improvement plan on cost.
66. **Budget cap exceeded.** Non-critical agents pause; you raise cap or investigate.
67. **User wants to see what Jarvis did today.** `yarn jarvis timeline --since 24h`.
68. **User wants activity for a single plan.** `timeline --plan <id>`.
69. **User wants to see only signals.** `timeline --kind signal`.

## Daily & weekly rhythm

70. **User wants the daily inbox.** First engagement each day — single prioritized list.
71. **User wants the Monday morning summary.** Scout triage + overnight observations.
72. **User wants the weekly deeper slot.** Business plan reviews, retros, suppression digest.
73. **User goes on holiday.** `yarn jarvis dnd --until 2026-05-15 --note "On holiday"` — Slack notifications mute, inbox queues silently, in-flight plans pause at next safe checkpoint. On return (or `yarn jarvis dnd --off`), pending items surface as a single "while you were away" digest.

## Future / commercialization

74. **User wants to extract Jarvis to a standalone repo.** `jarvis/` lifts cleanly with zero business data; user data stays in `jarvis-data/`.
75. **User wants to add cloud execution later.** Agents are CLI-invokable; a cloud runner (GitHub Actions / Railway) can call the same commands without rewriting.
76. *(out of scope — see master plan §19 deferred items: Doppler, Trello, alternate analytics, etc.)*

## Personalization / user profile

77. **User wants to set up their profile during install.** `yarn jarvis install` writes `jarvis-data/user-profile.json` from a template with placeholder values; user fills in identity + goals + preferences before the first plan draft.
78. **User wants to edit their profile.** `yarn jarvis profile edit` opens the JSON in `$EDITOR`; `yarn jarvis profile` alone shows a human-readable summary.
79. **User wants plan prose tuned to their style.** `preferences.responseStyle` ("terse, no fluff") shapes Strategist's plan copy; `personality.communicationStyle` tunes Marketer's voice.
80. **User wants a different language voice per app.** Per-app `userPreferences.voiceOverrides` refines/overrides the global `preferences.languageRules` (e.g., tegező only for wedding-planner).
81. **User wants Jarvis to respect long-term goals and constraints.** `goals.primary`, `goals.horizon`, `goals.constraints` feed Scout's portfolio scoring and Strategist's trade-off choices.
82. **User wants Jarvis to honor risk tolerance.** `personality.riskTolerance` shapes how aggressive experiments get — conservative → fewer `Destructive: true` plan proposals, smaller feature scopes.
83. **User wants Jarvis to learn from rejection patterns.** When Strategist detects a recurring reject (e.g., "3 Lighthouse-low plans rejected this month"), it proposes a user-profile update as an improvement plan; user approves → `observedPatterns.rejectionReasons` grows.
84. **User wants to preserve decision rationale.** `history.pastDecisions` grows with each significant call (e.g., "chose Pro + SDK over MAX, 2026-04-23, rationale: cost predictability"); future plans reference these to stay coherent.
85. **User wants Jarvis to respect their technical background.** `history.stackFamiliarity` informs Strategist's tool recommendations (e.g., it won't suggest stacks you've never used without flagging the learning cost).
86. **User wants the profile to travel with the data.** Profile lives in `jarvis-data/user-profile.json`; moves with the data dir when migrating machines or pushing to a separate private repo.
87. **User wants to globally exclude certain change classes.** `preferences.globalExclusions` is a structured array (e.g., `["never touch auth without me", "no destructive DB ops without explicit Destructive: true and second confirmation"]`); all agents respect them before drafting.
88. **User wants to know what Jarvis knows about them.** `yarn jarvis profile` shows a concise view: identity, active goals, observed patterns, recent decisions.

## Socratic challenge / why-chain

89. **User wants Jarvis to push back on a weak brief.** Strategist checks the brief against brain + profile + signals + past plans; if the "why" is unclear or data contradicts the premise, it asks 1–3 clarifying questions before drafting.
90. **User wants Jarvis to stop when the brief conflicts with stated goals.** Strategist surfaces the conflict in the clarification thread ("this works against `goals.primary` — confirm?") rather than silently proceeding.
91. **User wants Jarvis to spot when they're about to repeat a past decision.** Strategist cross-references `history.pastDecisions` + past null-result/regression plans; flags similarity and asks whether the context has changed.
92. **User wants Jarvis to document the "why" in each plan.** `## Problem` captures the trigger + inferred underlying intent — future amendments reference this reasoning, not just the surface request.
93. **User wants a thin brief to produce a thoughtful plan.** When brief is too short to derive intent, Strategist loops through up to 3 clarification rounds; beyond that, drafts with best-effort assumptions flagged under `## Open questions / assumptions`.
94. **User wants to force-draft without challenge.** `yarn jarvis plan --app X --no-challenge "brief"` skips the Socratic gate (escape hatch for when you're certain and in a hurry). Use sparingly; `observedPatterns` tracks frequency.

## Interactive queries & reviews

95. **User asks Jarvis to do a full review of a project plan and opens discussion about improvement options.** `yarn jarvis review --app <name>` — Strategist + Scout produce a consolidated review (current state, active business plan, open risks, backlog, post-merge outcomes, alternatives), then enter an interactive back-and-forth (Slack thread or CLI). User explores improvement paths; output is optionally a new business plan update or a cluster of improvement plan proposals seeded into the backlog.
96. **User asks Jarvis about the current state of a project.** `yarn jarvis status --app <name>` — Jarvis returns a consolidated snapshot: app specification (from brain), active business plan + strategy, active/upcoming marketing plans, recent metrics and trends (Analyst), open improvement backlog, pending setups, recent plan outcomes (success / null-result / regression), and any tripped circuit breakers or active suppressions.

## Feedback & learning

97. **User wants to see their feedback history.** `yarn jarvis feedback [--target <id> | --kind reject | --since 30d]` — shows every reject reason, approve note, clarification answer, modification, reprioritization, unblock, unpause, free-form comment.
98. **User wants to leave a free-form comment on a plan or agent.** `yarn jarvis comment --target <id> "this approach was heavy-handed for a small feature"` — logs to the feedback store; may drive a future learning proposal.
99. **User wants to trigger a learning pass on demand.** `yarn jarvis learn --scan` — Analyst scans the feedback store for patterns; if any warrant action, proposes an improvement plan against `jarvis` (profile update, threshold tune, prompt tweak).
100. **User wants to see what patterns Jarvis spotted but hasn't acted on yet.** `yarn jarvis learn --preview` — dry-run that shows current feedback clusters and draft plan ideas without actually creating plans. Useful for sensing whether feedback has been "heard."
101. **User wants to reject a proposed learning update.** It arrives as a normal improvement plan against `jarvis`; reject with a category like any other plan. The rejection itself becomes feedback, tightening the loop.
102. **User doesn't want a specific feedback item used for learning.** `yarn jarvis feedback forget <id>` — marks the entry as excluded from future learning passes (not deleted; auditability preserved).

## Project docs

103. **User wants Jarvis to absorb docs during onboarding and then delete the originals.** `yarn jarvis onboard --app <name> --repo <path> --docs <paths-or-urls>...` — Strategist reads each doc, extracts content deeply into `brain.json` + `user-profile.json`, keeps a structured summary + extracted facts. **Original is not retained** — safe to delete from your machine afterward. This is the default retention mode.
104. **User wants Jarvis to keep a doc as a persistent reference (e.g., brand guidelines).** `yarn jarvis onboard --app <name> --repo <path> --docs-keep <paths-or-urls>...` or `yarn jarvis docs add --app <name> --keep <path-or-url>` — full content cached, refreshable on TTL.
105. **User wants to add a doc after onboarding and extend the brain.** `yarn jarvis docs add --app <name> <path-or-url>` — Strategist reads the doc and drafts a **brain-update plan** (improvement/rework) listing the fields it wants to extend or modify. You review/approve through the standard plan flow; on approval the brain is extended and the doc's summary + extracted facts land in `docs.json`. Original discarded after extraction. No silent brain mutation after the initial onboarding write.
106. **User wants to promote an existing cached doc into the brain.** `yarn jarvis docs absorb --app <name> <id>` — takes a currently-cached doc and drafts a brain-update plan from its full content, same review flow as a fresh absorb.
107. **User wants to reference a Google Drive / Notion / private-repo doc.** Add the URL with `--keep`; Jarvis creates a setup task for OAuth; fetches after connection is live and refreshes on TTL.
108. **User wants to see what docs Jarvis has for an app.** `yarn jarvis docs list --app <name>` — shows retention mode, tags, summary snippet, refresh time (cached) or absorption date (absorbed).
109. **User wants to refresh a cached external doc.** `yarn jarvis docs refresh --app <name> <id>` — re-fetches + regenerates summary; weekly housekeeping also handles this automatically.
110. **User wants to re-supply an absorbed doc with a newer version for deeper re-extraction.** `yarn jarvis docs reabsorb --app <name> <id> <path-or-url>` — Strategist re-reads, updates extracted facts + summary in place.
111. **User wants to remove a doc from the index.** `yarn jarvis docs remove --app <name> <id>` — unregisters from context; cached content deleted; summary/facts already baked into the brain stay intact.
112. **User wants docs to stay authoritative externally.** Cached URLs / Drive / Notion — Jarvis only caches + summarizes; never writes back to the source.
113. **User wants to keep project docs out of any shippable Jarvis distribution.** Docs (both modes) live in `jarvis-data/brains/[app]/docs/` — never in the code package; lifts cleanly when Jarvis is extracted.
114. **User reviews a meta plan.** Brain updates, user-profile updates, and agent-prompt tweaks arrive as plans with `subtype: meta`. Standard review flow (approve / reject with category / modify). Exempt from the 3-plan backlog cap; shown in the "Meta queue" section of `yarn jarvis backlog --app <name>`. Meta-plan rejections are tracked separately from code-plan rejections in Strategist's circuit breaker (§13) so normal meta-plan churn doesn't trip the hard pause.

## Open channels (chat & content review)

115. **User wants to think out loud with Jarvis without committing to a plan.** `yarn jarvis chat --app <name> "I'm wondering whether to X"` — opens a discussion thread with the right agent (Strategist for plan-shaped ideas, Scout for opportunities, Marketer for content angles, Analyst for stat interpretation). May refine into a brief, auto-spawn a plan if intent solidifies, append to the idea pool, or just close.
116. **User wants to bounce around an idea in Slack.** DM the Jarvis bot or thread-reply on any inbox/plan message; same routing as `chat` CLI.
117. **User wants Jarvis to review their own content draft.** `yarn jarvis review-content --app <name> --file ./draft.md --format blog` — Marketer + Strategist return annotated critique on voice, structure, persuasion, accuracy, alignment with brand + user-profile voice. Optional rewrite (humanized). No plan created.
118. **User wants quick content review in Slack.** Paste content in DM with `/jarvis review` or react to a Slack message with `:jarvis-review:` emoji.

## Multi-domain portfolio

119. **User wants to onboard their IT consulting business as a project.** `yarn jarvis onboard --app consulting --project-type consulting [--docs <briefing-doc-paths>]` — brain captures clients, services, rates, capacity, deliverable templates; metrics swap to revenue/hours/NPS instead of signups/Web-Vitals.
120. **User wants to use Jarvis for personal-brand content (Hungarian IT sector).** `yarn jarvis onboard --app personal-brand --project-type personal-brand` — brain captures audience, voice, channels, content cadence; marketing plans drive content production across post/blog/video-script/newsletter formats.
121. **User wants Scout's portfolio triage to consider apps + consulting + personal-brand together.** Default behavior: Scout ranks all projects regardless of `projectType`; diversity bonus mixes types so attention spreads across the portfolio rather than concentrating on one domain.
122. **User wants project-type-specific signal sources.** `app` → Umami + Supabase + yarn audit (existing). `consulting` → invoicing-tool sync, time-tracking, client-NPS. `personal-brand` → social-platform analytics, newsletter open/click, search rankings. Configured per-brain in `alertThresholds` and `metrics` fields.

## Context-mode discipline (Jarvis's own efficiency)

123. **User wants Jarvis agents to stay context-efficient at scale.** Every tool that produces bulk output (file reads, URL fetches, command runs, SQL queries, scanner reports) saves raw output to `jarvis-data/sandbox/<plan-id>/` and returns only `{ summary, sandboxPath }` to the agent. Agents pull specifics via narrow follow-ups: `extract(path, query)`, `grep(path, pattern)`, `count(path, predicate)`, `slice(path, range)`. Mirrors Claude Code's context-mode pattern applied to Jarvis itself.
124. **User wants sandbox files cleared automatically.** Sandbox directories clear on plan completion (`done`, `cancelled`, observation-window close); a daily sweep removes orphans older than 7 days. Gitignored — sandbox content is transient, not audit-tracked. Audit lives in plans, summaries, and extracted facts that landed in the brain or `docs.json`.
125. **User wants visibility into agent context efficiency.** Self-telemetry (§8) tracks per-agent context tokens consumed vs. budget; sustained overruns trigger an Analyst pattern that proposes tool refactors via the meta plan flow.

## Bug reports

126. **User tests an implementation, finds a bug, and asks Jarvis to fix it.** `yarn jarvis bug --app <name> "<description>" --repro ./repro.md --expected "..." --actual "..." --severity high` — Strategist drafts a `subtype: bugfix` improvement plan with the report attached as `## Problem`. Severity → priority: `high` → `blocking` (preempts current WIP), `normal` → `high`, `low` → `normal`. You review like any plan; Developer fixes; PR opens with the repro re-run as part of the manual test plan.
127. **User reports a bug that's traceable to a recently-shipped plan.** `--related-plan <id>` (or auto-detected by file overlap with the bug's repro) — bug report counts toward Developer's bug-rate telemetry on that originating plan. Frequent bugs against the same plan class trigger a learning-loop meta plan ("Developer's last 4 booking-flow plans each generated 2+ bugs — propose tightening acceptance criteria template for that flow").
128. **User reports a bug from Slack quickly.** `/jarvis bug <app> short description` or react to a Slack message with `:jarvis-bug:` emoji; Jarvis prompts for repro / expected / actual via thread reply if not provided inline.
129. **User finds a bug during PR manual testing, before merge.** Same `bug` command; if the bug is in scope of the active plan, Strategist proposes an **amendment** to that plan instead of a new bugfix plan (since it's still in flight). Otherwise drafts a new bugfix plan to queue.

## Implementation review (improvement → impl plan → execute)

130. **User wants Developer to expose its technical approach before coding.** After improvement plan approval, Developer drafts an **implementation plan** (subtype `implementation`, child of the parent improvement plan): approach, file changes, schema, deps, API surface, testing strategy, risk + rollback. Reviewed via the same approve / revise / reject flow. Default for `new-feature` and `rework` subtypes; `auto` resolves to `required`.
131. **User wants to skip implementation review for a small / obvious change.** Override at improvement-plan review time: set `ImplementationReview: skip` in the front-matter, or click "Skip implementation review" on the Slack approve dialog. Developer codes directly.
132. **User wants to push back on Developer's technical approach.** Use `revise <impl-plan-id> "use Drizzle relational queries instead of raw SQL; aligns with the rest of the codebase"` — Developer redrafts the implementation plan with the feedback. Parent improvement plan stays in approved-but-not-executing.
133. **User wants to reject Developer's approach but keep the improvement plan alive.** Reject the implementation plan with category `signal-unreliable` or `scope-wrong`; parent improvement plan is held. Strategist may revise the parent or surface a different framing for Developer to draft a new implementation plan against.

## Scheduled posts (persistence, edit, reschedule)

134. **Jarvis crashes or restarts mid-campaign.** Scheduled posts live in SQLite (`scheduled_posts` table) with full content + scheduled time + status. On daemon restart, the scheduler runs immediately, catches up any pending posts due in the past, and escalates posts past their grace window (default 1h) — "publish late / skip / reschedule?". State is durable; nothing lost.
135. **User spots a typo in a single post during review.** Click "Edit content" in Slack → modal opens with current text → fix the typo → "Save & Approve" → edited version publishes. Or CLI: `yarn jarvis post edit <post-id> --inline "..."`. No need to reject the whole post for one character.
136. **User spots a typo in an already-scheduled (not yet published) campaign post.** Same `post edit` command updates the `scheduled_posts` row in place; humanizer not re-run if change is text-only minor; logged as `edit-before-publish` feedback.
137. **User spots a typo on an already-published post.** `yarn jarvis post edit <post-id> --post-publish` calls the platform's edit API (Facebook + X support edits; Instagram doesn't for feed posts). If unsupported, Jarvis reports the limitation.
138. **User wants to skip an upcoming scheduled post.** `yarn jarvis post skip <post-id> --reason "off-message after the news today"` — post marked skipped, won't publish; recorded as feedback.
139. **User wants to reschedule a pending post.** `yarn jarvis post reschedule <post-id> --to 2026-04-30T13:00` — moves the row's `scheduled_at`; respects `marketing.scheduleRules` (rejects Saturdays if app forbids weekend posting, etc.).
140. **User wants posts only on weekdays, never weekends, twice a day.** Configure once in the app brain: `marketing.scheduleRules.default = { allowedDays: ["mon"–"fri"], timesPerDay: 2, preferredHours: ["09:00", "13:00"], minSpacingMinutes: 240 }`. Marketer respects this when proposing the `## Schedule` for any future campaign.
141. **User wants different posting rules per channel (Facebook morning, Instagram evening).** Per-channel overrides in `marketing.scheduleRules.channels.facebook` / `.instagram`.
142. **User wants posting to pause around holidays.** Add ISO dates to `marketing.scheduleRules.default.blackoutDates`. Scheduler skips those days; campaign plans surface the exclusion in their proposed schedule.
143. **User wants to override schedule rules for a one-off campaign.** Allowed in the campaign plan, but the override is highlighted at review time so it doesn't slip in unnoticed.

## Portfolio attention & anti-starvation

144. **User wants to set priorities across projects.** `yarn jarvis project priority --app erdei-fahazak --weight 5` — higher = more triage attention. Default 3 on new onboarding so projects compete fairly until tuned.
145. **User wants a project to keep getting maintenance fixes (security, deps) but no new features.** `yarn jarvis project status --app <name> --status maintenance` — Scout still surfaces security/dep signals; new-feature/rework plans don't get drafted for this app until you change status back.
146. **User wants to fully pause a project for a month.** `yarn jarvis pause --app <name>` (or `project status --status paused`). In-flight plans complete or cancel; no new plans drafted; project gets zero triage attention.
147. **User worries that a low-priority project will starve and never see plans execute.** Three guarantees prevent this:
   - **Monthly floor** — every `active` project surfaces in Scout's Monday triage at least once per calendar month, even if its score is low.
   - **Stale-plan auto-bump** — a plan in `awaiting-review` >14 days gets bumped a priority tier; >30 days escalates as "stale plan review needs decision."
   - **Untouched-app warning** — `yarn jarvis status` and the Monday triage flag any active project with no executed plan in the past 30 days.
148. **User wants to see the current portfolio attention picture.** `yarn jarvis project list` shows each app's priority, status, last-executed-plan timestamp, current backlog depth, and any stale-review flags.
149. **Aging boost in action: a low-priority project hasn't shipped anything in 5 weeks.** Scout's `ageBoost` for that project rises to ~2.0 (weekly +0.2, capped); its triage score doubles vs. baseline, surfacing it for attention. If still ignored, the monthly floor + stale-plan escalation force it to the front.
150. **User wants to deprioritize a project temporarily without losing context.** Set `projectPriority: 1` (lowest) — keeps it `active` (so signals + minimum monthly attention) but Scout deprioritizes vs. higher-weight peers. Switch back when ready.

## Plan listing & filtering

151. **User wants to see all approved plans across the portfolio.** `yarn jarvis plans --status approved` (or shorthand `plans --approved`) — returns a table of every approved plan: id, type/subtype, app, priority, last-modified, author.
152. **User wants to see all approved plans for one project.** `yarn jarvis plans --app erdei-fahazak --status approved`.
153. **User wants to see what's being executed right now.** `yarn jarvis plans --executing` (alias for `--status executing`) — shows in-flight plans across all apps.
154. **User wants to see in-flight plans for one project.** `yarn jarvis plans --app erdei-fahazak --status executing`.
155. **User wants to see plans pending their review.** `yarn jarvis plans --pending-review` — surfaces every awaiting-review plan globally; combine with `--since 14d` to find stale ones.
156. **User wants to script over plan data.** `yarn jarvis plans --status executing --format json` — machine-readable output for piping into scripts or further analysis.
157. **User wants only marketing plans.** `yarn jarvis plans --type marketing` (optionally `--subtype campaign` or `--subtype single-post`).
158. **User wants only meta plans across the portfolio.** `yarn jarvis plans --type improvement --subtype meta`.

## Circuit breaker visibility

159. **User wants to see the current state of every agent's circuit breaker.** `yarn jarvis breakers` — table per agent: state (active/paused), scope (for Strategist's code vs meta split), threshold, current rolling rate, last-N outcomes, tripped-at if paused.
160. **User wants to see only currently paused agents.** `yarn jarvis breakers --tripped`.
161. **User gets a Slack alert when a breaker trips.** Already automatic — `#jarvis-alerts` receives the trip message with rolling history and three buttons (`Review recent outputs`, `Unpause — accept risk`, `Keep paused`). See §13.
162. **User forgets an agent has been paused for days.** Daemon's stale-pause reminder re-posts every 24h to `#jarvis-alerts` until the agent is unpaused or you explicitly acknowledge keeping it paused. Stops silent agents going unnoticed.
163. **User wants breaker state in JSON for scripting / dashboards.** `yarn jarvis breakers --format json`.

## Public proof / showcase (Phase 5)

164. **User wants public proof Jarvis works without exposing private business data.** Two-track approach in Phase 5: (a) make the `jarvis/` repo public so outsiders see Developer-agent PRs landing on the system itself; (b) onboard a purpose-built public showcase project. Both tracks keep `jarvis-data/` (brains, plans, profile, feedback, secrets, consulting details) private.
165. **User wants Jarvis's self-improvement visible publicly.** Public `jarvis/` GitHub repo; PR history is the proof. `jarvis/docs/MASTER_PLAN.md` + `USE_CASES.md` double as developer-facing documentation for anyone reading along.
166. **User wants a purpose-built showcase project.** Onboard a public open-source project owned by Jarvis from day one (candidates in §19 Open items: Hungarian IT job board / event aggregator / OSS contribution leaderboard / monthly newsletter). The code repo is public; the project's brain + plans live in private `jarvis-data/`.
167. **User wants the showcase to feed personal-brand content.** Marketing plans for the showcase double as content (videos / blog posts on "how Jarvis built X"). Hits the "become known in Hungarian IT sector" vision goal.
168. **User wants reassurance that going public doesn't leak sensitive data.** Privacy boundary stays unchanged: only `jarvis/` (code + docs + plan templates + migrations) becomes public; everything in `jarvis-data/` remains private. Other apps + consulting business stay invisible regardless of Phase 5 choices.

## Vaults (multi-repo data partitioning)

169. **User wants to keep consulting separate from personal side projects.** Create a `consulting` vault with its own private git remote: `yarn jarvis vault create consulting --remote <private-url>`. Onboard consulting projects with `--vault consulting`. NDA-protected client data lives in a different repo from personal apps — backups, sharing, and access control happen per vault.
170. **User wants a public vault for the Phase 5 showcase project.** `yarn jarvis vault create showcase --remote <public-github-url>`; then `onboard --app <showcase-name> --vault showcase ...`. Showcase brain + plans go to the public remote; everything else stays in private vaults.
171. **User wants to see all their vaults.** `yarn jarvis vault list` — name, project count, git remote, default flag, last push timestamp.
172. **User wants to set a different default vault.** `yarn jarvis vault set-default <name>` — subsequent `onboard` calls without `--vault` use the new default.
173. **User wants to push / pull a vault.** `yarn jarvis vault push <name>` / `vault pull <name>` — commits and syncs with the vault's remote.
174. **User wants to move a project to a different vault.** `yarn jarvis vault move --app <name> --to <vault>` — pauses any executing plan, relocates `brains/<app>/` and `plans/<app>/` to the destination vault, updates app↔vault attribution in SQLite, commits both vaults, resumes the plan from checkpoint. Useful when sharing posture changes (internal → public showcase, or side project picks up a client and needs `consulting` posture).
174a. **User wants to add a git remote to an existing vault.** `yarn jarvis vault add-remote <name> <git-url>` — wires the remote and pushes existing local commits. The default `personal` vault from install starts without a remote until you add one.
174b. **User wants vault sync visibility.** `yarn jarvis doctor` (or `doctor --vaults`) reports per-vault: last-commit-at, ahead/behind vs remote, oldest unpushed change. Yellow at >7 days unpushed, red at >30 days.
174c. **User wants to retire a vault.** `yarn jarvis vault delete <name>` — refuses if the vault still contains projects; hint to `vault move --app <name> --to <other>` first. Safe-by-default; never silently drops project data.
174d. **User wants to rename a vault.** `yarn jarvis vault rename <old> <new>` — renames directory, updates git remote alias, updates `vault_id` everywhere in SQLite. Refuses on collision.
174e. **User tries to onboard a project with a name that already exists in another vault.** `onboard` rejects the collision with a hint: "An app called `wedding-planner` already exists in vault `personal`." Suggested alternative names included. Keeps `--app <name>` globally unambiguous in every other command.
175. **User wants reassurance that the shared layer never leaks.** `jarvis.db`, `user-profile.json`, `setup-queue.jsonl`, `sandbox/`, `ideas/`, `logs/`, `.env`, `.daemon.pid` live at the `jarvis-data/` root **outside any vault** — never published, regardless of which vaults are public.
176. **User wants different backup cadences per vault.** Per-vault `git push` cadence is independent: `personal` daily, `consulting` hourly with encryption-at-rest, `showcase` on-merge. Configured via standard git workflows on each vault's own remote.

---

*This list is a living checklist against the master plan. When you add a plan feature, add the corresponding use case here; when a use case isn't covered in the plan, that's a spec gap.*
