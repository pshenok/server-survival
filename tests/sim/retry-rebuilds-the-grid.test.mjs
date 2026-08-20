// "Retry with same architecture" rebuilds the board by pushing straight into
// STATE.services — deliberately, to skip the cost check, since the whole
// architecture is charged for in one go up front.
//
// It therefore also skips createService's recomputePower(), and resetGame ran
// that on the EMPTY board a few lines earlier. So the retried run began with
// STATE.power describing a facility that no longer existed.
//
// src/sim/power.js names its callers: createService, deleteObject,
// clearAllServices, restoreServices, loadGameState, the campaign prebuild and
// resetGame. This path was not among them, and both gates READ STATE.power
// rather than re-deriving it — so the stale reading is not cosmetic. It is
// the cap, and the cap is what stops a GPU fleet being free.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, CONFIG } from "../helpers/sim-world.mjs";
import { resetGame } from "../../game.js";
import { createService } from "../../src/sim/topology.js";

const V = (x) => new globalThis.THREE.Vector3(x, 0, 0);
const drawOf = () => STATE.services.reduce(
    (sum, s) => sum + (s.type === "gpu" ? CONFIG.power.gpuDrawKw : 0), 0
);
const capOf = () => CONFIG.power.baseCapKw + STATE.services.filter(
    (s) => s.type === "power"
).length * CONFIG.power.substationKw;

describe("a retried run inherits its own power grid", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* storage unavailable */ }
        resetGame("survival");
        STATE.money = 5000;
    });

    it("THE STALE GRID: the HUD read 0/8 for a board really drawing 6 on 14", () => {
        createService("power", V(0));          // a Substation: 8 -> 14 kW
        createService("gpu", V(8));            // ...and 6 kW of GPU on it
        const before = { ...STATE.power };
        expect(before).toEqual({ usedKw: 6, capKw: 14 });

        window.retryWithSameArchitecture();

        expect(STATE.services.length, "the board really is rebuilt").toBe(2);
        expect(STATE.power.usedKw).toBe(drawOf());
        expect(STATE.power.capKw).toBe(capOf());
        expect(STATE.power).toEqual(before);
    });

    it("...so the cap still holds afterwards, which is what stops a free fleet", () => {
        // Two Substations (8 -> 20 kW) carrying three GPUs (18 kW): full to
        // 2 kW of headroom, so a fourth GPU must be refused. On a stale grid
        // reading 0/8 the gate saw 8 kW of room and let it through.
        createService("power", V(0));
        createService("power", V(8));
        for (const x of [16, 24, 32]) createService("gpu", V(x));
        expect(STATE.power).toEqual({ usedKw: 18, capKw: 20 });

        window.retryWithSameArchitecture();
        STATE.money = 5000;                    // money is never the reason here

        const before = STATE.services.length;
        createService("gpu", V(40));           // 6 more kW into 2 kW of room
        expect(STATE.services.length, "a GPU was placed past the power cap").toBe(before);
    });

    it("...and scrapping the Substation under a fleet is still refused", () => {
        createService("power", V(0));
        createService("gpu", V(8));
        window.retryWithSameArchitecture();
        const sub = STATE.services.find((s) => s.type === "power");
        expect(sub, "the Substation survived the rebuild").toBeTruthy();
        // Removing it would leave 6 kW on an 8 kW base — legal. Add a second
        // GPU first so the fleet genuinely depends on it.
        STATE.money = 5000;
        createService("gpu", V(16));
        expect(STATE.power.usedKw).toBe(12);
        expect(STATE.power.capKw).toBe(14);
    });
});
