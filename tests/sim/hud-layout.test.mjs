// The desktop HUD is two columns, and the event banner pushes it down.
//
// The panels used to be pinned at fixed offsets with no idea of each other, of
// the screen's height or of the toolbar. Measured in a real browser on a
// survival run 30 seconds in: Finances ended 313px below the bottom of a
// 1920x1080 screen with nothing to scroll it; at 1366x768 the toolbar covered
// the objectives and the metrics panel; at 1280x720 the objectives sat on top
// of the stats; at 1024 wide the stats ran under the time controls; and an
// event banner covered the top of the time controls.
//
// happy-dom does no layout, so the geometry was checked in the browser at ten
// sizes from 375x812 to 1920x1080 (no overlaps, nothing off-screen, columns
// scroll where they must). What this file holds is the contract that geometry
// rests on: which panels live in which column, that none of them carries its
// own pinned position any more, the column rules, and the banner offset.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetGame } from "../../game.js";
import { endRandomEvent, triggerRandomEvent } from "../../src/core/events.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(resolve(root, "style.css"), "utf8");
const PHONE_QUERY = "@media (max-width: 767px), (max-height: 500px)";
const desktopCss = css.slice(0, css.indexOf(PHONE_QUERY));
const rule = (selector) => {
    const m = desktopCss.match(new RegExp(`${selector.replace(/[.#]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : "";
};

const LEFT = ["statsPanel", "sandboxPanel", "objectivesPanel"];
const RIGHT = ["detailsPanel", "healthPanel", "metricsPanel", "financesPanel"];

describe("each panel lives in its column", () => {
    it("stats, sandbox and objectives are in the left column; the rest in the right", () => {
        for (const id of LEFT) expect(document.getElementById(id).parentElement.id, id).toBe("hudLeft");
        for (const id of RIGHT) expect(document.getElementById(id).parentElement.id, id).toBe("hudRight");
        for (const id of ["hudLeft", "hudRight"]) {
            expect(document.getElementById(id).parentElement.id, id).toBe("hudRoot");
        }
    });

    it("no panel pins its own position, which would take it out of its column", () => {
        const pinned = /(^|\s)(absolute|fixed|top-\S+|bottom-\S+|left-\S+|right-\S+)(\s|$)/;
        const offenders = [...LEFT, ...RIGHT].filter((id) =>
            pinned.test(document.getElementById(id).className)
        );
        expect(offenders).toEqual([]);
    });
});

describe("the columns stop above the toolbar and scroll what does not fit", () => {
    it("a column has a top and a bottom, and scrolls inside them", () => {
        const col = rule(".hud-col");
        expect(col).toMatch(/top:\s*calc\(1rem \+ var\(--hud-top\)\);/);
        expect(col).toMatch(/bottom:\s*var\(--hud-bottom\);/);
        expect(col).toMatch(/overflow-y:\s*auto;/);
    });

    it("the bottom reserve is the toolbar's band, released only where the toolbar clears both columns", () => {
        expect(rule(":root")).toMatch(/--hud-bottom:\s*8\.75rem;/);
        expect(desktopCss).toMatch(/@media \(min-width: 1680px\)\s*\{\s*:root\s*\{\s*--hud-bottom:\s*1rem;/);
    });

    it("the objectives keep their place at the foot of the left column", () => {
        expect(desktopCss).toMatch(/#sandboxPanel,\s*#objectivesPanel\s*\{\s*margin-top:\s*auto;/);
    });
});

describe("an event banner pushes the HUD down instead of covering it", () => {
    afterEach(() => resetGame("survival"));

    it("the time controls and the warnings follow --hud-top", () => {
        expect(rule("#timeControls")).toMatch(/top:\s*calc\(1rem \+ var\(--hud-top\)\);/);
        expect(rule("#intervention-warnings")).toMatch(/var\(--hud-top\)/);
        expect(rule("body.event-active")).toMatch(/--hud-top:\s*2rem;/);
    });

    it("starting an event sets the offset and ending it clears it", () => {
        resetGame("survival");
        expect(document.body.classList.contains("event-active")).toBe(false);

        triggerRandomEvent("COST_SPIKE");
        expect(document.body.classList.contains("event-active")).toBe(true);

        endRandomEvent();
        expect(document.body.classList.contains("event-active")).toBe(false);
    });

    it("a new game started mid-event clears it too", () => {
        resetGame("survival");
        triggerRandomEvent("TRAFFIC_BURST");

        resetGame("sandbox");

        expect(document.body.classList.contains("event-active")).toBe(false);
    });
});
