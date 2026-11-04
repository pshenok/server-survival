// The heading on the stats panel names the mode being played. It was fixed
// text, so campaign and sandbox runs were both headed SURVIVAL, in that mode's
// pulsing red, and with survival's rules not applying to either of them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetGame } from "../../game.js";
import { i18n } from "../../src/i18n.js";
import { loadGameState } from "../../src/persistence/save-load.js";
import { STATE } from "../helpers/sim-world.mjs";

const title = () => document.getElementById("mode-title");

function save(gameMode) {
    return {
        version: "2.0",
        money: 500,
        reputation: 80,
        requestsProcessed: 0,
        isRunning: false,
        gameMode,
        services: [],
        connections: [],
        internetConnections: [],
    };
}

beforeEach(() => {
    i18n.setLocale("en");
    resetGame("survival");
});

afterEach(() => {
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("the stats panel is headed by the mode being played", () => {
    it.each([
        ["survival", "survival"],
        ["campaign", "campaign_select_title"],
        ["sandbox", "sandbox"],
    ])("a new %s run reads %s", (mode, key) => {
        resetGame(mode);

        expect(title().textContent).toBe(i18n.t(key));
    });

    it("only survival gets the alarm: red and pulsing", () => {
        expect(title().classList.contains("animate-pulse")).toBe(true);
        expect(title().classList.contains("text-red-500")).toBe(true);

        for (const mode of ["campaign", "sandbox"]) {
            resetGame(mode);
            expect(title().classList.contains("animate-pulse"), mode).toBe(false);
            expect(title().classList.contains("text-red-500"), mode).toBe(false);
        }
    });

    it("going back to survival restores it", () => {
        resetGame("sandbox");
        resetGame("survival");

        expect(title().textContent).toBe(i18n.t("survival"));
        expect(title().classList.contains("animate-pulse")).toBe(true);
        expect(title().classList.contains("text-purple-400")).toBe(false);
    });

    it("a language switch keeps the mode", () => {
        resetGame("sandbox");

        i18n.setLocale("ru");

        expect(title().textContent.trim()).toBe(i18n.t("sandbox"));
        expect(title().textContent.trim()).not.toBe(i18n.t("survival"));
    });

    it.each([
        ["sandbox", "sandbox"],
        ["survival", "survival"],
    ])("a loaded %s save reads %s", (mode, key) => {
        resetGame(mode === "sandbox" ? "survival" : "sandbox");

        loadGameState(save(mode));

        expect(title().textContent).toBe(i18n.t(key));
    });
});
