// The board has to be on screen, whatever shape the screen is (#12).
//
// The camera is orthographic, and its two half-extents must keep the viewport's
// own aspect or the world shears. Only one of them is therefore free to choose,
// and the original code chose the vertical one: half-height fixed at d, half-
// width derived as d * aspect. That reads correctly on a landscape monitor and
// inverts on a phone held upright, where aspect is well under 1 and the derived
// half-width collapses.
//
// Measured on the reported viewport, 375x812: the old formula showed 46 world
// units of a 120-unit grid sideways while still showing 100 top to bottom, so
// the board arrived as a strip in a field of empty grid.
//
// The fix floors the HORIZONTAL half-extent and derives the vertical. Landscape
// is untouched by construction, and the first describe below is what proves it:
// every viewport at or above a square recomputes the exact numbers it always had.
import { describe, it, expect, afterAll } from "vitest";
import { applyCameraFrustum, camera, d } from "../../game.js";

const REAL = { w: globalThis.window.innerWidth, h: globalThis.window.innerHeight };

function frustumAt(width, height) {
    Object.defineProperty(globalThis.window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(globalThis.window, "innerHeight", { value: height, configurable: true });
    applyCameraFrustum();
    return {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        worldWidth: camera.right - camera.left,
        worldHeight: camera.top - camera.bottom,
    };
}

/** What the code did before the fix, kept here so "unchanged" is a comparison. */
function originalFormula(width, height) {
    const aspect = width / height;
    return { left: -d * aspect, right: d * aspect, top: d, bottom: -d };
}

afterAll(() => {
    frustumAt(REAL.w, REAL.h);
});

describe("landscape is byte-identical to the formula it replaced", () => {
    // The whole safety argument for this change: nothing at or above a square
    // viewport moves at all, so no desktop player sees a different board.
    for (const [w, h, label] of [
        [1920, 1080, "1080p"],
        [1440, 900, "laptop"],
        [1280, 800, "the calibration size used across this repo"],
        [1024, 768, "4:3"],
        [900, 900, "square, the exact boundary of 'landscape'"],
    ]) {
        it(`${w}x${h} — ${label}`, () => {
            const now = frustumAt(w, h);
            const before = originalFormula(w, h);
            expect(now.left).toBeCloseTo(before.left, 9);
            expect(now.right).toBeCloseTo(before.right, 9);
            expect(now.top).toBeCloseTo(before.top, 9);
            expect(now.bottom).toBeCloseTo(before.bottom, 9);
        });
    }
});

describe("portrait gets the board back", () => {
    it("375x812 shows most of the grid sideways instead of a third of it", () => {
        const now = frustumAt(375, 812);
        const before = originalFormula(375, 812);
        // Measured: 46 world units before, 90 after, against a 120-unit grid.
        expect(before.right - before.left).toBeLessThan(50);
        expect(now.worldWidth).toBeGreaterThan(85);
        // And it is genuinely wider than it was, which is the point.
        expect(now.worldWidth).toBeGreaterThan((before.right - before.left) * 1.8);
    });

    it("a narrower phone gets the same horizontal reach, not a smaller one", () => {
        // The floor is on the horizontal extent precisely so that a narrower
        // screen does not show LESS board — it shows the same width and more
        // height. Under the old formula 320x900 was worse than 375x812.
        const narrow = frustumAt(320, 900);
        const wider = frustumAt(375, 812);
        expect(narrow.worldWidth).toBeCloseTo(wider.worldWidth, 9);
        expect(narrow.worldHeight).toBeGreaterThan(wider.worldHeight);
    });
});

describe("the world never shears", () => {
    // The invariant that outranks both of the above: world units must stay
    // square, or a service placed at a snapped grid point renders off its tile
    // and every hit-test drifts with it.
    for (const [w, h] of [
        [1920, 1080], [1280, 800], [1000, 1000], [812, 375],
        [768, 1024], [375, 812], [320, 900], [280, 1000],
    ]) {
        it(`${w}x${h}`, () => {
            const f = frustumAt(w, h);
            expect(f.worldWidth / f.worldHeight).toBeCloseTo(w / h, 9);
        });
    }
});

describe("the floor engages exactly where it should and nowhere else", () => {
    it("hands over to the original formula at aspect 0.9", () => {
        // d = 50 and the floor is 45, so d * aspect crosses the floor at 0.9.
        // Just above it the original formula wins; just below, the floor does.
        const above = frustumAt(901, 1000); // aspect 0.901
        expect(above.right).toBeCloseTo(d * 0.901, 6);

        const below = frustumAt(899, 1000); // aspect 0.899
        expect(below.right).toBeGreaterThan(d * 0.899);
        expect(below.right).toBeCloseTo(45, 6);
    });

    it("a landscape viewport never hits the floor", () => {
        for (const [w, h] of [[1920, 1080], [1280, 800], [1024, 768], [1000, 1000]]) {
            const f = frustumAt(w, h);
            expect(f.right, `${w}x${h}`).toBeGreaterThan(45);
        }
    });
});
