// Level 4's primary objective was labelled "Average DB load below 70%".
//
// The check is `CampaignObjectives.maxLoadOfType(s, "db") < 0.7` — an
// instantaneous MAXIMUM across the database nodes. No average over time, no
// average across nodes.
//
// The word mattered: "average" tells the player that spikes are forgiven if
// the mean is fine. They are not. One reading at or above 70% at the deciding
// tick fails the level, and the difference between those two rules is the
// difference between "add a cache" and "add a cache AND smooth the peaks".
// All eleven locales carried the claim — Schnitt, moyenne, medio, 평균, 平均,
// средняя, औसत.
//
// Fixed by DELETING the qualifier rather than translating a new one: every
// locale now says the load is below 70%, which is what is checked, and no
// vocabulary was invented in eleven languages to say it.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, resetWorld, place } from "../helpers/sim-world.mjs";
import { CampaignObjectives } from "../../src/campaign/objectives.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { LOCALES, loadLocale } from "../helpers/load-globals.mjs";

const objective = () =>
    CAMPAIGN_LEVELS.find((l) => l.id === 4).objectives.primary
        .find((o) => o.id === "db_load_below_70");

describe("level 4's DB objective is graded the way it is worded", () => {
    beforeEach(() => resetWorld({ gameMode: "campaign" }));

    it("IT IS A MAXIMUM, NOT A MEAN: one hot node fails it even beside a cold one", () => {
        // The behavioural difference, stated where a reader will see it: an
        // average of 90 and 10 is 50 and would pass. The rule is the peak.
        const hot = place("db");
        const cold = place("db");
        hot.totalLoadOverride = 0.9;
        cold.totalLoadOverride = 0.1;
        Object.defineProperty(hot, "totalLoad", { get: () => 0.9, configurable: true });
        Object.defineProperty(cold, "totalLoad", { get: () => 0.1, configurable: true });

        expect(CampaignObjectives.maxLoadOfType(STATE, "db")).toBeCloseTo(0.9, 6);
        expect(objective().check(STATE), "a mean of 0.5 would have passed").toBe(false);
    });

    it("...and it passes only when every DB is under the line", () => {
        const a = place("db");
        const b = place("db");
        Object.defineProperty(a, "totalLoad", { get: () => 0.65, configurable: true });
        Object.defineProperty(b, "totalLoad", { get: () => 0.4, configurable: true });
        expect(objective().check(STATE)).toBe(true);
    });

    for (const locale of LOCALES) {
        it(`${locale.code}: the label does not promise an average`, async () => {
            const t = await loadLocale(locale);
            const label = t.obj_4_db_load_below_70;
            expect(label, `${locale.code} lost the objective label`).toBeTruthy();
            // The word for "average" in each shipped locale. A label that
            // reintroduces any of them is claiming a rule the check does not
            // apply.
            expect(label).not.toMatch(
                /average|schnitt|moyenne|medio|média|平均|평균|средн|серед|औसत/i
            );
            // ...and it still says the thing it does check. Nepali writes the
            // threshold in Devanagari digits, so an ASCII-only check would
            // fail a correct string — which is how a guard ends up policing
            // the alphabet instead of the claim.
            expect(label).toMatch(/70|७०/);
        });
    }
});
