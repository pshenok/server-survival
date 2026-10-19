// Phone HUD tabs (#12). On a 375px screen the six HUD panels covered the board
// completely and overlapped each other in four pairs, and a phone held sideways
// fared no better, so on phone-sized screens style.css hides each panel until
// its tab opens it. These tests drive the real buttons
// in the real index.html (sim-setup installs it as the DOM fixture).
//
// Layout itself cannot be asserted here — happy-dom does no layout — so the
// last block pins the contract between the three places that must agree: the
// tab buttons in index.html, HUD_TABS in hud-tabs.js, and the media-query rule
// in style.css that does the hiding. A panel missing from any one of them
// either has no way to open on a phone or never closes and overlaps again.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetGame, camera, cameraTarget } from "../../game.js";
import { isIsometric } from "../../src/input/handlers.js";
import { HUD_TABS, getOpenHudTab, toggleHudTab } from "../../src/ui/hud-tabs.js";

const tabButton = (name) => document.querySelector(`[data-hud-tab="${name}"]`);
const panel = (id) => document.getElementById(id);
const openPanels = () =>
    Object.values(HUD_TABS).flat().filter((id) => panel(id).classList.contains("m-open"));

beforeEach(() => {
    resetGame("survival");
    if (getOpenHudTab()) toggleHudTab(getOpenHudTab());
});

describe("a tab opens its own panel and only that panel", () => {
    it("tapping a tab opens it and marks the button pressed", () => {
        tabButton("health").click();

        expect(openPanels()).toEqual(["healthPanel"]);
        expect(tabButton("health").getAttribute("aria-pressed")).toBe("true");
        expect(tabButton("stats").getAttribute("aria-pressed")).toBe("false");
    });

    it("tapping the open tab again closes it, leaving the board clear", () => {
        tabButton("finances").click();
        tabButton("finances").click();

        expect(openPanels()).toEqual([]);
        expect(tabButton("finances").getAttribute("aria-pressed")).toBe("false");
    });

    it("tapping another tab switches, so two panels are never open together", () => {
        tabButton("stats").click();
        tabButton("score").click();

        expect(openPanels()).toEqual(["detailsPanel"]);
        expect(getOpenHudTab()).toBe("score");
    });
});

describe("the goals tab leaves the mode's own choice of panel alone", () => {
    it("opening it never un-hides the panel the current mode has hidden", () => {
        // Sandbox shows its controls in place of the objectives panel by
        // toggling .hidden. The tab marks both open; .hidden still decides.
        panel("objectivesPanel").classList.add("hidden");
        panel("sandboxPanel").classList.remove("hidden");

        tabButton("goals").click();

        expect(panel("objectivesPanel").classList.contains("m-open")).toBe(true);
        expect(panel("sandboxPanel").classList.contains("m-open")).toBe(true);
        expect(panel("objectivesPanel").classList.contains("hidden")).toBe(true);
        expect(panel("sandboxPanel").classList.contains("hidden")).toBe(false);
    });
});

describe("the reset-view button is R for a screen with no keyboard", () => {
    it("returns a panned camera to the board's centre", () => {
        cameraTarget.set(25, 0, -18);

        document.getElementById("btn-reset-view").click();

        expect([cameraTarget.x, cameraTarget.y, cameraTarget.z]).toEqual([0, 0, 0]);
    });
});

describe("the top-down button is T for a screen with no keyboard", () => {
    const toggle = () => document.getElementById("btn-toggle-view");

    it("switches between isometric and top-down, and back again", () => {
        const before = isIsometric;

        toggle().click();
        expect(isIsometric).toBe(!before);

        toggle().click();
        expect(isIsometric).toBe(before);
    });

    it("moves the camera, not only the flag: straight down, then back to the angle", () => {
        expect(isIsometric, "starts isometric").toBe(true);

        toggle().click();
        // Top-down looks straight down from above the centre, so its up
        // vector lies flat. Isometric restores the world up vector.
        expect([camera.position.x, camera.position.z]).toEqual([0, 0]);
        expect(camera.up.y).toBe(0);

        toggle().click();
        expect(camera.up.y).toBe(1);
    });

    it("says which view is showing, whether the button or the T key switched it", () => {
        expect(toggle().getAttribute("aria-pressed")).toBe("false");

        toggle().click();
        expect(toggle().getAttribute("aria-pressed")).toBe("true");

        document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "t", bubbles: true }));
        expect(isIsometric).toBe(true);
        expect(toggle().getAttribute("aria-pressed")).toBe("false");
    });
});

describe("the two camera buttons", () => {
    const ids = ["btn-reset-view", "btn-toggle-view"];

    it("sit inside the phone tab strip, the only place the phone CSS shows them", () => {
        // .hud-tab is display:flex everywhere; only the strip is hidden on a
        // desktop. A camera button outside it would show on every screen.
        for (const id of ids) {
            expect(document.getElementById(id).closest("#hudTabs"), id).not.toBeNull();
        }
    });

    it("have different names, so a tooltip or a screen reader can tell them apart", () => {
        const keys = ids.map((id) => document.getElementById(id).getAttribute("data-i18n-title"));
        expect(new Set(keys).size).toBe(ids.length);
    });
});

const PHONE_QUERY = "@media (max-width: 767px), (max-height: 500px)";

describe("index.html, hud-tabs.js and style.css agree on the panels", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const css = readFileSync(resolve(root, "style.css"), "utf8");
    const html = readFileSync(resolve(root, "index.html"), "utf8");

    it("every tab in HUD_TABS has a button, and every button has a tab", () => {
        const buttons = [...html.matchAll(/data-hud-tab="([^"]+)"/g)].map((m) => m[1]);
        expect(buttons.sort()).toEqual(Object.keys(HUD_TABS).sort());
    });

    it("every panel a tab opens exists in index.html", () => {
        const missing = Object.values(HUD_TABS).flat().filter((id) => !panel(id));
        expect(missing).toEqual([]);
    });

    it("every panel a tab opens is hidden on a phone until opened", () => {
        const phone = css.slice(css.indexOf(PHONE_QUERY));
        expect(phone.length, "the phone media query is gone").toBeLessThan(css.length);
        const notHidden = Object.values(HUD_TABS)
            .flat()
            .filter((id) => !phone.includes(`#${id}:not(.m-open)`));
        expect(notHidden).toEqual([]);
    });

    it("the tab strip is hidden outside the phone query, so desktop never sees it", () => {
        const desktop = css.slice(0, css.indexOf(PHONE_QUERY));
        expect(desktop).toMatch(/\.hud-tabs\s*\{\s*display:\s*none;/);
    });

    it("on a phone the strip is capped to the screen and scrolls inside itself", () => {
        // Uncapped, a row of 40px tabs outgrew a 320px phone at seven buttons
        // and a 360px one at eight, and pushed the whole page into sideways
        // scroll. A rule, not a measured width: happy-dom does no layout.
        const phone = css.slice(css.indexOf(PHONE_QUERY));
        const strip = phone.match(/\.hud-tabs\s*\{([^}]*)\}/)?.[1] ?? "";
        expect(strip).toMatch(/max-width:\s*calc\(100vw\s*-[^;]+\);/);
        expect(strip).toMatch(/overflow-x:\s*auto;/);
    });
});
