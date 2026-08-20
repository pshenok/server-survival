// The third star, and whether any play can reach it (#256).
//
// The formula was covered and correct; what nothing covered was whether a
// real level could satisfy it. A level ends the instant its primaries all
// pass, so on the eleven levels whose primary is `survive_Ns` the earliest
// possible win is exactly N — and the third star wanted 0.8N. `N <= 0.8N` is
// false for every positive N, so those levels capped at two stars however
// perfectly they were played, and cache_master, replica_master, search_master
// and completionist went with them.
//
// Two kinds of check live here, and they answer different questions:
//   1. The WALK is arithmetic. It asks, for every shipped level, whether any
//      path to the third star is structurally open. It is the regression
//      guard: the next `survive_*` primary re-closes this silently otherwise.
//   2. The PROOFS are simulation. They play the three levels that gate an
//      achievement through the real path and land three stars. Arithmetic
//      cannot tell you a bonus pair is reachable; only a run can.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { spawnRequest } from "../../src/core/actions.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { startCampaignLevel } from "../../src/ui/campaign-ui.js";
import { STATE, resetWorld } from "../helpers/sim-world.mjs";

const CAMPAIGN_KEY = "serverSurvivalCampaignProgress";

// ---------------------------------------------------------------- the walk

// A state stub that varies in ONE dimension: game time. Everything else reads
// as an untouched board, so a check that ignores the clock answers the same at
// every t and registers no floor.
function stubAt(t) {
    return {
        elapsedGameTime: t,
        reputation: 100,
        money: 1000,
        netProfit: 0,
        failures: {},
        services: [],
        requests: [],
        campaign: {
            completedByType: {},
            completedByService: {},
            objectiveResults: {},
            bonusResults: {},
            upgradesPerformed: 0,
        },
    };
}

/**
 * The earliest game time at which this objective could possibly pass, as far
 * as the clock alone decides it.
 *
 * Deliberately narrow: it detects a PURE time gate — a check that is false at
 * t=0, flips true at some t, and stays true. That is the shape that caused
 * #256 (`(s) => s.elapsedGameTime >= 60`). A check that needs a built board
 * reads false at every probed t and reports no floor, which is the honest
 * answer — this probe measures the clock, not winnability.
 */
function timeFloor(check, maxT) {
    const at = (t) => {
        try {
            return !!check(stubAt(t));
        } catch {
            return false;
        }
    };
    if (at(0)) return 0;
    for (let t = 0.5; t <= maxT; t += 0.5) {
        if (at(t)) return t;
    }
    return 0;
}

function classify(level) {
    const floors = level.objectives.primary.map((o) => timeFloor(o.check, level.durationSec));
    const earliestWin = floors.length ? Math.max(...floors) : 0;
    const speedBar = level.durationSec * 0.8;
    return {
        id: level.id,
        durationSec: level.durationSec,
        earliestWin,
        speedBar,
        speedReachable: earliestWin <= speedBar,
        bonusCount: level.objectives.bonus.length,
    };
}

