// "Retry Same Setup" on the SYSTEM FAILURE card rebuilds the lost board and
// charges it against the survival start budget. A survival board is bought out
// of a run's income, so it is routinely worth more than that budget. Charged in
// full, a $1,500 board began the retry at -$1,000, the bankruptcy line, and the
// very next animate() frame (still paused) declared SYSTEM FAILURE again with
// a survival time of zero.
//
// These tests run the shipped animate() through a requestAnimationFrame stub,
// so the game-over check that fired is the real one.
import { describe, it, expect, beforeEach } from "vitest";

const pending = [];
globalThis.requestAnimationFrame = (cb) => { pending.push(cb); return pending.length; };
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../src/state.js");
const { CONFIG } = await import("../../src/config.js");
const { resetGame } = await import("../../game.js");
const { createService } = await import("../../src/sim/topology.js");

let clock = 0;
function frame() {
    const cb = pending.pop();
    pending.length = 0;
    if (!cb) return false;
    clock += 50;
    cb(clock);
    return true;
}
const modalOpen = () => !document.getElementById("modal").classList.contains("hidden");
const V = (x, z = 0) => new globalThis.THREE.Vector3(x, 0, z);
const START = CONFIG.survival.startBudget;

function loseWith(board) {
    resetGame("survival");
    STATE.money = 100000; // what the run earned along the way
    STATE.timeScale = 1;
    board.forEach((t, i) => createService(t, V((i % 6) * 8, Math.floor(i / 6) * 8)));
    expect(STATE.services.length, "board placed").toBe(board.length);
    STATE.reputation = 0;
    expect(frame(), "animate() is running").toBe(true);
    expect(modalOpen(), "SYSTEM FAILURE shown").toBe(true);
    return STATE.services.reduce((sum, s) => sum + s.config.cost, 0);
}

// A mid-game survival board: 12 Compute, 2 DB, Cache, CDN, S3, 2 WAF, 2 ALB,
// SQS, API GW, NoSQL.
const BIG = [
    ...Array(12).fill("compute"), "db", "db", "cache", "cdn", "s3",
    "waf", "waf", "alb", "alb", "sqs", "apigw", "nosql",
];

beforeEach(() => { try { localStorage.clear(); } catch { /* storage unavailable */ } });

describe("Retry Same Setup gives a playable run", () => {
    it("a board worth $1,500 or more is not lost again on its first frame", () => {
        const cost = loseWith(BIG);
        expect(cost).toBeGreaterThanOrEqual(START + 1000);

        window.retryWithSameArchitecture();
        expect(STATE.services.length, "board rebuilt").toBe(BIG.length);
        frame();
        frame();

        expect(STATE.isRunning, `money ${STATE.money}`).toBe(true);
        expect(modalOpen(), "SYSTEM FAILURE shown again at once").toBe(false);
    });

    it("a board the start budget cannot cover is charged the budget, starting at $0", () => {
        loseWith(BIG);

        window.retryWithSameArchitecture();

        expect(STATE.money).toBe(0);
        expect(STATE.finances.expenses.services).toBe(START);
    });

    it("a board the start budget covers is charged in full, exactly as before", () => {
        const cost = loseWith(["waf", "alb", "compute"]);
        expect(cost).toBeLessThan(START);

        window.retryWithSameArchitecture();

        expect(STATE.money).toBe(START - cost);
        expect(STATE.finances.expenses.services).toBe(cost);
    });
});
