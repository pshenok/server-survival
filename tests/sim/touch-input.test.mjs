// The board could not be touched at all (#12) — the game bound only
// mousedown/mousemove/mouseup/wheel, and a tap's synthetic click covers menu
// buttons but never a canvas drag. Every gesture here reaches the EXACT same
// code the mouse path uses (handlePrimaryDown / handlePointerMove /
// finishNodeDrag, panByScreenDelta, setZoom) — extracted, not duplicated —
// so these tests double as regression coverage for that refactor: if a touch
// gesture and its mouse equivalent ever produce different results, one of
// the extractions above has drifted from the mouse path it was pulled from.
//
// happy-dom supports real Touch/TouchEvent construction, so these dispatch
// actual events at the canvas container — the same way placement.test.mjs
// dispatches real mousedown events, and pointer-release.test.mjs primes
// raycastHits to grab a real node — rather than calling internal functions.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { camera, cameraTarget } from "../../game.js";
import {
    isIsometric,
    orbitCamera,
    resetCamera,
    toggleView,
} from "../../src/input/handlers.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const container = () => document.getElementById("canvas-container");
const internetPos = () => ({ x: STATE.internetNode.position.x, z: STATE.internetNode.position.z });

function touch(id, x, y) {
    return new window.Touch({ identifier: id, target: container(), clientX: x, clientY: y });
}

function touchEvent(type, touches) {
    return new window.TouchEvent(type, { touches, bubbles: true, cancelable: true });
}

beforeEach(() => {
    resetRaycastHits();
    resetGame("survival");
    STATE.isRunning = true;
    STATE.money = 999999;
    STATE.activeTool = "select";
});
afterEach(resetRaycastHits);

describe("a single-finger tap places a service, exactly like a left click", () => {
    it("touchstart with one finger reaches the same placement path as mousedown", () => {
        STATE.activeTool = "waf";
        expect(STATE.services).toHaveLength(0);

        container().dispatchEvent(touchEvent("touchstart", [touch(1, 400, 300)]));

        // The three-stub raycaster resolves every hit to ground at the
        // origin regardless of clientX/Y (see three-stub.mjs), same as it
        // does for the mouse path in placement.test.mjs — this is proving
        // the touch listener reaches createService, not testing raycasting.
        expect(STATE.services).toHaveLength(1);
        expect(STATE.services[0].type).toBe("waf");
    });

    it("touchstart calls preventDefault, so the page does not scroll under a tap", () => {
        STATE.activeTool = "waf";
        const ev = touchEvent("touchstart", [touch(1, 400, 300)]);
        container().dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
    });

    it("does nothing while the game is paused, like the mouse path", () => {
        STATE.isRunning = false;
        STATE.activeTool = "waf";
        container().dispatchEvent(touchEvent("touchstart", [touch(1, 400, 300)]));
        expect(STATE.services).toHaveLength(0);
    });
});

describe("two fingers pan and zoom the camera together", () => {
    it("a two-finger drag pans — the board follows the average finger position", () => {
        const before = { x: camera.position.x, z: camera.position.z };

        container().dispatchEvent(
            touchEvent("touchstart", [touch(1, 300, 300), touch(2, 500, 300)])
        );
        // Midpoint moves from (400, 300) to (300, 300): a 100px drag left.
        container().dispatchEvent(
            touchEvent("touchmove", [touch(1, 200, 300), touch(2, 400, 300)])
        );

        expect(camera.position.x !== before.x || camera.position.z !== before.z).toBe(true);
    });

    it("a two-finger pinch zooms — fingers spreading apart zooms in", () => {
        const startZoom = camera.zoom;

        container().dispatchEvent(
            touchEvent("touchstart", [touch(1, 350, 300), touch(2, 450, 300)])
        );
        // Spacing goes from 100px to 300px: a 3x pinch-out.
        container().dispatchEvent(
            touchEvent("touchmove", [touch(1, 250, 300), touch(2, 550, 300)])
        );

        expect(camera.zoom).toBeGreaterThan(startZoom);
    });

    it("zoom stays within the same bounds the wheel is clamped to", () => {
        container().dispatchEvent(
            touchEvent("touchstart", [touch(1, 400, 300), touch(2, 401, 300)])
        );
        // A 1px starting spacing makes the ratio to any later spacing huge —
        // exactly the kind of runaway input a real pinch could produce by
        // starting with fingers nearly together.
        container().dispatchEvent(
            touchEvent("touchmove", [touch(1, 0, 300), touch(2, 800, 300)])
        );
        expect(camera.zoom).toBeLessThanOrEqual(3.0);
    });

    it("starting a pinch drops a node that a first finger had already grabbed", () => {
        // Grabs the Internet node, not a freshly-placed one: a placed service
        // sits at whatever the ground stub always resolves to (the origin),
        // so a ground-driven "drag" that lands back on the origin would look
        // identical to a drop that never happened. The Internet node starts
        // off-origin, so an unwanted resumed drag is actually observable.
        const before = internetPos();
        const cameraBefore = { x: camera.position.x, z: camera.position.z };
        grabInternetByTouch(1, 400, 300);

        // A second finger lands — this must not leave the node mid-drag.
        container().dispatchEvent(
            touchEvent("touchstart", [touch(1, 400, 300), touch(2, 500, 300)])
        );
        container().dispatchEvent(
            touchEvent("touchmove", [touch(1, 400, 500), touch(2, 500, 500)])
        );

        // The node did not follow the pan — it was dropped where it stood.
        expect(internetPos()).toEqual(before);
        // And the camera DID move — the pinch's pan half still happened, so
        // the drop is not just an accidental side effect of nothing running.
        expect(camera.position.x !== cameraBefore.x || camera.position.z !== cameraBefore.z)
            .toBe(true);

        // The real risk isn't the pan frame itself — the two-finger branch
        // never touches node position either way. It's what happens after:
        // one finger lifts, leaving a single touch that was part of a PAN.
        // If the node was never actually dropped, that surviving finger's
        // next move would resume the drag from wherever it happens to land —
        // silently reassigning what a finger controls mid-gesture.
        container().dispatchEvent(touchEvent("touchend", [touch(1, 400, 500)]));
        container().dispatchEvent(touchEvent("touchmove", [touch(1, 100, 100)]));
        expect(internetPos()).toEqual(before);
    });
});

