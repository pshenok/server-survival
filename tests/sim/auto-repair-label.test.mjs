// The auto-repair control says what it is and what state it is in.
//
// Three wrong strings had been wired to it since the i18n conversion. The
// button read "Upkeep: OFF", the label of a different button in the sandbox
// panel. Turning it off announced "Event ended". The hint under the repair
// table and the button's tooltip both read "Auto-repair enabled!", even with
// it off. And its data-i18n named a fixed key, so switching language replaced
// the state with "Auto-repair overhead", a line from the finances panel.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetGame } from "../../game.js";
import { i18n } from "../../src/i18n.js";
import { loadGameState } from "../../src/persistence/save-load.js";
import { CONFIG, STATE } from "../helpers/sim-world.mjs";

const button = () => document.getElementById("auto-repair-toggle");
const toasts = () => document.getElementById("intervention-warnings").textContent;

beforeEach(() => {
    i18n.setLocale("en");
    document.getElementById("intervention-warnings").innerHTML = "";
    resetGame("survival");
});

afterEach(() => {
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("the button shows auto-repair's own state", () => {
    it("reads OFF at the start of a game, and ON once pressed", () => {
        expect(button().textContent).toBe(i18n.t("auto_repair_off_msg"));

        window.toggleAutoRepair();

        expect(STATE.autoRepairEnabled).toBe(true);
        expect(button().textContent).toBe(i18n.t("auto_repair_on_msg"));
        expect(button().classList.contains("text-green-400")).toBe(true);
    });

    it("keeps its state through a language switch", () => {
        window.toggleAutoRepair();

        i18n.setLocale("de");
        expect(button().textContent.trim()).toBe(i18n.t("auto_repair_on_msg"));

        window.toggleAutoRepair();
        i18n.setLocale("uk");
        expect(button().textContent.trim()).toBe(i18n.t("auto_repair_off_msg"));
    });

    it("a new game turns it back off", () => {
        window.toggleAutoRepair();

        resetGame("survival");

        expect(button().textContent).toBe(i18n.t("auto_repair_off_msg"));
        expect(button().classList.contains("text-green-400")).toBe(false);
    });

    it("a loaded game shows the state it was saved with", () => {
        loadGameState({
            version: "2.0",
            money: 500,
            reputation: 80,
            requestsProcessed: 0,
            isRunning: false,
            autoRepairEnabled: true,
            services: [],
            connections: [],
            internetConnections: [],
        });

        expect(button().textContent).toBe(i18n.t("auto_repair_on_msg"));
        expect(button().classList.contains("text-green-400")).toBe(true);
    });
});

describe("the messages match what just happened", () => {
    it("turning it on says so, and turning it off says that instead of 'Event ended'", () => {
        window.toggleAutoRepair();
        expect(toasts()).toContain(i18n.t("auto_repair_hint"));

        document.getElementById("intervention-warnings").innerHTML = "";
        window.toggleAutoRepair();
        expect(toasts()).toContain(i18n.t("auto_repair_disabled"));
        expect(toasts()).not.toContain(i18n.t("event_ended"));
    });

    it("the hint and the tooltip describe the feature, not one of its states", () => {
        const hint = document.querySelector('#healthPanel [data-i18n="auto_repair_desc"]');
        expect(hint, "the hint under the repair table").not.toBeNull();
        expect(button().getAttribute("data-i18n-title")).toBe("auto_repair_desc");
        expect(document.querySelector('#healthPanel [data-i18n="auto_repair_hint"]')).toBeNull();
    });

    it("the rate it quotes is the rate the game charges", () => {
        const percent = CONFIG.survival.degradation.autoRepairCostPercent * 100;
        expect(i18n.t("auto_repair_desc")).toContain(`${percent}%`);
    });
});
