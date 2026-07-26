// Service palette with category tabs (#155 PR 10 tier 2 — the module renders
// into the real index.html fixture and its campaign path reaches game.js).
//
// The load-bearing test is the completeness invariant: a placeable service
// that nobody categorised would be unreachable in the UI while every other
// test in the suite kept passing. The rest guard the seams the tabs
// introduced — campaign gating outliving a re-render, the settings cluster
// that moved to the far edge, and the digit shortcuts.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/config.js";
import { STATE } from "../../src/state.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import {
    SERVICE_BUTTONS,
    SERVICE_CATEGORIES,
    applyToolbarGating,
    renderToolbar,
    setToolbarCategory,
} from "../../src/ui/toolbar.js";
import { applyCampaignToolbarGating } from "../../src/ui/campaign-ui.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
// game.js owns window.setTool / window.toggleMusic / window.toggleSfx and
// registers the document-level key handlers via src/input/handlers.js.
import { resetGame } from "../../game.js";

const palette = () => document.getElementById("service-palette");
const tabs = () => document.getElementById("service-tabs");
const buttonIds = () => [...palette().querySelectorAll("button")].map((b) => b.id);
const tab = (id) => document.getElementById(`toolbar-tab-${id}`);

// Every placeable type: CONFIG.services is the single source of truth.
const PLACEABLE = Object.keys(CONFIG.services);

beforeEach(() => {
    applyToolbarGating([], []); // drop any campaign gate a previous test set
    STATE.activeTool = "select";
    setToolbarCategory(SERVICE_CATEGORIES[0].id);
});

describe("completeness invariant", () => {
    it("puts every placeable service in exactly one category", () => {
        const counts = new Map(PLACEABLE.map((t) => [t, 0]));
        for (const cat of SERVICE_CATEGORIES) {
            for (const type of cat.types) counts.set(type, (counts.get(type) || 0) + 1);
        }
        const wrong = [...counts].filter(([, n]) => n !== 1).map(([t, n]) => `${t}: ${n}`);
        expect(wrong).toEqual([]);
    });

    it("categorises nothing that is not a placeable service", () => {
        const unknown = SERVICE_CATEGORIES.flatMap((c) => c.types).filter(
            (t) => !(t in CONFIG.services)
        );
        expect(unknown).toEqual([]);
    });

    it("has button data for every categorised type and nothing more", () => {
        const categorised = SERVICE_CATEGORIES.flatMap((c) => c.types).sort();
        expect(Object.keys(SERVICE_BUTTONS).sort()).toEqual(categorised);
    });

    it("resolves every label key it references in the en dictionary", () => {
        const keys = [
            ...SERVICE_CATEGORIES.map((c) => c.labelKey),
            ...Object.values(SERVICE_BUTTONS).map((b) => b.key),
        ];
        expect(keys.filter((k) => !(k in EN_TRANSLATIONS))).toEqual([]);
    });
});

