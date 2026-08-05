# Achievements — design

**Date:** 2026-08-03 (amended 2026-08-03 per the integration critique)
**Status:** approved direction (#158, addresses part of #74 "bored in 10 minutes")

> **Wave 2 addendum (2026-08-04, #234):** a second set of 12 depth defs
> (resilience, the AI Wave, late-game survival) ships under the SAME
> disciplines — machine-proven feats, session-baseline semantics,
> player-placed-only counting, win-tick batching, poll short-circuit. Total
> is now 38 defs. The wave-2 decisions (survival-only gating for the
> resilience group, `fleet_of_four` vs the sketched "fleet_of_five",
> `high_score_200k` vs the sketched 50k, region_blackout staying
> campaign-granted) are documented with their measurements in
> `src/achievements/definitions.js` and pinned by the replays in
> `tests/sim/achievements-proofs.test.mjs`. This document below describes
> wave 1 as shipped; its counts ("26 defs") are wave-1 scoped.

> **Amendments (binding, from the pre-implementation critique):**
> 1. `fortress` is an **event** def, not a poll: edge-sampling
>    `STATE.maliciousSpikeActive` cannot distinguish "spike ended" from
>    "session reset/died" (resetGame flips the flag without calling
>    endMaliciousSpike; a mid-spike game over strands the armed flag into the
>    next session). `achievements.onSpikeStart()` fires from
>    startMaliciousSpike (after the trafficShiftActive early-return) and
>    `achievements.onSpikeEnd({ reputation })` from endMaliciousSpike.
> 2. **Session-boundary hook**: `achievements.onSessionStart()` is called from
>    `resetGame()` AND `loadGameState()`. It clears all armed/edge state and
>    captures per-session baselines (`baselineElapsed`, the failure
>    watermark). Time/cleanliness benchmarks measure LIVE-play deltas from
>    those baselines — a restored save earns nothing for free. The 3s toast
>    guard is cosmetics only; unlock correctness never depends on it.
> 3. **Player-placed only**: architecture-variety polls count services with
>    `Service.playerPlaced === true`, set exclusively by the createService
>    placement path (the shared-arch rebuild opts out). Campaign pre-built
>    boards (L13 pre-builds 12 services incl. db+nosql+replica+search; L23
>    pre-builds gpu+infgw+power) and save restores grant nothing.
> 4. **speed_demon** threshold is 45s (30s was unreachable on all 25 levels
>    except via the level-10 instant-win bug) and is machine-proven on level 1
>    through the real startCampaignLevel path.
> 5. **no_upgrades** data source: `STATE.campaign.upgradesPerformed`,
>    incremented in `Service.upgrade()` strictly after the affordability check
>    passes (after `this.tier++`), reset in `CampaignController.loadLevel`.
> 6. **onLevelWin ctx** is defined as `{ levelId, stars, elapsed, progress,
>    level, servicesCount, usesServerlessOnly, upgradesPerformed }`.
>    `pacifist_run` := `usesOnly(STATE, "serverless", ["compute"])` at win
>    (identical to L10's machine-proven bonus objective; the
>    place-then-sell loophole is accepted in writing). `minimalist` :=
>    `servicesCount <= 4` alive at win, pre-built included.
> 7. **Hook ordering**: `onLevelWin` fires as the LAST statement of
>    `_persistWin`, after `saveProgress`, and receives the updated progress
>    object — winning a chapter's final level grants the chapter def in the
>    same call.
> 8. **clean_two_minutes** never trusts the raw `STATE.failures` counters
>    (the failures-panel clear-all button zeroes them mid-run): the engine
>    watches the tally for INCREASES only; a decrease moves the watermark
>    without restarting the clean window.
> 9. `onGameOver(stats)` is CUT — no def in the final set consumes it, and a
>    dead hook is untestable surface.
> 10. The set is 26 defs (the "24" below was a miscount of its own list).
> 11. **(post-verification)** The level-10 instant-win farm is closed at the
>     root, campaign-side: `_checkEndConditions` declares a win only after
>     ≥ 1 completed request this attempt (`STATE.campaign.completedByType`,
>     reset per attempt in `loadLevel`, never restored from save files), and
>     a timeout without that gate is a loss, so gated levels still
>     terminate. An untouched L10 board — whose primaries were vacuously
>     true, winning 3-star at the first 2 Hz check (t=0.5s) — or one idle
>     serverless can no longer grant first_win / speed_demon / minimalist /
>     no_upgrades / pacifist_run with zero play. Machine-probed through the
>     real `startCampaignLevel(10)` path in
>     `tests/sim/achievements-proofs.test.mjs`; the controller contract is
>     pinned in `tests/sim/campaign.test.mjs`.

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
