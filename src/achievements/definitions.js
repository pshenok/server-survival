// Achievement definitions (#158). Pure data + pure predicates — the engine in
// achievements.js owns all state, persistence and hook plumbing. Names and
// descriptions live in i18n as ach_<id>_name / ach_<id>_desc (×10 locales).
//
// Two check kinds (see the spec, as amended by the integration critique):
//
//   poll  — cheap predicates over the reusable poll context the engine builds
//           at 2 Hz. They NEVER read raw wall-clock or the raw failure
//           counters: session-boundary correctness (restored saves, resets,
//           the failures-panel clear-all button) is the engine's job, and the
//           predicates only see the already-sanitized ctx:
//             { survival, liveElapsed, cleanElapsed, score, counts }
//           counts covers PLAYER-PLACED services only (Service.playerPlaced,
//           set exclusively by the createService placement path) — campaign
//           pre-built boards and restored saves earn nothing for free.
//
//   event — fired by explicit calls at the single source site:
//             levelWin  — CampaignController._persistWin (last statement,
//                         AFTER saveProgress, so ctx.progress includes the
//                         level just won)
//             locale    — i18n.setLocale
//             spikeEnd  — endMaliciousSpike (armed by startMaliciousSpike;
//                         the armed flag is session state in the engine and
//                         is cleared by onSessionStart, so a reset or a
//                         loaded save can never fake a survived spike)
//
// fortress was moved from the spec's poll list to an event def per the
// critique: edge-sampling STATE.maliciousSpikeActive cannot distinguish
// "spike ended" from "session died", and both resetGame and a mid-spike game
// over produced false unlocks. startMaliciousSpike / endMaliciousSpike are
// each a single call site — exactly the spec's own "no polling for things
// that happen at one code site" rule.

import { CAMPAIGN_LEVELS } from "../campaign/levels.js";

// chapter -> [levelIds]; derived once so chapter defs stay O(levels-in-chapter).
const LEVELS_BY_CHAPTER = new Map();
for (const l of CAMPAIGN_LEVELS) {
    if (!LEVELS_BY_CHAPTER.has(l.chapter)) LEVELS_BY_CHAPTER.set(l.chapter, []);
    LEVELS_BY_CHAPTER.get(l.chapter).push(l.id);
}

function chapterDone(progress, chapter) {
    const ids = LEVELS_BY_CHAPTER.get(chapter) || [];
    return ids.length > 0 && ids.every((id) => progress?.completed?.[id]);
}

function star3(ctx, levelId) {
    return ctx.levelId === levelId && ctx.stars >= 3;
}