describe("rendering", () => {
    it("renders only the active category's buttons", () => {
        setToolbarCategory("compute");
        expect(buttonIds()).toEqual(["tool-lambda", "tool-serverless", "tool-container"]);
        expect(document.getElementById("tool-db")).toBeNull();
    });

    it("keeps the button contract campaign gating and tooltips rely on", () => {
        setToolbarCategory("data");
        const btn = document.getElementById("tool-s3");
        expect(btn.className).toContain("service-btn");
        expect(btn.getAttribute("onclick")).toBe("setTool('s3')");
        expect(btn.querySelector("[data-i18n]").getAttribute("data-i18n")).toBe("storage_short");
    });

    it("reads each cost badge from CONFIG so the two cannot drift", () => {
        setToolbarCategory("data");
        for (const type of SERVICE_CATEGORIES.find((c) => c.id === "data").types) {
            const btn = document.getElementById(`tool-${type}`);
            expect(btn.textContent).toContain(`$${CONFIG.services[type].cost}`);
        }
    });

    it("re-renders idempotently — no duplicated buttons", () => {
        setToolbarCategory("async");
        const first = buttonIds();
        renderToolbar();
        renderToolbar();
        expect(buttonIds()).toEqual(first);
        expect(tabs().querySelectorAll("button")).toHaveLength(SERVICE_CATEGORIES.length);
        expect(document.querySelectorAll("#tool-sqs")).toHaveLength(1);
    });

    it("keeps the selected tool highlighted when its tab comes back", () => {
        STATE.activeTool = "dlq";
        setToolbarCategory("async");
        expect(document.getElementById("tool-dlq").classList.contains("active")).toBe(true);
        setToolbarCategory("ops");
        expect(document.getElementById("tool-dlq")).toBeNull();
        setToolbarCategory("async");
        expect(document.getElementById("tool-dlq").classList.contains("active")).toBe(true);
    });

    it("marks the active tab and switches on click", () => {
        expect(tab("frontdoor").className).toContain("bg-cyan-900/60");
        tab("data").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        expect(buttonIds()).toContain("tool-db");
        expect(tab("data").className).toContain("bg-cyan-900/60");
        expect(tab("frontdoor").className).not.toContain("bg-cyan-900/60");
    });

    it("remembers the active tab in localStorage", () => {
        setToolbarCategory("ops");
        expect(localStorage.getItem("serverSurvivalToolbarCategory")).toBe("ops");
    });

    it("re-wires the hover tooltip on buttons rendered after startup", () => {
        setToolbarCategory("data");
        const tooltip = document.getElementById("tooltip");
        tooltip.style.display = "none";
        document.getElementById("tool-warehouse").dispatchEvent(
            new window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 200 })
        );
        expect(tooltip.style.display).toBe("block");
        expect(tooltip.innerHTML).toContain(`$${CONFIG.services.warehouse.cost}`);
    });

    it("dispatches toolbarRendered so the tooltip wiring can follow", () => {
        let seen = 0;
        const onRender = () => seen++;
        window.addEventListener("toolbarRendered", onRender);
        setToolbarCategory("ops");
        window.removeEventListener("toolbarRendered", onRender);
        expect(seen).toBe(1);
    });
});

describe("campaign gating", () => {
    it("lands on a tab that holds one of the level's services", () => {
        setToolbarCategory("frontdoor");
        applyToolbarGating(["s3"], []);
        expect(buttonIds()).toContain("tool-s3");
        expect(tab("data").className).toContain("bg-cyan-900/60");
    });

    it("greys out everything the level forbids on that tab", () => {
        applyToolbarGating(["s3"], []);
        const allowed = document.getElementById("tool-s3");
        const blocked = document.getElementById("tool-db");
        expect(allowed.classList.contains("pointer-events-none")).toBe(false);
        expect(blocked.classList.contains("opacity-30")).toBe(true);
        expect(blocked.getAttribute("data-campaign-blocked")).toBe("true");
    });

    it("keeps the gate after a tab switch — fresh buttons are not enabled", () => {
        applyToolbarGating(["s3"], []);
        setToolbarCategory("frontdoor");
        const frontdoor = SERVICE_CATEGORIES.find((c) => c.id === "frontdoor");
        for (const type of frontdoor.types) {
            const btn = document.getElementById(`tool-${type}`);
            expect(btn.getAttribute("data-campaign-blocked")).toBe("true");
        }
    });

    it("paints a gate that was set while the palette was empty (render order)", () => {
        applyToolbarGating(["s3"], []);
        palette().innerHTML = ""; // as if the level started before the first render
        renderToolbar();
        expect(document.getElementById("tool-db").getAttribute("data-campaign-blocked")).toBe("true");
        expect(document.getElementById("tool-s3").getAttribute("data-campaign-blocked")).toBeNull();
    });

    it("counts the level's services on each tab", () => {
        applyToolbarGating(["s3"], []);
        expect(tab("data").textContent).toContain("· 1");
        expect(tab("frontdoor").textContent).toContain("· 0");
    });

    it("shows no counts and blocks nothing without a gate", () => {
        applyToolbarGating(["s3"], []);
        applyToolbarGating([], []);
        setToolbarCategory("data");
        expect(tab("data").textContent).not.toContain("·");
        expect(document.getElementById("tool-db").getAttribute("data-campaign-blocked")).toBeNull();
    });

    // Leaving a level used to keep its gate forever: play campaign level 2,
    // go back to sandbox, and most of the toolbar stayed dead. Reproduced on
    // the pre-toolbar build too, so this pins an old bug, not a new one.
    // resetGame() drops the gate for every non-campaign mode.
    it("drops the gate when a non-campaign mode starts", () => {
        applyToolbarGating(["s3"], []);
        setToolbarCategory("data");
        expect(document.getElementById("tool-db").getAttribute("data-campaign-blocked")).toBe("true");

        resetGame("sandbox");

        setToolbarCategory("data");
        expect(document.getElementById("tool-db").getAttribute("data-campaign-blocked")).toBeNull();
        expect(document.getElementById("tool-db").className).not.toContain("pointer-events-none");
        expect(tab("data").textContent).not.toContain("·");
    });

    it("honours a forbidden list when the level allows everything else", () => {
        applyToolbarGating([], ["db"]);
        setToolbarCategory("data");
        expect(document.getElementById("tool-db").classList.contains("opacity-30")).toBe(true);
        expect(document.getElementById("tool-s3").classList.contains("opacity-30")).toBe(false);
    });

    it("treats the compute service and its 'lambda' tool name as one", () => {
        applyToolbarGating(["compute"], []);
        expect(tab("compute").className).toContain("bg-cyan-900/60");
        expect(document.getElementById("tool-lambda").classList.contains("opacity-30")).toBe(false);
        expect(document.getElementById("tool-serverless").classList.contains("opacity-30")).toBe(true);
    });

    it("drives the same behaviour through applyCampaignToolbarGating (level 2)", () => {
        const level2 = CAMPAIGN_LEVELS.find((l) => l.id === 2);
        expect(level2.allowedServices).toEqual(["s3"]);
        setToolbarCategory("async");
        applyCampaignToolbarGating(level2.allowedServices, level2.forbiddenServices);
        expect(tab("data").className).toContain("bg-cyan-900/60");
        expect(tab("data").textContent).toContain("· 1");
        expect(document.getElementById("tool-s3").classList.contains("opacity-30")).toBe(false);
        expect(document.getElementById("tool-cache").classList.contains("opacity-30")).toBe(true);
    });

    it("does not overwrite the remembered tab when a level moves the player", () => {
        setToolbarCategory("async");
        applyToolbarGating(["s3"], []);
        expect(localStorage.getItem("serverSurvivalToolbarCategory")).toBe("async");
    });
});

