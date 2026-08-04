# Achievements — design

**Date:** 2026-08-03
**Status:** approved direction (#158, addresses part of #74 "bored in 10 minutes")

## Why

Once Campaign is done, there is no long-term goal. Achievements give veterans
a reason to return, to try unusual architectures, and to master specific
concepts — the retention lever that requires no new game systems.

## Architecture

**`src/achievements/achievements.js`** — declarative defs + engine.
**`src/achievements/definitions.js`** — the data: `{ id, tier, checkKind,
check }`. Names/descriptions live in i18n (`ach_<id>_name` / `_desc` ×10
locales).

Two check kinds, two hook points:

1. **`poll`** — cheap predicates over STATE, evaluated at 2 Hz alongside the
   existing campaign tick cadence (a dedicated `achievementsTick(dt)` in
   animate; skips entirely when all polls are unlocked). Predicates must be
   O(services) worst-case.
2. **`event`** — fired by explicit calls at the source: `onLevelWin(levelId,
   stars, elapsed, ctx)` from `_persistWin`, `onLocaleChange(locale)` from
   `i18n.setLocale`, `onGameOver(stats)` from the game-over path. No polling
   for things that happen at one code site.

**Persistence**: `localStorage["serverSurvivalAchievements"]` =
`{ version: 1, unlocked: { id: epochMs }, seen: { localeSet: [...] } }`.
Meta-progress — deliberately NOT in save files and NOT reset by resetGame.
Corrupt/unknown-version → empty (the campaign-progress precedent).

**Unlock flow**: exactly once; toast queue (one at a time, ~4s each, vector
SVG trophy icon, no emoji, reuses the house glass-panel style, NOT the
intervention-warning chrome — achievements are celebration, warnings are
alarm); a small "Trophies" entry in the main menu opening a panel: grid of
all achievements, locked ones greyed with silhouettes, unlocked show date.
Panel count badge ("14/24").

## The set (24 — every one must be CHECKABLE and, where it claims a feat,
machine-proven achievable)

**Campaign mastery** (event: onLevelWin)
- `first_win` — win any level
- `cache_master` — 3★ on level 4 (Cache the DB)
- `replica_master` — 3★ on level 6 (Scale Reads)
- `search_master` — 3★ on level 7 (Search Done Right)
- `gpu_graduate` — 3★ on level 21 (Hello, GPU)
- `speed_demon` — win any level in under 30s
- `chapter_one_done` / `chapter_two_done` … per-chapter completion (5)
- `completionist` — 3★ on every level
- `pacifist_run` — win level 10 without placing any Compute (serverless-only;
  MUST be machine-proven winnable, the #184 discipline)
- `no_upgrades` — win any level of chapter 2+ without upgrading anything

**Survival benchmarks** (poll)
- `first_minute` — survive 60s; `five_minutes` — 300s
- `high_score_1k` / `high_score_10k` — total score thresholds
- `clean_two_minutes` — 120s with zero failed requests
- `fortress` — survive an entire malicious spike (uses
  STATE.maliciousSpikeActive edge: armed when spike starts, granted when it
  ends with reputation ≥ 95)

**Architecture variety** (poll)
- `minimalist` — win any campaign level with ≤ 4 placed services (event)
- `triple_firewall` — 3+ routable WAFs simultaneously
- `polyglot_db` — SQL + NoSQL + Search + Replica live at once
- `full_stack_ai` — GPU + Inference Gateway + Substation live at once
- `city_block` — 15+ services in one session

**Meta** (event)
- `polyglot` — play in 3 different locales (tracked in `seen.localeSet`)

CUT from the issue's sketch: `early_adopter` (uncheckable honestly),
`microservices` (renamed city_block).

## Constraints & discipline

- No build step; native ESM; no new deps; i18n ×10 (~50 keys per locale —
  the biggest translation surface since the base game; uk included).
- Poll predicates run at most 2 Hz and short-circuit once unlocked; zero
  per-frame allocation in the hot path.
- `pacifist_run` and `no_upgrades` must be machine-proven through the real
  level path before shipping; any unprovable def gets cut, not shipped hopeful.
- Toasts never fire during the first 3s of a session (anti-spam on load when
  poll conditions are already true from a restored board).
- The Trophies panel is reachable from the main menu; pause menu untouched.
- Tests: engine (unlock-once, persistence round-trip, corrupt store, version
  gate), each event hook fires from its real site (win a level headlessly →
  achievement lands), poll cadence + short-circuit, locale tracking, the two
  feat-proofs, i18n key existence rides the existing suites.
