// Sandbox ships with upkeep OFF (CONFIG.sandbox.upkeepEnabled === false) and
// Service.update() charges only inside `if (STATE.upkeepEnabled)`. The HUD
// line never asked — the auto-repair deduction ten lines above it does — so
// every sandbox session showed a red "Upkeep Cost -$X.XX/s" that is never
// charged, beside a finances panel reporting $0 upkeep and a button reading
// "Upkeep: OFF".
//
// Driven through the shipped animate(), because a copy of the branch would
// prove nothing about what a player sees.
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
const display = () => document.getElementById("upkeep-display")?.innerText || "";
const V = (x) => new globalThis.THREE.Vector3(x, 0, 0);

describe("the upkeep line reports what the meter charges", () => {
    beforeEach(() => { try { localStorage.clear(); } catch { /* */ } });

    it("SANDBOX: upkeep is off, so the line does not bill for it", () => {
        resetGame("sandbox");
        expect(STATE.upkeepEnabled, "sandbox ships with upkeep off").toBe(false);
        STATE.money = 5000;
        STATE.timeScale = 1;
        createService("db", V(0));
        createService("compute", V(8));
        expect(CONFIG.services.db.upkeep, "the board really does have upkeep to show")
            .toBeGreaterThan(0);

        expect(frame(), "animate() must be running for this to prove anything").toBe(true);
        frame();

        expect(display(), `the HUD billed for upkeep that is switched off: "${display()}"`)
            .not.toMatch(/-\$[1-9]/);
        expect(display()).toMatch(/0\.00/);
    });

    it("SURVIVAL: upkeep is on, and the line shows it", () => {
        resetGame("survival");
        expect(STATE.upkeepEnabled).toBe(true);
        STATE.money = 5000;
        STATE.timeScale = 1;
        createService("db", V(0));
        createService("compute", V(8));

        frame();
        frame();

        // A real, non-zero rate — the mirror of the case above, so a fix that
        // simply zeroed the line everywhere would fail here.
        expect(display()).toMatch(/-\$\d+\.\d\d\/s/);
        expect(display()).not.toMatch(/-\$0\.00/);
    });
});
