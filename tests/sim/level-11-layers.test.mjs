// Level 11's briefing used to say "A single Firewall isn't enough; you need
// defense in layers." A single Firewall is a flawless win.
//
// Measured, three seeds, the level's own prebuilt board plus one $40 WAF on a
// $300 budget:
//
//   single   win(rep 100, leaks 0)  win(rep 100, leaks 0)  win(rep 100, leaks 0)
//   layered  win(rep 100, leaks 0)  win(rep 100, leaks 0)  win(rep 100, leaks 0)
//
// The reason is tuning, not a bug. The WAF's capacity is 30 and the level
// runs at 8 rps, so the filter sits at roughly a quarter load and physically
// cannot be overwhelmed. For the layered lesson to bite, the wave has to
// exceed what one filter can pass — the API Gateway's rateLimit of 30 never
// binds at 8 rps either.
//
// So the briefing lost the false half of its claim, and the rest of it —
// "WAF blocks MALICIOUS hard, API Gateway throttles legitimate spikes" — is
// true and untouched.
//
// THIS TEST IS THE RECEIPT. If the level is ever retuned so one Firewall is
// genuinely not enough, it goes red, and the stronger line can come back.
// That is the intended direction: red here means the level got better.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, CONFIG, resetWorld } from "../helpers/sim-world.mjs";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { UK_TRANSLATIONS } from "../../src/locales/uk.js";
import { play, placeAt, svc } from "../helpers/campaign-play.mjs";
import { createConnection } from "../../src/sim/topology.js";

const SEEDS = [1, 2, 42];

function oneFirewall() {
    const waf = placeAt("waf", -18, 0);
    createConnection("internet", waf.id);
    createConnection(waf.id, svc("alb").id);
}

describe("level 11 says what a single Firewall actually does", () => {
    beforeEach(() => resetWorld());

    it("ONE FIREWALL WINS IT — every seed, unblemished", () => {
        for (const seed of SEEDS) {
            const r = play(11, seed, oneFirewall);
            expect(r.outcome, `seed ${seed}`).toBe("win");
            expect(STATE.failures.MALICIOUS, `seed ${seed}: a leak got through`).toBe(0);
            expect(STATE.reputation).toBeGreaterThan(95);
        }
    });

    it("...because the filter is nowhere near its limit at this rate", () => {
        // The arithmetic behind the tuning, stated so a config change that
        // closes the gap shows up here and not only in a play-through.
        const level = CAMPAIGN_LEVELS.find((l) => l.id === 11);
        const waf = CONFIG.services.waf;
        const gateway = CONFIG.services.apigw;

        // Everything arriving, malicious and legitimate alike, goes through
        // the one entry node.
        expect(level.rps).toBeLessThan(waf.capacity / 3);

        // ...and the Gateway's rate limiter never engages either, so the
        // second layer has nothing to do on this level even when bought.
        expect(level.rps).toBeLessThan(gateway.rateLimit);

        // The share is high, the RATE is not: 70% of 8 rps is under six
        // malicious a second against a filter rated for thirty.
        expect(level.trafficDistribution.MALICIOUS).toBeGreaterThan(0.5);
        expect(level.rps * level.trafficDistribution.MALICIOUS).toBeLessThan(waf.capacity / 4);
    });

    it("neither locale claims a single Firewall will fail", () => {
        for (const [name, T] of [["en", EN_TRANSLATIONS], ["uk", UK_TRANSLATIONS]]) {
            const scenario = T.level_11_scenario;
            expect(scenario, `${name} lost its level 11 briefing`).toBeTruthy();
            expect(scenario.toLowerCase(), `${name} still says one Firewall is not enough`)
                .not.toMatch(/isn't enough|is not enough|замало/);
        }
    });

    it("...and the half that IS true is still there — both nodes, both jobs", () => {
        expect(EN_TRANSLATIONS.level_11_learn).toMatch(/WAF/);
        expect(EN_TRANSLATIONS.level_11_learn).toMatch(/API Gateway/);
        expect(UK_TRANSLATIONS.level_11_learn).toMatch(/WAF/);
        expect(UK_TRANSLATIONS.level_11_learn).toMatch(/API Gateway/);
    });
});