describe("settings cluster", () => {
    it("still holds help, music and sfx wired to their handlers", () => {
        expect(document.getElementById("tool-help").getAttribute("onclick")).toBe("showFAQ()");
        expect(document.getElementById("tool-music").getAttribute("onclick")).toBe("toggleMusic()");
        expect(document.getElementById("tool-sfx").getAttribute("onclick")).toBe("toggleSfx()");
    });

    it("drives toggleMusic / toggleSfx and repaints the buttons", () => {
        const music = document.getElementById("tool-music");
        const before = STATE.sound.musicMuted;
        window.toggleMusic();
        expect(STATE.sound.musicMuted).toBe(!before);
        expect(music.classList.contains("bg-red-900")).toBe(STATE.sound.musicMuted);
        window.toggleMusic();
        expect(STATE.sound.musicMuted).toBe(before);

        const sfxBefore = STATE.sound.sfxMuted;
        window.toggleSfx();
        expect(STATE.sound.sfxMuted).toBe(!sfxBefore);
        window.toggleSfx();
    });
});

describe("keyboard shortcuts", () => {
    it("switches categories on keys 1-5", () => {
        for (let i = 0; i < SERVICE_CATEGORIES.length; i++) {
            document.dispatchEvent(
                new window.KeyboardEvent("keydown", { key: String(i + 1), bubbles: true })
            );
            expect(tab(SERVICE_CATEGORIES[i].id).className).toContain("bg-cyan-900/60");
        }
    });

    it("ignores digits typed into a form field", () => {
        setToolbarCategory("ops");
        const input = document.getElementById("sandbox-budget") || document.createElement("input");
        document.body.appendChild(input);
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "1", bubbles: true }));
        expect(tab("ops").className).toContain("bg-cyan-900/60");
    });

    it("ignores digits pressed with a modifier (browser tab switching)", () => {
        setToolbarCategory("ops");
        document.dispatchEvent(
            new window.KeyboardEvent("keydown", { key: "2", metaKey: true, bubbles: true })
        );
        expect(tab("ops").className).toContain("bg-cyan-900/60");
    });
});