describe("every level can be three-starred by SOME play (#256)", () => {
    const rows = CAMPAIGN_LEVELS.map(classify);

    it("no level is left without a path to the third star", () => {
        // Asks the SHIPPED formula, not a restatement of it: hand it the best
        // a perfect player could present — every bonus met, the win landing at
        // the earliest moment the clock allows — and see what it pays.
        const unreachable = [];
        for (const level of CAMPAIGN_LEVELS) {
            const { earliestWin } = classify(level);
            STATE.campaign.level = level;
            STATE.campaign.bonusResults = Object.fromEntries(
                level.objectives.bonus.map((o) => [o.id, true])
            );
            STATE.elapsedGameTime = earliestWin;
            const stars = globalThis.window.campaign._calculateStars();
            if (stars < 3) unreachable.push(`L${level.id} (best possible: ${stars})`);
        }
        expect(unreachable, "a perfect run must be able to score three stars").toEqual([]);
    });

    it("names the levels that speed alone cannot carry — the reason the rule changed", () => {
        const timeGated = rows.filter((r) => !r.speedReachable);
        console.log(
            "\nspeed star unreachable on:\n" +
                timeGated
                    .map(
                        (r) =>
                            `  L${String(r.id).padStart(2)}  wins no earlier than ${r.earliestWin}s, ` +
                            `star wanted <= ${r.speedBar}s  (${r.bonusCount} bonuses carry it now)`
                    )
                    .join("\n")
        );
        // Measured on the shipped levels: eleven are hard-blocked. This is not
        // a target to preserve — it is a statement of today's board, and it
        // exists so a change in the level set is noticed rather than absorbed.
        expect(timeGated.length).toBeGreaterThanOrEqual(11);
        for (const r of timeGated) expect(r.bonusCount).toBeGreaterThanOrEqual(2);
    });

    it("the walk actually detects a time gate — it is not reporting zeroes", () => {
        // Guards the probe itself. If stubAt() ever drifts out of shape the
        // checks would all throw, every floor would read 0, and the walk above
        // would pass by seeing nothing at all.
        const l4 = rows.find((r) => r.id === 4);
        expect(l4.earliestWin).toBe(60);
        expect(l4.speedReachable).toBe(false);
    });
});

// -------------------------------------------------------------- the proofs

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const REAL_RANDOM = Math.random;

// One frame of animate()'s sim-relevant work, in animate()'s order.
function frame(dt) {
    STATE.elapsedGameTime += dt;
    if (globalThis.window.campaign?.active) globalThis.window.campaign.tick(dt);
    STATE.services.forEach((s) => s.update(dt));
    STATE.requests.slice().forEach((r) => r.update(dt));
    STATE.spawnTimer += dt;
    const rps = STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
    if (rps > 0) {
        const iv = 1 / rps;
        while (STATE.spawnTimer >= iv) {
            STATE.spawnTimer -= iv;
            spawnRequest();
        }
    }
    STATE.reputation = Math.min(100, STATE.reputation);
    achievements.tick(dt);
}

function placeAt(type, x, z) {
    const before = STATE.services.length;
    createService(type, new globalThis.THREE.Vector3(x, 0, z));
    if (STATE.services.length === before) throw new Error(`placement of ${type} failed`);
    return STATE.services[STATE.services.length - 1];
}

function svc(type) {
    return STATE.services.find((s) => s.type === type);
}

/** Plays a level to its end with the given build and reports the scoring. */
function play(levelId, seed, build) {
    resetWorld();
    globalThis.localStorage.setItem(
        CAMPAIGN_KEY,
        JSON.stringify({ version: 1, completed: {}, highestUnlocked: 25 })
    );
    STATE.animationId = 1; // keep resetGame from starting the real rAF loop
    Math.random = mulberry32(seed);
    startCampaignLevel(levelId);
    build();
    for (let t = 0; t < 400 && !STATE.campaign.ended; t += 0.1) frame(0.1);
    return {
        outcome: STATE.campaign.outcome,
        elapsed: STATE.elapsedGameTime,
        stars: globalThis.window.campaign._calculateStars(),
        bonuses: { ...STATE.campaign.bonusResults },
        failures: Object.values(STATE.failures).reduce((a, b) => a + b, 0),
        speedBar: STATE.campaign.level.durationSec * 0.8,
    };
}

/** What every one of these proofs must show: a perfect run, scored 3, NOT by speed. */
function expectThreeStarsWithoutSpeed(r) {
    expect(r.outcome).toBe("win");
    expect(r.stars).toBe(3);
    expect(Object.values(r.bonuses).every(Boolean)).toBe(true);
    // The point of the fix: this run is SLOWER than the speed bar it could
    // never have beaten, and the third star arrives anyway. Under the old rule
    // this identical run scored 2.
    expect(r.elapsed).toBeGreaterThan(r.speedBar);
}

beforeEach(() => {
    resetWorld();
    achievements._reloadForTests();
});
afterEach(() => {
    Math.random = REAL_RANDOM;
});

