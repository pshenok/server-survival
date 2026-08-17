// A run's events belong to that run. resetGame() already ends a live random
// event and rewinds its timers, for a reason it states: the deadline is a
// game-time stamp, so a stranded event measured against a clock restarting at
// zero holds its effects over the whole next session.
//
// The traffic shift is the same kind of thing and was not on that list. Four
// of its fields outlived a run, and the damaging one is originalTrafficDist:
// endTrafficShift() RESTORES it, so a stranded copy does not misfire once —
// it silently becomes the next run's baseline, and every shift in that run
// returns to the old run's traffic mix instead of the new one's.
import { describe, it, expect } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { updateMaliciousSpike, updateTrafficShift } from "../../src/core/events.js";

// Exactly what a run quit in the middle of a shift leaves behind.
const GHOST = {
    STATIC: 0.99, READ: 0.01, WRITE: 0, UPLOAD: 0,
    SEARCH: 0, MALICIOUS: 0, INFERENCE: 0,
};
function quitMidShift() {
    resetGame("survival");
    STATE.intervention.trafficShiftActive = true;
    STATE.intervention.trafficShiftTimer = 7;
    STATE.intervention.originalTrafficDist = { ...GHOST };
    STATE.intervention.currentShift = { id: "ghost" };
}

describe("a traffic shift does not outlive its run", () => {
    it("resetGame clears every field of it, the way it already clears random events", () => {
        quitMidShift();
        resetGame("campaign");
        expect(STATE.intervention.trafficShiftActive).toBe(false);
        expect(STATE.intervention.trafficShiftTimer).toBe(0);
        expect(STATE.intervention.originalTrafficDist).toBeNull();
        expect(STATE.intervention.currentShift).toBeNull();
    });

    it("THE DAMAGE: the old run's mix used to become the new run's baseline", () => {
        quitMidShift();
        resetGame("survival");
        const baseline = STATE.trafficDistribution.STATIC;

        // Play out several shift cycles and collect every distribution the
        // run settles BACK to. Each of those is a restore, and each one must
        // be this run's baseline.
        const restores = new Set();
        for (let t = 1; t <= 200; t++) {
            const before = STATE.trafficDistribution.STATIC;
            updateTrafficShift(1);
            const after = STATE.trafficDistribution.STATIC;
            if (Math.abs(after - before) > 1e-9) restores.add(+after.toFixed(3));
        }
        // The run did shift at least once, or this proves nothing.
        expect(restores.size).toBeGreaterThan(0);
        // ...and the ghost's 0.99 is not among the values it ever took.
        expect(restores.has(0.99)).toBe(false);
        expect(STATE.intervention.originalTrafficDist === null
            || STATE.intervention.originalTrafficDist.STATIC === baseline).toBe(true);
    });

    it("...and a malicious spike is not suppressed by a shift from a run that ended", () => {
        // startMaliciousSpike() early-returns while a shift is active, and
        // has no mode gate — so in a CAMPAIGN level, where updateTrafficShift
        // returns early and can never clear the flag, a stranded shift used
        // to suppress every spike for the rest of the page session.
        quitMidShift();
        resetGame("survival");
        STATE.elapsedGameTime = 100000;
        STATE.maliciousSpikeTimer = 100000;
        for (let i = 0; i < 200 && !STATE.maliciousSpikeActive; i++) {
            updateMaliciousSpike(1);
        }
        expect(STATE.maliciousSpikeActive).toBe(true);
    });
});
