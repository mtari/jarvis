# Jarvis — repo conventions

This repo holds Jarvis itself: an autonomous agent system that drafts, reviews, and executes plans across a portfolio of apps. The repo is the **code package**; user-specific state lives in a sibling `jarvis-data/` directory selected via `$JARVIS_DATA_DIR` (default `../jarvis-data`). See [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) for the full design.

## Running

- `yarn jarvis <command>` — primary CLI surface (see §17 in MASTER_PLAN.md)
- `yarn typecheck` — strict TypeScript check, no emit
- `yarn test` — Vitest one-shot
- `yarn test:watch` — Vitest watch mode

## Layout

Top-level dirs match §15 of MASTER_PLAN.md:

- `agents/` — one file per agent (jarvis, analyst, scout, strategist, developer, marketer)
- `prompts/` — agent system prompts (.md, loaded as text)
- `tools/` — outbound tool wrappers (github, umami, social, scanners, humanizer)
- `integrations/` — external surface adapters (Slack lands in Phase 1)
- `orchestrator/` — router, bus, context-budget, sandbox, redactor
- `cli/index.ts` — `yarn jarvis ...` entry
- `daemon.ts` — long-running local process
- `migrations/db/` `migrations/brain/` `migrations/profile/` — numbered TS files with `up()` / `down()`
- `plan-templates/` — markdown templates per plan type
- `docs/` — MASTER_PLAN.md, USE_CASES.md (single sources of truth)

## Per-app state lives elsewhere

Brains, plans, the SQLite event log, secrets, and logs all live under `$JARVIS_DATA_DIR`. Never write user-specific state into this repo. The split keeps the code shippable without business-content leakage.

## Adding a new signal source

Signal collectors live under `tools/scanners/` and emit events to the SQLite event log. Each collector is one file exporting a `collect()` function that takes a brain and returns an array of event payloads. Wire it into the daemon's hourly scheduler (see `daemon.ts`). Filter-and-trigger logic stays in `agents/analyst.ts`, not in the collector — collectors are thin.

## Writing style

Per §13 of MASTER_PLAN.md, any user-facing text Developer writes (in apps Jarvis works on) runs through `tools/humanizer.ts` before publish or PR. Inside this repo, the same writing standards apply by hand: terse, no inflated symbolism, no rule-of-three, no em-dash overuse. Plans, PRs, commit messages, code comments, and internal logs are exempt from the humanizer pass — but stay terse anyway.

## Plan-flow status

Phase 0–2 complete (see §16); Phase 2.5 conversational interface and Phase 3 Marketer are built; Phase 4 self-improvement flywheel components are in place. The Phase 5 showcase pick is locked — `huntech.dev` per §16 Track B — and onboarding is the immediate next step. Self-improvement plans for this repo flow through `yarn jarvis plan --app jarvis "<brief>"`. Hand-edits with normal GitHub PR review still happen alongside, especially for docs.
