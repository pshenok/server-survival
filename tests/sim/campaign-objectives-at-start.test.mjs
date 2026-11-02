// A campaign level shows its own objectives the moment it starts.
//
// A level starts paused, so the player can read the board and the goals
// before pressing Play. But the objectives panel was only ever filled by the
// campaign's 2 Hz evaluation tick, which does not run while paused, so until
// the first Play it still held the survival checklist from index.html:
// "Survive Endless Traffic", "Route STATIC/UPLOAD -> Storage", and so on.
// On Level 21 that is a list of goals the level does not have, in place of
// "Serve 80 INFERENCE requests".
//
// The fix draws the level's list at start with nothing ticked. It does not
// evaluate the checks early: some of them latch state (Level 22's profit
// floor), and the first tick evaluates them half a second into play anyway.
import { describe, it, expect, beforeEach } from "vitest";
import { startCampaignLevel } from "../../src/ui/campaign-ui.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { i18n } from "../../src/i18n.js";
import { STATE } from "../helpers/sim-world.mjs";

const panelText = () => document.getElementById("objectivesPanel").textContent;

beforeEach(() => {
    localStorage.setItem(
        "serverSurvivalCampaignProgress",
        JSON.stringify({ version: 1, completed: {}, highestUnlocked: 25 })
    );
    STATE.animationId = 1; // keep resetGame from starting the real rAF loop
});

describe("the objectives panel at the start of a level, before any Play", () => {
    it.each([1, 9, 21])("Level %i shows its own heading and goals, not the survival list", (id) => {
        startCampaignLevel(id);

        expect(STATE.timeScale, "the level starts paused").toBe(0);
        const text = panelText();
        expect(text).not.toContain(i18n.t("survive_endless"));
        expect(text).toContain(i18n.t("campaign_hud_level", { id, title: "" }).trim().replace(/:$/, ""));
        const level = CAMPAIGN_LEVELS.find((l) => l.id === id);
        expect(document.querySelectorAll("#objectivesPanel li")).toHaveLength(
            level.objectives.primary.length + level.objectives.bonus.length
        );
    });

    it("nothing is ticked before the level has been played", () => {
        startCampaignLevel(21);

        expect(panelText()).not.toMatch(/[☑⭐]/);
        expect(STATE.campaign.objectiveResults).toEqual({});
    });
});
