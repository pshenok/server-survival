// The tutorial spotlights buttons by id, and the palette only renders the
// ACTIVE category's buttons.
//
// On a fresh profile the active tab is the first category, "frontdoor". Three
// of the seven spotlight steps name buttons that live elsewhere — tool-lambda
// in "compute", tool-s3 and tool-db in "data" — so getElementById returned
// null and highlightElement returned without a word.
//
// Steps 3 to 6 worked, and then the ring simply stopped appearing while the
// text kept naming a button. Step 7 gates progress on place_compute: the Next
// button stays hidden until a Compute is placed, and the button to place it
// with was not on screen. A brand-new player — window.startGame runs this on
// every survival start — was told to place a Compute and shown nothing to
// place it from.
//
// The toolbar already exported isTypeAllowed for the tutorial, so that a
// campaign level forbidding a service "must not hand the player an
// instruction they physically cannot follow". This is the same rule one step
// earlier: an instruction pointing at a hidden tab cannot be followed either.
import { describe, it, expect, beforeEach } from "vitest";
import { resetGame } from "../../game.js";
import { SERVICE_BUTTONS, SERVICE_CATEGORIES, categoryForTool, setToolbarCategory }
    from "../../src/ui/toolbar.js";

// Every id the tutorial aims its ring at, read from the source rather than
// retyped — a copy here would go stale the first time a step is edited.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// From the project root: import.meta.url is not a file: URL under the sim
// tier's happy-dom environment, and vitest runs from the root either way.
const SOURCE = readFileSync(join(process.cwd(), "src/tutorial.js"), "utf8");
const TARGETS = [...new Set(
    [...SOURCE.matchAll(/highlight:\s*'([^']+)'/g)].map((m) => m[1])
)];

describe("the tutorial's spotlight lands on something", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* storage unavailable */ }
        resetGame("survival");
    });

    it("the steps really do name buttons — the regex above still finds them", () => {
        expect(TARGETS.length).toBeGreaterThan(4);
        expect(TARGETS).toContain("tool-lambda");
    });

    it("EVERY target is reachable: the ring can be shown on all of them", () => {
        const unreachable = [];
        for (const id of TARGETS) {
            window.tutorial.highlightElement(id);
            if (!document.getElementById(id)) unreachable.push(id);
        }
        expect(unreachable, "the spotlight aimed at a button that does not exist").toEqual([]);
    });

    it("THE THREE THAT MISSED: they are on other tabs and the ring finds them anyway", () => {
        // Named explicitly, because "all targets pass" would also pass if
        // someone moved every service onto one tab.
        for (const id of ["tool-lambda", "tool-s3", "tool-db"]) {
            setToolbarCategory(SERVICE_CATEGORIES[0].id);          // back to frontdoor
            expect(document.getElementById(id), `${id} is meant to start hidden`).toBeNull();
            window.tutorial.highlightElement(id);
            expect(document.getElementById(id), `${id} was still not on screen`).not.toBeNull();
        }
    });

    it("...and the tab STAYS, because the player has to click that button next", () => {
        setToolbarCategory(SERVICE_CATEGORIES[0].id);
        window.tutorial.highlightElement("tool-db");
        // A re-render must not put the old tab back under them.
        setToolbarCategory(categoryForTool("tool-db"));
        expect(document.getElementById("tool-db")).not.toBeNull();
    });

    it("categoryForTool resolves Compute's historical id, not just the plain ones", () => {
        // The button is id="tool-lambda" for a service whose config type is
        // "compute". A second lookup table would have drifted; this reads the
        // same alias the ids are generated from.
        expect(SERVICE_BUTTONS.compute?.tool).toBe("lambda");
        expect(categoryForTool("tool-lambda")).toBe("compute");
        expect(categoryForTool("tool-db")).toBe("data");
        expect(categoryForTool("tool-connect")).toBeNull();   // not a service button
    });
});
