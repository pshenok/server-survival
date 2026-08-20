// Is the lesson load-bearing? (#254)
//
// The repo already proves levels are WINNABLE. What it has never checked is
// the other half of the #184 discipline: that a level is LOST when its own
// mechanic is ignored. A level that passes without the thing it teaches is not
// a lesson, it is a cutscene with a timer.
//
// Measuring that across chapter 2 turned up something the issue did not
// predict. Two levers are available on every one of these levels: the service
// the briefing teaches, and the $100 Compute tier (capacity 4 -> 10) that every
// budget here can afford. Removing them one at a time says which one the level
// actually turns on:
//
//   level  teaches   taught+tier  tier only  taught only  neither
//   L3     CDN         5/5          5/5        5/5         5/5
//   L4     Cache       5/5          5/5        2/5         2/5
//   L5     Queue       5/5          5/5        5/5         4/5
//   L6     Replica     5/5          5/5        0/5         0/5
//   L7     Search      5/5          5/5        0/5         0/5
//   L8     NoSQL       5/5          5/5        0/5         0/5
//   L9     API GW      5/5          5/5        5/5         5/5
//   L12    2nd WAF     5/5          0/5        0/5         0/5
//
// Three levels (3, 5, 9) pass on an untouched board. On three more (6, 7, 8)
// the taught node is decorative in BOTH directions: without the tier they lose
// even when it is correctly wired, and with the tier they win without it. The
// cause is capacity — Compute runs 4 concurrent at 600ms, about 6.7 req/s,
// and those levels arrive at 6-7 rps — so Compute binds before any downstream
// store can matter. Mechanically, chapter 2 teaches "buy a bigger box".
//
// L12 is the counter-example: what a second WAF defends against is not
// something more CPU absorbs, so it is load-bearing in every column.
//
// This file does not retune anything. Retuning shipped levels moves the
// difficulty of a campaign people have already played, and that is a decision
// to take deliberately. What it does is pin the table above so the hollow set
// can only ever SHRINK, and prove the reference solutions still win.
import { describe, it, expect, afterEach } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { createConnection } from "../../src/sim/topology.js";
import { REAL_RANDOM, placeAt, play, svc } from "../helpers/campaign-play.mjs";
import { STATE, resetWorld } from "../helpers/sim-world.mjs";

const SEEDS = [1, 2, 42];

// Each level's own briefed lesson, split into the two levers so either can be
// withheld. `taught` places and wires the service the level is about; `tier`
// buys the Compute upgrade.
const tier = () => svc("compute").upgrade();

const LEVELS = {
    3: {
        teaches: "CDN",
        taught: () => {
            const cdn = placeAt("cdn", -15, 12);
            createConnection("internet", cdn.id);
            createConnection(cdn.id, svc("s3").id);
        },
    },
    4: {
        teaches: "Cache",
        taught: () => {
            const cache = placeAt("cache", 5, 8);
            createConnection(svc("compute").id, cache.id);
            createConnection(cache.id, svc("db").id);
        },
    },
    5: {
        teaches: "Queue",
        taught: () => {
            const sqs = placeAt("sqs", -5, 10);
            createConnection(svc("alb").id, sqs.id);
            createConnection(sqs.id, svc("compute").id);
        },
    },
    6: {
        teaches: "Replica",
        taught: () => {
            const replica = placeAt("replica", 12, 10);
            createConnection(replica.id, svc("db").id);
            createConnection(svc("cache").id, replica.id);
        },
    },
    7: {
        teaches: "Search",
        taught: () => {
            const search = placeAt("search", 12, -10);
            createConnection(svc("compute").id, search.id);
        },
    },
    8: {
        teaches: "NoSQL",
        taught: () => {
            const nosql = placeAt("nosql", 12, 10);
            createConnection(svc("compute").id, nosql.id);
        },
    },
    9: {
        teaches: "API Gateway",
        taught: () => {
            const gw = placeAt("apigw", -15, 8);
            createConnection(svc("alb").id, gw.id);
            createConnection(gw.id, svc("compute").id);
        },
    },
    12: {
        teaches: "a second WAF",
        taught: () => {
            const waf2 = placeAt("waf", -20, 10);
            createConnection("internet", waf2.id);
            createConnection(waf2.id, svc("alb").id);
        },
    },
};

// Today's answer, measured. Membership means "this level still wins with its
// own lesson withheld". The assertion below lets this set shrink and never
// grow, so fixing a level is a one-line deletion and shipping a new hollow one
// is a red build.
const KNOWN_HOLLOW = new Set([3, 4, 5, 6, 7, 8, 9]);

function winRate(id, build) {
    return SEEDS.filter((seed) => play(Number(id), seed, build).outcome === "win").length;
}

afterEach(() => {
    Math.random = REAL_RANDOM;
    resetWorld();
    achievements._reloadForTests();
});

describe("every reference solution wins the level it belongs to (#254)", () => {
    for (const [id, level] of Object.entries(LEVELS)) {
        it(`L${id} — ${level.teaches}, played as briefed`, () => {
            expect(winRate(id, () => {
                level.taught();
                tier();
            })).toBe(SEEDS.length);
        });
    }
});

describe("and the level is LOST when its own mechanic is ignored", () => {
    for (const [id, level] of Object.entries(LEVELS)) {
        const n = Number(id);
        it(`L${id} — ${level.teaches} withheld, everything else the same`, () => {
            const wins = winRate(id, tier);
            if (KNOWN_HOLLOW.has(n)) {
                // Recorded, not endorsed. The failure this guards against is a
                // level QUIETLY joining the set — so the only thing asserted
                // here is that the level is still in the state we wrote down.
                expect(wins, `L${id} is recorded as hollow`).toBeGreaterThan(0);
            } else {
                expect(wins, `L${id}'s lesson must be load-bearing`).toBe(0);
            }
        });
    }

    it("the hollow set never grows", () => {
        const measured = Object.keys(LEVELS)
            .map(Number)
            .filter((id) => winRate(id, tier) > 0);
        const unexpected = measured.filter((id) => !KNOWN_HOLLOW.has(id));
        expect(
            unexpected,
            "a level began passing without the service it teaches — either the " +
                "tuning drifted or a new level shipped hollow"
        ).toEqual([]);
    });

    it("L12 shows the shape a fixed level has", () => {
        // Kept explicit because it is the target, not a passing detail: what a
        // second WAF defends against cannot be absorbed by a faster box, so no
        // amount of vertical scaling substitutes for it.
        expect(winRate(12, tier)).toBe(0);
        expect(winRate(12, () => { LEVELS[12].taught(); tier(); })).toBe(SEEDS.length);
    });
});

describe("the Compute tier is the lever chapter 2 actually turns on", () => {
    // The finding in one assertion. On these three the taught service loses on
    // its own and the tier wins on its own — the level is a vertical-scaling
    // exercise wearing an architecture briefing.
    for (const id of [6, 7, 8]) {
        it(`L${id} — ${LEVELS[id].teaches} alone loses, the tier alone wins`, () => {
            expect(winRate(id, LEVELS[id].taught), `L${id} taught-only`).toBe(0);
            expect(winRate(id, tier), `L${id} tier-only`).toBe(SEEDS.length);
        });
    }

    it("three levels pass on a board the player never touched", () => {
        const untouched = [3, 5, 9].filter((id) => winRate(id, () => {}) > 0);
        // Asserting the defect so the fix has something to turn red. When a
        // level here stops passing untouched, this list is what to edit.
        expect(untouched).toEqual([3, 5, 9]);
    });
});
