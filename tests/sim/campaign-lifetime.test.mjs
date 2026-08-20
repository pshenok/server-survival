// A campaign level's controller belongs to that level.
//
// `window.campaign.active` is set by loadLevel() and cleared by exit(), and
// exit() was called from exactly one place: exitCampaignToMap(). Every other
// way out of a level — Escape to the pause menu and then New Game or Sandbox,
// or the menu's own campaign exit — left the controller running, and
// animate() keeps calling campaign.tick(dt) for as long as it is.
//
// The cosmetic half of that is the abandoned level's objectives repainting
// over a survival HUD. The real half is that the controller GRADES: resetGame
// hands a new run reputation 100 while STATE.campaign.completedByType still
// holds what was banked during the campaign attempt, and those two together
// are the win gate. A level abandoned in failure was scored a WIN on a
// sandbox board with nothing built on it.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { saveGameState, loadGameState } from "../../src/persistence/save-load.js";

// What the campaign map writes before a level is playable.
function unlock(upTo = 25) {
    try {
        localStorage.setItem(
            "serverSurvivalCampaignProgress",
            JSON.stringify({ version: 1, completed: {}, highestUnlocked: upTo })
        );
    } catch { /* storage unavailable — startCampaignLevel still runs */ }
}

// One frame of animate(), verbatim in the part that matters.
function frame(dt) {
    if (window.campaign?.active) window.campaign.tick(dt);
}

describe("a campaign level does not keep grading after you leave it", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* */ }
        unlock();
    });

    it("THE FREE WIN: an abandoned level used to be won off an empty sandbox board", () => {
        window.startCampaignLevel(1);
        // Play most of it, then fail the standing on purpose: 50 READs
        // served, reputation under the level's floor. This is a LOSS.
        for (let i = 0; i < 50; i++) window.campaign.onRequestCompleted({ type: "READ" }, "db");
        STATE.reputation = 60;
        frame(0.6);
        expect(STATE.campaign.ended, "the level must not be over yet").toBe(false);

        // Escape, then "Sandbox Mode" — what window.startSandbox() does.
        resetGame("sandbox");
        expect(window.campaign.active, "the controller should have shut down").toBe(false);

        // A whole second of sandbox on a board with nothing on it.
        for (let i = 0; i < 10; i++) frame(0.1);
        expect(STATE.gameMode).toBe("sandbox");
        expect(STATE.services.length).toBe(0);
        expect(STATE.campaign.outcome, "a sandbox board cannot win a campaign level").not.toBe("win");
        expect(STATE.campaign.ended, "and no level may END during a sandbox run").toBe(false);
        // resetGame starts every run paused, so timeScale is 0 either way —
        // the debrief modal is the signal that a level resolved on top of it.
        const debrief = document.getElementById("campaign-debrief-modal");
        expect(debrief?.classList.contains("hidden"), "a debrief opened over the sandbox").toBe(true);
    });

    it("THE MIRROR: an abandoned level's timeout used to end a later run in a LOSE", () => {
        window.startCampaignLevel(2);
        frame(0.6);
        resetGame("survival");
        // Play past whatever deadline the abandoned level was counting to.
        STATE.elapsedGameTime = 100000;
        for (let i = 0; i < 10; i++) frame(0.1);
        expect(STATE.campaign.outcome).not.toBe("lose");
        expect(STATE.campaign.ended, "a survival run was ended by a level nobody was playing").toBe(false);
    });

    it("the scripted traffic of a level stops when the level does", () => {
        window.startCampaignLevel(5);
        frame(0.6);
        resetGame("survival");
        const before = STATE.requests.length;
        for (let i = 0; i < 200; i++) frame(0.1);
        expect(STATE.requests.length, "a level's bursts fired into a survival run").toBe(before);
    });

    it("A SAVE IS A DIFFERENT RUN: loading one stops the level it landed on", () => {
        // Escape opens the pause menu during a level, and "Continue Game" is
        // offered whenever a save exists. save-load.js never saved or restored
        // campaign state — but nothing shut the controller down either, so the
        // load swapped the whole board while the level kept grading it.
        //
        // Level 15 hands the player $190 and a monitor-only palette. A sandbox
        // save carrying $4300 and whatever the player felt like building was
        // graded against level 15's objectives, and won it: both the budget
        // and allowedServices bypassed, the palette gate being UI-only.
        resetGame("sandbox");
        STATE.money = 4300;
        saveGameState();

        window.startCampaignLevel(15);
        const levelBudget = STATE.money;
        expect(window.campaign.active).toBe(true);
        expect(levelBudget).toBeLessThan(4300);

        loadGameState();

        expect(window.campaign.active, "a loaded save kept grading a level").toBe(false);
        expect(STATE.campaign.level, "and it kept pointing at that level").toBeNull();
        expect(STATE.money).toBe(4300);
        // ...and a frame of the loaded run resolves nothing.
        for (let i = 0; i < 10; i++) frame(0.1);
        expect(STATE.campaign.ended).toBe(false);
        expect(STATE.campaign.outcome).not.toBe("win");
    });

    it("...and the loaded run does not wear the abandoned level's objectives", () => {
        resetGame("survival");
        saveGameState();
        window.startCampaignLevel(1);
        frame(0.6);
        loadGameState();
        const panel = document.getElementById("objectivesPanel");
        expect(panel.classList.contains("hidden"),
            "a save has no campaign in it to show").toBe(true);
    });

    it("...but starting a campaign level still arms it — the gate is the mode, not the call", () => {
        // resetGame("campaign") runs INSIDE startCampaignLevel, before
        // loadLevel. If the shutdown were unconditional it would disarm the
        // very run it is about to start.
        window.startCampaignLevel(3);
        expect(window.campaign.active).toBe(true);
        expect(STATE.campaign.level.id).toBe(3);
    });
});