// levelWin ctx (built by the engine, see achievements.onLevelWin):
//   { levelId, stars, elapsed, progress, level, servicesCount,
//     usesServerlessOnly, upgradesPerformed }
//
// Semantics pinned by the critique:
//   pacifist_run       — usesOnly("serverless", ["compute"]) at win: identical
//                        to level 10's machine-proven bonus objective. The
//                        place-Compute-then-sell loophole is ACCEPTED in
//                        writing — alive-at-win is the provable check.
//   minimalist         — servicesCount <= 4 alive at win, pre-built included
//                        (level 1 is winnable with exactly the 4-service
//                        chain, so alive-at-win is provable).
//   no_upgrades        — STATE.campaign.upgradesPerformed, incremented in
//                        Service.upgrade() strictly after the affordability
//                        check passes, reset per level in loadLevel.
//   speed_demon        — threshold raised 30s -> 45s and machine-proven on
//                        level 1 through the real startCampaignLevel path
//                        (the spec's 30s was unreachable on every level
//                        except via the level-10 instant-win bug).
export const ACHIEVEMENT_DEFS = [
    // ---- Campaign mastery (event: levelWin) ----
    { id: "first_win", tier: "bronze", checkKind: "event", event: "levelWin",
        check: () => true },
    { id: "speed_demon", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => c.elapsed < 45 },
    { id: "minimalist", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => c.servicesCount <= 4 },
    { id: "cache_master", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => star3(c, 4) },
    { id: "replica_master", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => star3(c, 6) },
    { id: "search_master", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => star3(c, 7) },
    { id: "gpu_graduate", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => star3(c, 21) },
    { id: "pacifist_run", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => c.levelId === 10 && c.usesServerlessOnly },
    { id: "no_upgrades", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => (c.level?.chapter || 0) >= 2 && c.upgradesPerformed === 0 },
    { id: "chapter_one_done", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => chapterDone(c.progress, 1) },
    { id: "chapter_two_done", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => chapterDone(c.progress, 2) },
    { id: "chapter_three_done", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => chapterDone(c.progress, 3) },
    { id: "chapter_four_done", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => chapterDone(c.progress, 4) },
    { id: "chapter_five_done", tier: "silver", checkKind: "event", event: "levelWin",
        check: (c) => chapterDone(c.progress, 5) },
    { id: "completionist", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => CAMPAIGN_LEVELS.every((l) => c.progress?.completed?.[l.id]?.stars === 3) },

    // ---- Survival benchmarks (poll; survival mode only) ----
    // liveElapsed / cleanElapsed are session deltas from the engine's
    // onSessionStart baselines — a restored 300s save starts both at 0.
    { id: "first_minute", tier: "bronze", checkKind: "poll",
        check: (c) => c.survival && c.liveElapsed >= 60 },
    { id: "five_minutes", tier: "gold", checkKind: "poll",
        check: (c) => c.survival && c.liveElapsed >= 300 },
    { id: "high_score_1k", tier: "bronze", checkKind: "poll",
        check: (c) => c.survival && c.score >= 1000 },
    { id: "high_score_10k", tier: "gold", checkKind: "poll",
        check: (c) => c.survival && c.score >= 10000 },
    { id: "clean_two_minutes", tier: "silver", checkKind: "poll",
        check: (c) => c.survival && c.cleanElapsed >= 120 },

    // ---- Survival benchmarks (event: spikeEnd) ----
    { id: "fortress", tier: "gold", checkKind: "event", event: "spikeEnd",
        check: (c) => c.armed && c.reputation >= 95 },

    // ---- Architecture variety (poll; player-placed services only) ----
    { id: "triple_firewall", tier: "silver", checkKind: "poll",
        check: (c) => c.counts.wafRoutable >= 3 },
    { id: "polyglot_db", tier: "silver", checkKind: "poll",
        check: (c) => c.counts.db > 0 && c.counts.nosql > 0 && c.counts.search > 0 && c.counts.replica > 0 },
    { id: "full_stack_ai", tier: "gold", checkKind: "poll",
        check: (c) => c.counts.gpu > 0 && c.counts.infgw > 0 && c.counts.power > 0 },
    { id: "city_block", tier: "gold", checkKind: "poll",
        check: (c) => c.counts.placed >= 15 },

    // ---- Meta (event: locale) ----
    { id: "polyglot", tier: "bronze", checkKind: "event", event: "locale",
        check: (c) => c.localeCount >= 3 },

    // ================= Wave 2 (#234): the depth set =================
    //
    // Farmability decisions, measured against the shipped tuning (see
    // tests/sim/achievements-proofs.test.mjs for the replays):
    //
    //   SURVIVAL-ONLY — failover_proven, breaker_comeback, second_chance,
    //   nothing_lost: campaign levels HAND these triggers (L17/L20 force the
    //   outage; L18's primary requires the DLQ and its tuning produces the
    //   retries/drains). The L17 winning replay measures rep ≥ 90 with
    //   outages > 0 — the issue's rep gate alone would NOT have guarded it —
    //   so the whole group is gated on gameMode === "survival", where the
    //   triggers only come from the random-event system and real overload.
    //
    //   CAMPAIGN-BY-CONSTRUCTION — region_blackout: region outages exist
    //   only through the campaign trigger (#221, L20), so survival-gating
    //   would make the def dead. Measured: winning runs complete 98-120
    //   during the 25s blackout, collapsed runs 28-42 — the 60 bar separates
    //   "region B carried the blackout" from "region B drowned", which IS
    //   the level's feat. A rep pairing was tried and rejected: the counter
    //   latches after the restore while reputation recovers toward 100
    //   before the win tick, so it added nothing but noise. Re-winning L20
    //   re-performs the entire feat — that is not farming.
    //
    //   MODE-FREE — megawatt: the architecture-variety precedent
    //   (city_block / full_stack_ai are already sandbox-grantable). Counts
    //   PLAYER-PLACED GPUs only, so L23's pre-built GPU earns nothing.
    //
    // Session-baseline semantics: nodeFailures / retries / drained are
    // engine-computed deltas from onSessionStart baselines — a restored save
    // starts every counter at zero, like liveElapsed.

    // ---- Resilience depth (poll; survival only) ----
    // fleet_of_four: the issue sketched id "fleet_of_five" with threshold
    // "4+ instances" — the threshold was right and the name was not. The
    // failure roll (2×(load−0.5) past 50% load) prices every util-triggered
    // scale-out in failures, and holding the pressure a FIFTH instance needs
    // was measured rep-lethal (< −1000) on a standalone board, while 4 ready
    // instances is provably reachable alive (proof run: fleet 4, rep floor
    // 26, recovered past 90). The id says what the check counts.
    { id: "failover_proven", tier: "gold", checkKind: "poll",
        check: (c) => c.survival && c.nodeFailures > 0 && c.reputation >= 90 },
    { id: "second_chance", tier: "silver", checkKind: "poll",
        check: (c) => c.survival && c.retries >= 50 },
    { id: "nothing_lost", tier: "silver", checkKind: "poll",
        check: (c) => c.survival && c.drained >= 25 },
    { id: "fleet_of_four", tier: "silver", checkKind: "poll",
        check: (c) => c.survival && c.maxFleet >= 4 },

    // ---- Resilience depth (event: breakerClose — trip armed + genuine
    //      recovery through half-open probes, rep still >= 90) ----
    { id: "breaker_comeback", tier: "gold", checkKind: "event", event: "breakerClose",
        check: (c) => c.survival && c.armed && c.reputation >= 90 },

    // ---- Resilience depth (poll; campaign-by-construction, see above) ----
    { id: "region_blackout", tier: "gold", checkKind: "poll",
        check: (c) => c.outageCompletions >= 60 },

    // ---- The AI Wave (event: levelWin) ----
    { id: "slo_clean", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => c.levelId === 23 && c.expiredRequests === 0 },
    { id: "one_gpu_economist", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => c.levelId === 22 && c.gpuCount === 1 },
    { id: "small_model_big_heart", tier: "gold", checkKind: "event", event: "levelWin",
        check: (c) => c.levelId === 21 && c.gpuCount > 0 && c.gpuMaxTier === 1 },

    // ---- The AI Wave (poll; player-placed GPUs only) ----
    { id: "megawatt", tier: "silver", checkKind: "poll",
        check: (c) => c.gpuKw >= 18 },

    // ---- Late-game survival (poll; survival only) ----
    //
    // Calibration (the headless 1000s marathon in achievements-proofs):
    // the proving build crosses the t=600 2x-upkeep wall with a five-figure
    // bank and holds rep ~100 to 900s — quarter_hour is real but fair. Its
    // score reads 213.9k at t=900; because failures bleed both reputation
    // AND score, ANY build that survives to 900s serves nearly everything
    // and the issue's sketched 50k falls at t≈425 — a mid-game rung, not a
    // veteran feat. 200k is just under the strong build's 900s reading:
    // it demands near-full throughput held for the whole quarter hour
    // (playing FOR score), not mere survival.
    { id: "quarter_hour", tier: "gold", checkKind: "poll",
        check: (c) => c.survival && c.liveElapsed >= 900 },
    { id: "high_score_200k", tier: "gold", checkKind: "poll",
        check: (c) => c.survival && c.score >= 200000 },
];

export const POLL_DEFS = ACHIEVEMENT_DEFS.filter((d) => d.checkKind === "poll");

export function eventDefs(event) {
    return ACHIEVEMENT_DEFS.filter((d) => d.checkKind === "event" && d.event === event);
}
