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
import { resetGame, cameraTarget } from "../../game.js";
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
  it("switches between isometric and top-down, and back again", () => {
    const before = isIsometric;

    document.getElementById("btn-toggle-view").click();
    expect(isIsometric).toBe(!before);

    document.getElementById("btn-toggle-view").click();
    expect(isIsometric).toBe(before);
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
});