describe("the three achievement-gating levels, three-starred through the real path", () => {
    // Each build is the level's own briefed lesson, bought inside its budget,
    // and each was measured across seeds before being pinned here.

    it("L4 cache_master — cache-aside plus the Compute tier that pays for it", () => {
        // $60 cache + $100 upgrade of $200. The cache alone loses half its
        // seeds: Compute runs at ~90% of its throughput ceiling at 6 rps, so
        // it cooks itself before the cache can matter.
        for (const seed of [1, 2, 3, 42]) {
            const r = play(4, seed, () => {
                const compute = svc("compute");
                const cache = placeAt("cache", 5, 8);
                createConnection(compute.id, cache.id);
                createConnection(cache.id, svc("db").id);
                compute.upgrade();
            });
            expect(r.failures, `seed ${seed}`).toBe(0);
            expectThreeStarsWithoutSpeed(r);
        }
    });

    it("L6 replica_master — a replica needs a master AND the miss traffic", () => {
        // Compute only diverts READs to a replica once the Cache is past 60%
        // load, which never happens here. The replica earns its half from the
        // cache MISS cascade instead, and it must be wired to the DB or every
        // read routed to it fails NO_MASTER.
        for (const seed of [1, 2, 3, 42]) {
            const r = play(6, seed, () => {
                const compute = svc("compute");
                const replica = placeAt("replica", 12, 10);
                createConnection(replica.id, svc("db").id);
                createConnection(svc("cache").id, replica.id);
                compute.upgrade();
            });
            expect(r.failures, `seed ${seed}`).toBe(0);
            expectThreeStarsWithoutSpeed(r);
        }
    });

    it("L7 search_master — a search node plus the Compute tier", () => {
        // 60% of this level's traffic is SEARCH, which Compute hands straight
        // to a connected search node.
        for (const seed of [1, 2, 3, 42]) {
            const r = play(7, seed, () => {
                const compute = svc("compute");
                const search = placeAt("search", 12, -10);
                createConnection(compute.id, search.id);
                compute.upgrade();
            });
            expect(r.failures, `seed ${seed}`).toBe(0);
            expectThreeStarsWithoutSpeed(r);
        }
    });
});

describe("the rule stays honest at the edges", () => {
    function synthetic({ durationSec, bonuses, met, elapsed }) {
        STATE.campaign.level = {
            durationSec,
            objectives: { primary: [], bonus: bonuses.map((id) => ({ id })) },
        };
        STATE.campaign.bonusResults = Object.fromEntries(met.map((id) => [id, true]));
        STATE.elapsedGameTime = elapsed;
        return globalThis.window.campaign._calculateStars();
    }

    it("one bonus does NOT hand over the third star with the second", () => {
        // With a single bonus, "any" and "every" are the same condition. If
        // the flawless path ignored that, a one-bonus level would pay three
        // stars for the same work the second star already bought.
        expect(synthetic({ durationSec: 100, bonuses: ["b1"], met: ["b1"], elapsed: 95 })).toBe(2);
    });

    it("zero bonuses cannot be 'all met' — the empty set pays nothing", () => {
        expect(synthetic({ durationSec: 100, bonuses: [], met: [], elapsed: 95 })).toBe(1);
    });

    it("half the bonuses is still two stars", () => {
        expect(
            synthetic({ durationSec: 100, bonuses: ["b1", "b2"], met: ["b1"], elapsed: 95 })
        ).toBe(2);
    });

    it("every bonus is three, at any pace", () => {
        expect(
            synthetic({ durationSec: 100, bonuses: ["b1", "b2"], met: ["b1", "b2"], elapsed: 99 })
        ).toBe(3);
    });

    it("speed still pays on its own, with a single bonus met", () => {
        // Strictly additive: the path that already existed is untouched.
        expect(synthetic({ durationSec: 100, bonuses: ["b1", "b2"], met: ["b1"], elapsed: 79 })).toBe(3);
    });
});
