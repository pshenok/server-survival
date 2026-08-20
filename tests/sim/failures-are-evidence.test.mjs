// The Failures panel's "Clear" link used to zero STATE.failures.
//
// That tally is not the panel's to rewrite. Four PRIMARY campaign objectives
// grade on it — L5 fail_under_5_pct, L9 fail_under_10_pct, L11 no_leaks,
// L23 fail_under_12_pct — plus eight bonus objectives, and the debrief's run
// report counts it. So one click on a small link turned a lost level into a
// won one, and level 11's whole subject (the Firewall has to be up BEFORE
// the wave, so nothing ever gets through) became "hide the evidence".
//
// The achievements engine had already been hardened against this exact
// button: src/achievements/achievements.js watches the tally for INCREASES
// only, "so clearing the panel cannot fake clean_two_minutes". The campaign
// evaluator and the debrief never got the same treatment. Recording a view
// preference instead of erasing history covers all three at once.
import { describe, it, expect, beforeEach } from "vitest";

// Captured BEFORE game.js is imported: animate() re-arms itself through
// requestAnimationFrame, so stubbing it hands us the real frame callback and
// the panel below is drawn by the shipped renderer, not by a copy of it.
const pending = [];
globalThis.requestAnimationFrame = (cb) => { pending.push(cb); return pending.length; };
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../src/state.js");
const { resetGame } = await import("../../game.js");
const { CAMPAIGN_LEVELS } = await import("../../src/campaign/levels.js");

let clock = 0;
// One real frame of animate(): 50 ms, under game.js's own 0.1 s clamp.
function frame() {
    const cb = pending.pop();
    pending.length = 0;
    if (!cb) return false;
    clock += 50;
    cb(clock);
    return true;
}

const clear = () => document.getElementById("clear-all").click();
const total = () => Object.values(STATE.failures).reduce((a, n) => a + n, 0);
const hidden = () => document.getElementById("failures-panel").classList.contains("hidden");

// Every objective in the campaign whose check reads STATE.failures.
function failureObjectives() {
    const out = [];
    for (const lvl of CAMPAIGN_LEVELS) {
        for (const kind of ["primary", "bonus"]) {
            for (const o of lvl.objectives[kind]) {
                if (/^(no_leaks|no_drops|nothing_lost|fail_under_|no_\w+_fails)/.test(o.id)) {
                    out.push({ level: lvl.id, kind, o });
                }
            }
        }
    }
    return out;
}

describe("a failure that happened stays happened", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* */ }
        resetGame("campaign");
    });

    it("THE EXPLOIT: level 11's no_leaks used to go green on one click", () => {
        const l11 = CAMPAIGN_LEVELS.find((l) => l.id === 11);
        const noLeaks = [...l11.objectives.primary, ...l11.objectives.bonus]
            .find((o) => o.id === "no_leaks");
        STATE.failures.MALICIOUS = 7;          // seven attacks got through
        expect(noLeaks.check(STATE)).toBe(false);
        clear();
        expect(STATE.failures.MALICIOUS).toBe(7);
        expect(noLeaks.check(STATE), "the level was won by hiding the evidence").toBe(false);
    });

    it("...and no OTHER failure-graded objective moves either, on any level", () => {
        // The button is one click; the blast radius is the whole campaign.
        const objectives = failureObjectives();
        expect(objectives.length, "the campaign grades on failures somewhere").toBeGreaterThan(8);
        for (const k of Object.keys(STATE.failures)) STATE.failures[k] = 4;
        STATE.requestsProcessed = 10;
        const before = objectives.map(({ o }) => o.check(STATE));
        clear();
        const after = objectives.map(({ o }) => o.check(STATE));
        expect(after).toEqual(before);
    });

    it("the run report still counts what actually failed", () => {
        STATE.failures.READ = 3;
        STATE.failures.MALICIOUS = 2;
        clear();
        expect(total()).toBe(5);
    });

    it("but the panel really is dismissed — the SHIPPED renderer leaves it hidden", () => {
        // Driven through animate() itself. Asserting only that the click hides
        // the panel would pass even if the renderer ignored the dismissal and
        // re-opened it on the very next frame, which is the whole way this
        // button could quietly become useless again.
        STATE.failures.READ = 3;
        STATE.isRunning = true;
        clear();
        expect(hidden()).toBe(true);
        expect(frame(), "animate() must actually be running for this to prove anything").toBe(true);
        frame();
        expect(hidden(), "the renderer re-opened a panel the player dismissed").toBe(true);
    });

    it("...and a dismissal is not a mute: something NEW brings it straight back", () => {
        STATE.failures.READ = 3;
        STATE.isRunning = true;
        clear();
        frame();
        expect(hidden()).toBe(true);
        STATE.failures.READ = 4;          // one new failure
        frame();
        expect(hidden(), "a new failure must re-open the panel").toBe(false);
        expect(document.getElementById("fail-read").textContent, "and it shows the TRUE tally")
            .toBe("4");
    });

    it("a new run starts undismissed", () => {
        STATE.failures.READ = 3;
        clear();
        expect(STATE.failuresDismissedAt).toBe(3);
        resetGame("survival");
        expect(STATE.failuresDismissedAt).toBe(0);
    });
});
