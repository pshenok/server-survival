// The pointer can be released anywhere, and this game only listened on the
// canvas.
//
// isDraggingNode, draggedNode, isPanning and isOrbiting are module-scope lets
// in src/input/handlers.js, armed on the container's mousedown and cleared
// only in the container's mouseup. The HUD panels are pointer-events-auto
// SIBLINGS of the canvas, and a release outside the window delivers no
// mouseup to the container at all — so letting go anywhere but the board left
// the grab live with nothing holding it.
//
// resetGame did not clear them either, so the grab crossed the run boundary:
// drag the Internet node, release over the Finances panel, start a different
// run, and the node teleported on the first mouse MOVE with nobody clicking.
//
// These tests exist because the THREE stub's raycaster became primeable. It
// returned nothing unconditionally before, with a comment saying tests never
// raycast — which meant the entire input layer (dragging, selecting,
// connecting, deleting) could not be reached from a test at all.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const container = () => document.getElementById("canvas-container");
const at = (target, type, x, y) => target.dispatchEvent(
    new globalThis.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
);
const pos = () => ({ x: STATE.internetNode.position.x, z: STATE.internetNode.position.z });
const offCanvas = () => document.getElementById("failures-panel") || document.body;

function grabInternet() {
    STATE.activeTool = "select";
    raycastHits.internet = [{ object: STATE.internetNode.mesh }];
    at(container(), "mousedown", 100, 100);
    expect(container().style.cursor, "the drag must arm or the test proves nothing")
        .toBe("grabbing");
    resetRaycastHits();
}

describe("a grab ends wherever the button is released", () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* storage unavailable */ }
        resetRaycastHits();
        resetGame("survival");
    });
    afterEach(resetRaycastHits);

    it("THE TELEPORT: released over a HUD panel, then a new run", () => {
        grabInternet();
        at(offCanvas(), "mouseup", 500, 500);

        resetGame("survival");
        const before = pos();
        at(container(), "mousemove", 700, 400);
        expect(pos(), "the node moved with nobody holding it").toEqual(before);
    });

    it("...and within the same run, the release alone is enough", () => {
        grabInternet();
        at(offCanvas(), "mouseup", 500, 500);
        const before = pos();
        at(container(), "mousemove", 700, 400);
        expect(pos()).toEqual(before);
        expect(container().style.cursor).toBe("default");
    });

    it("a drag released ON the canvas still works — the normal path is untouched", () => {
        const before = pos();
        grabInternet();
        at(container(), "mousemove", 700, 400);
        expect(pos(), "the node should follow the cursor while held").not.toEqual(before);
        at(container(), "mouseup", 700, 400);
        // Dropped: it stays where it was put, and stops following.
        const dropped = pos();
        at(container(), "mousemove", 200, 200);
        expect(pos()).toEqual(dropped);
    });

    it("a run boundary lets go too, even with no release and no blur", () => {
        // The window listener covers every release that actually happens and
        // blur covers the one that does not, so this is the last resort: a
        // grab still live when the world is torn down. Cheap, and this
        // codebase has now shipped six separate bugs that were exactly some
        // flag outliving the run that set it.
        grabInternet();
        resetGame("sandbox");                 // no mouseup, no blur
        const before = pos();
        at(container(), "mousemove", 700, 400);
        expect(pos()).toEqual(before);
        expect(container().style.cursor).toBe("default");
    });

    it("losing the window mid-drag ends it too — no mouseup is ever delivered", () => {
        grabInternet();
        globalThis.window.dispatchEvent(new globalThis.Event("blur"));
        const before = pos();
        at(container(), "mousemove", 700, 400);
        expect(pos()).toEqual(before);
    });
});
