// The COST SPIKE banner promised something the meter did not charge.
//
// getUpkeepMultiplier() bundled two different things behind one gate:
//
//   the RAMP  — upkeep climbing 1x to 2x over ten minutes, a survival
//               progression mechanic, and what `gameMode !== "survival"` was
//               written to guard;
//   the SPIKE — STATE.intervention.costMultiplier, set by a random EVENT.
//
// updateRandomEvents runs inside any campaign level with enableSurvivalShifts
// (14 and 25), so the event's ARRIVAL was gated on the level while its EFFECT
// was gated on the mode. The player got an eight-second danger toast reading
// "CLOUD COST SPIKE! Upkeep doubled for 30s" and a full-width red bar, and the
// upkeep charged exactly what it had the second before.
//
// The other three event types have no such split: CAPACITY_DROP and the rest
// write state that is consumed ungated.
//
// What it costs, measured before making the change — worst case, the spike
// pinned on for the WHOLE level rather than its real 30 s window:
//   L14 (90 s, a five-service board): 644 -> 629, fifteen dollars
//   L25 (300 s, nine prebuilt):      2134 -> 1801
// against a moneyBelow floor of -500 in both. Both levels are lost on
// reputation, which a cost spike does not touch.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, CONFIG, resetWorld, place } from "../helpers/sim-world.mjs";
import { getUpkeepMultiplier } from "../../src/core/actions.js";

describe("a cost spike costs money in every mode that can raise its banner", () => {
    beforeEach(() => resetWorld({ gameMode: "campaign" }));

    it("THE LIE: the campaign banner said doubled and the meter charged 1x", () => {
        expect(getUpkeepMultiplier()).toBe(1.0);
        STATE.intervention.costMultiplier = 2.0;        // what the event sets
        expect(getUpkeepMultiplier(), "the banner is up and nothing changed").toBe(2.0);
    });

    it("...and a service really is charged double while it is up", () => {
        STATE.upkeepEnabled = true;
        const db = place("db");
        const rate = CONFIG.services.db.upkeep / 60;

        let before = STATE.money;
        db.update(1);
        const plain = before - STATE.money;

        STATE.intervention.costMultiplier = 2.0;
        before = STATE.money;
        db.update(1);
        const spiked = before - STATE.money;

        expect(plain).toBeCloseTo(rate, 6);
        expect(spiked).toBeCloseTo(rate * 2, 6);
    });

    it("THE RAMP STAYS SURVIVAL-ONLY — the gate still guards what it was for", () => {
        // Narrowing the gate must not import survival's ten-minute upkeep
        // climb into a campaign level, which would re-price all twenty-five.
        STATE.elapsedGameTime = CONFIG.survival.upkeepScaling.scaleTime;  // fully ramped
        expect(getUpkeepMultiplier(), "the survival ramp leaked into a campaign").toBe(1.0);

        resetWorld({ gameMode: "survival" });
        STATE.elapsedGameTime = CONFIG.survival.upkeepScaling.scaleTime;
        expect(getUpkeepMultiplier()).toBeCloseTo(CONFIG.survival.upkeepScaling.maxMultiplier, 6);
    });

    it("...and the two multiply in survival, where both apply", () => {
        resetWorld({ gameMode: "survival" });
        STATE.elapsedGameTime = CONFIG.survival.upkeepScaling.scaleTime;
        STATE.intervention.costMultiplier = 2.0;
        expect(getUpkeepMultiplier())
            .toBeCloseTo(CONFIG.survival.upkeepScaling.maxMultiplier * 2, 6);
    });

    it("the test world starts with no intervention running, as its header claims", () => {
        // resetWorld's own comment has said "no interventions" since it was
        // written, without ever clearing them. Nothing noticed while the mode
        // gate suppressed the one that bites.
        resetWorld({ gameMode: "survival" });
        STATE.intervention.costMultiplier = 2.0;
        STATE.intervention.trafficBurstMultiplier = 3.0;
        resetWorld({ gameMode: "survival" });
        expect(STATE.intervention.costMultiplier).toBe(1.0);
        expect(STATE.intervention.trafficBurstMultiplier).toBe(1.0);
    });
});
