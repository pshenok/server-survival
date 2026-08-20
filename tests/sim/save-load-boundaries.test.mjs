// Loading a save is a RUN BOUNDARY, and the load path was one short of it.
//
// saveGameState() spreads ...STATE, so every counter has always been in the
// file. loadGameState() restored a chosen few — requestsProcessed, score,
// money, reputation, elapsedGameTime, finances — and left the rest holding
// whatever the session the player walked away from had put there.
//
// requestsProcessed jumping back while lateCompletions did not is the one
// that shows: getRunReport computes onTime as max(0, processed - late), so
// the debrief printed "Served 0 of 5 (0% on time) - 40 late" — forty late
// answers out of five requests, on the screen whose whole job is to tell the
// player what just happened.
//
// The rolling windows are the other half. A thirty-second ring buffer is not
// in the file and cannot be, so they are CLEARED rather than carried:
// showing the abandoned session's last thirty seconds beside a resumed board
// is worse than showing nothing, which is what an empty window renders.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { saveGameState, loadGameState } from "../../src/persistence/save-load.js";
import { getRunReport, getRollingGoodput, metricsTick } from "../../src/core/metrics.js";
import { finishRequest } from "../../src/core/actions.js";
import { Request } from "../../src/entities/Request.js";
import { CONFIG, place } from "../helpers/sim-world.mjs";

describe("a loaded save carries its own history, and only its own", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* storage unavailable */ }
    });

    it("A LOADED RUN DOES NOT INHERIT THE ABANDONED ONE'S TALLIES", () => {
        // saveGameState spreads ...STATE, so lateCompletions, failures and
        // failuresByReason were always IN the file — the load just never read
        // them back, while requestsProcessed jumped to the save's value. The
        // debrief then contradicted itself, because getRunReport computes
        // onTime as max(0, processed - late).
        resetGame("survival");
        STATE.requestsProcessed = 5;
        saveGameState();                       // a small, clean run

        STATE.requestsProcessed = 400;         // ...then a long, messy one
        STATE.lateCompletions = 40;
        STATE.failures.READ = 12;
        STATE.failuresByReason = { capacity: 12 };

        loadGameState();

        expect(STATE.requestsProcessed).toBe(5);
        expect(STATE.lateCompletions).toBe(0);
        expect(STATE.failures.READ).toBe(0);
        expect(STATE.failuresByReason).toEqual({});
        // The invariant the debrief divides by.
        expect(STATE.lateCompletions).toBeLessThanOrEqual(STATE.requestsProcessed);
        const r = getRunReport();
        expect(r.onTime + r.late).toBe(r.processed);
    });

    it("...and a run saved WITH lateness keeps it — this is a resume, not a wipe", () => {
        // The counters are restored, not zeroed: a save is meant to resume a
        // run faithfully, and requestsProcessed has always been restored that
        // way. Zeroing would make a resumed run under-report its own history.
        resetGame("survival");
        STATE.requestsProcessed = 20;
        STATE.lateCompletions = 6;
        STATE.failures.WRITE = 3;
        saveGameState();
        resetGame("survival");                 // walk away, start fresh
        loadGameState();
        expect(STATE.requestsProcessed).toBe(20);
        expect(STATE.lateCompletions).toBe(6);
        expect(STATE.failures.WRITE).toBe(3);
    });

    it("the rolling goodput window starts empty rather than showing the old run's", () => {
        // Not restorable and not carried: a thirty-second ring buffer is not
        // in the file. getRollingGoodput returns null for an empty window,
        // which the HUD renders as "--" — the honest reading for a board that
        // has not answered anything yet.
        resetGame("survival");
        saveGameState();

        // Fill the window with the run the player is about to walk away from:
        // ten answers, every one of them late, so it reads a hard 0%.
        // resetGame starts every run PAUSED and metricsTick freezes at
        // timeScale 0 on purpose, so the clock has to be running for the
        // window to take a sample at all.
        STATE.timeScale = 1;
        const db = place("db");
        for (let i = 0; i < 10; i++) {
            const req = new Request("READ");
            STATE.requests.push(req);
            req.age = CONFIG.trafficTypes.READ.sloSec * 3;
            finishRequest(req, db.type, db);
        }
        metricsTick(0.5);
        expect(getRollingGoodput(), "the window must hold something first").toBe(0);

        loadGameState();
        expect(getRollingGoodput(), "the resumed board wore the old run's goodput")
            .toBeNull();
    });
});