// Fingers 200px apart (or `spread`), centred on (400, 300), their line tilted
// by `deg` degrees. Screen y grows downward, so a rising angle is a CLOCKWISE
// twist on screen.
function fingersAt(deg, spread = 200, ids = [1, 2]) {
    const rad = (deg * Math.PI) / 180;
    const dx = (Math.cos(rad) * spread) / 2;
    const dy = (Math.sin(rad) * spread) / 2;
    return [touch(ids[0], 400 - dx, 300 - dy), touch(ids[1], 400 + dx, 300 + dy)];
}

// The ground direction shown as "up" on screen: the isometric line of sight,
// or the top-down camera's up vector (see orbit-sense.test.mjs). The board
// turns on screen exactly opposite to how this direction turns in the world.
const screenUpOnGround = () =>
    isIsometric
        ? { x: cameraTarget.x - camera.position.x, z: cameraTarget.z - camera.position.z }
        : { x: camera.up.x, z: camera.up.z };

// Signed degrees the screen-up direction turned between two readings.
function turned(a, b) {
    const cross = a.x * b.z - a.z * b.x;
    const dot = a.x * b.x + a.z * b.z;
    return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function twist(from, to, opts) {
    container().dispatchEvent(touchEvent("touchstart", fingersAt(from, opts?.spread)));
    container().dispatchEvent(touchEvent("touchmove", fingersAt(to, opts?.spread)));
    container().dispatchEvent(touchEvent("touchend", []));
}

describe("twisting two fingers rotates the view, like Q and E (#314)", () => {
    afterEach(() => {
        if (!isIsometric) toggleView();
        resetCamera();
    });

    it("a clockwise twist turns the board by the same angle, the way Q does", () => {
        resetCamera();
        const before = screenUpOnGround();
        twist(0, 45);
        const byTwist = turned(before, screenUpOnGround());

        resetCamera();
        orbitCamera((-45 * Math.PI) / 180);
        const byQ = turned(before, screenUpOnGround());

        expect(Math.abs(byTwist)).toBeCloseTo(45, 4);
        expect(byTwist).toBeCloseTo(byQ, 4);
    });

    it("turns the top-down board the same way and by the same angle", () => {
        resetCamera();
        const iso0 = screenUpOnGround();
        twist(0, 45);
        const iso = turned(iso0, screenUpOnGround());

        toggleView();
        const top0 = screenUpOnGround();
        twist(0, 45);
        const top = turned(top0, screenUpOnGround());

        expect(top).toBeCloseTo(iso, 4);
    });

    it("crossing the line where the angle wraps turns the short way", () => {
        resetCamera();
        const before = screenUpOnGround();
        twist(170, 200);
        expect(Math.abs(turned(before, screenUpOnGround()))).toBeCloseTo(30, 4);
    });

    it("a wobble inside the dead zone does not rotate it, even across that line", () => {
        resetCamera();
        const before = screenUpOnGround();
        twist(0, 2);
        twist(179, 181);
        expect(turned(before, screenUpOnGround())).toBeCloseTo(0, 6);
    });

    it("every gesture starts inside the dead zone again", () => {
        resetCamera();
        twist(0, 45);
        const after = screenUpOnGround();
        twist(0, 2);
        expect(turned(after, screenUpOnGround())).toBeCloseTo(0, 6);
    });

    it("a pinch with a little drift zooms without rotating", () => {
        resetCamera();
        const zoom0 = camera.zoom;
        const before = screenUpOnGround();
        // Pinch in (earlier tests leave the zoom at its cap) with 3 degrees of
        // drift, under the dead zone.
        container().dispatchEvent(touchEvent("touchstart", fingersAt(0, 200)));
        container().dispatchEvent(touchEvent("touchmove", fingersAt(3, 120)));
        container().dispatchEvent(touchEvent("touchend", []));

        expect(camera.zoom).toBeLessThan(zoom0);
        expect(turned(before, screenUpOnGround())).toBeCloseTo(0, 6);
    });
});

describe("a two-finger move never measures against a stale baseline", () => {
    afterEach(resetCamera);

    const snapshot = () => ({
        x: camera.position.x,
        z: camera.position.z,
        zoom: camera.zoom,
        up: screenUpOnGround(),
    });
    function expectUnmoved(before) {
        expect(camera.position.x).toBeCloseTo(before.x, 6);
        expect(camera.position.z).toBeCloseTo(before.z, 6);
        expect(camera.zoom).toBeCloseTo(before.zoom, 6);
        expect(turned(before.up, screenUpOnGround())).toBeCloseTo(0, 6);
    }

    it("fingers that never had a two-finger touchstart on the board take a baseline instead of jumping", () => {
        // One finger rests on a HUD panel: its touchstart never reaches the
        // board, but the board's touchmove still carries both touches.
        resetCamera();
        twist(0, 30);
        const before = snapshot();

        container().dispatchEvent(touchEvent("touchmove", fingersAt(-90, 150)));

        expectUnmoved(before);
    });

    it("does nothing once the game is no longer running", () => {
        resetCamera();
        twist(0, 30);
        STATE.isRunning = false;
        const before = snapshot();

        // Two moves: the first would only take a baseline anyway, so it is
        // the second that shows whether a stopped game still turns the view.
        container().dispatchEvent(touchEvent("touchstart", fingersAt(-90)));
        container().dispatchEvent(touchEvent("touchmove", fingersAt(-60)));
        container().dispatchEvent(touchEvent("touchmove", fingersAt(-20, 120)));

        expectUnmoved(before);
    });

    it("when a third finger lifts, the next move is measured on the pair that remains", () => {
        resetCamera();
        const [a, b] = fingersAt(0);
        const c = touch(3, 400, 450);
        container().dispatchEvent(touchEvent("touchstart", [a, b]));
        container().dispatchEvent(touchEvent("touchstart", [a, b, c]));
        // Finger a lifts: b and c are now touches[0] and [1], a pair at a
        // different angle, spacing and midpoint from a and b.
        container().dispatchEvent(touchEvent("touchend", [b, c]));
        const before = snapshot();

        container().dispatchEvent(touchEvent("touchmove", [b, c]));

        expectUnmoved(before);
    });
});

// raycastHits (built for pointer-release.test.mjs, #288) lets the stub
// resolve a touch to a REAL service instead of always falling through to
// ground at the origin — so a drag's position can be checked directly,
// rather than only checked for not throwing.
function grabInternetByTouch(id, x, y) {
    raycastHits.internet = [{ object: STATE.internetNode.mesh }];
    container().dispatchEvent(touchEvent("touchstart", [touch(id, x, y)]));
    expect(container().style.cursor, "the drag must arm or the test proves nothing")
        .toBe("grabbing");
    resetRaycastHits();
}

describe("a single-finger drag moves a grabbed node, exactly like a mouse drag", () => {
    it("touchmove while dragging moves it — checked by position, not just by not throwing", () => {
        const before = internetPos();
        grabInternetByTouch(1, 400, 300);

        container().dispatchEvent(touchEvent("touchmove", [touch(1, 420, 320)]));
        expect(internetPos(), "the node should follow the finger while held").not.toEqual(before);
    });

    it("lifting the finger drops the node exactly where the drag left it", () => {
        grabInternetByTouch(1, 400, 300);
        container().dispatchEvent(touchEvent("touchmove", [touch(1, 420, 320)]));
        const dragging = internetPos();

        container().dispatchEvent(touchEvent("touchend", []));

        // Dropped: it stays where the drag left it, and stops following.
        container().dispatchEvent(touchEvent("touchmove", [touch(1, 200, 200)]));
        expect(internetPos()).toEqual(dragging);
        expect(container().style.cursor).toBe("default");
    });
});

describe("touchcancel gives up the grab, same as an off-canvas mouse release (#288)", () => {
    it("a cancelled touch does not leave the node following a later finger", () => {
        grabInternetByTouch(1, 400, 300);
        container().dispatchEvent(touchEvent("touchmove", [touch(1, 420, 320)]));
        const whereItWasWhenCancelled = internetPos();

        container().dispatchEvent(touchEvent("touchcancel", []));

        // A brand new touch, unrelated to the cancelled one, must not inherit
        // a live drag — the exact class of bug #288 fixed for a mouse release
        // that lands off the canvas.
        container().dispatchEvent(touchEvent("touchmove", [touch(2, 100, 100)]));
        expect(internetPos()).toEqual(whereItWasWhenCancelled);
        expect(container().style.cursor).toBe("default");
    });

    it("a run boundary lets go of a touch-held node too, via the shared endPointerInteraction", () => {
        grabInternetByTouch(1, 400, 300);
        resetGame("sandbox"); // no touchend, no touchcancel
        const before = internetPos();
        container().dispatchEvent(touchEvent("touchmove", [touch(2, 700, 400)]));
        expect(internetPos()).toEqual(before);
    });
});
