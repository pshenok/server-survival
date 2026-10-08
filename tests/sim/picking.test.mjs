// What a click picks.
//
// The three-stub raycaster returns whatever a test primes it with, so no other
// test can show a click landing on the WRONG object. Here the game's own
// raycaster gets a top-down picker that follows three r128's rules:
//   - intersectObjects(objects, true) walks every descendant and calls
//     object.raycast() after a layers test only. r128 never looks at .visible.
//   - an own .raycast override replaces Mesh.raycast, as in the library.
//   - a RingGeometry is hit on its annulus, a BoxGeometry on its footprint.
// Everything after the pick is the real game path: the mousedown listener,
// getIntersect(), handlePrimaryDown(), createService / upgrade / deleteObject.
//
// Why it exists: #313 added a hidden Link-target ring (radius 3.0 to 3.35) to
// every service. Raycasting ignores .visible, and that annulus lies wholly on
// the neighbouring tile, so a click there picked the service. Checked against
// the real library in the browser before the fix: with the Compute tool armed,
// a click 3.2 units from a Compute raycast to "linkTargetRing visible=false"
// and upgraded the Compute to tier 2 for $100 instead of placing a new one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame, raycaster } from "../../game.js";
import { createService } from "../../src/sim/topology.js";
import { showLinkTargets } from "../../src/ui/link-feedback.js";
import { CONFIG } from "../../src/config.js";
import { applyToolbarGating, setToolbarCategory } from "../../src/ui/toolbar.js";

const T = globalThis.THREE;
const saved = {};
const CAMERA_Y = 100;
let pointer = null; // world XZ point under the cursor
let lastHit = null;

function worldPos(obj) {
    let x = 0, y = 0, z = 0;
    for (let o = obj; o; o = o.parent) {
        x += o.position.x;
        y += o.position.y;
        z += o.position.z;
    }
    return { x, y, z };
}

// r128 Mesh.raycast, reduced to a vertical ray at `pointer`.
function meshRaycast(obj, hits) {
    const p = obj.geometry && obj.geometry.parameters;
    if (!p) return;
    const w = worldPos(obj);
    const dx = pointer.x - w.x;
    const dz = pointer.z - w.z;
    if (p.kind === "ring") {
        const r = Math.hypot(dx, dz);
        if (r >= p.innerRadius && r <= p.outerRadius) hits.push({ distance: CAMERA_Y - w.y, object: obj });
    } else if (p.kind === "box") {
        if (Math.abs(dx) <= p.width / 2 && Math.abs(dz) <= p.depth / 2)
            hits.push({ distance: CAMERA_Y - (w.y + p.height / 2), object: obj });
    }
}

// r128 intersectObject(): raycast, then children when recursive. No
// visibility check, exactly like the library.
function intersectObject(obj, hits, recursive) {
    if (Object.prototype.hasOwnProperty.call(obj, "raycast")) obj.raycast(raycaster, hits);
    else meshRaycast(obj, hits);
    if (recursive) for (const c of obj.children) intersectObject(c, hits, true);
}

function describeHit(obj) {
    for (const s of STATE.services) {
        if (obj === s.mesh) return `${s.type} body`;
        if (obj === s.linkTargetRing) return `${s.type} linkTargetRing (visible=${obj.visible})`;
        if (obj === s.loadRing) return `${s.type} loadRing`;
        if (s.mesh.children.includes(obj)) return `${s.type} child`;
    }
    return "other";
}

beforeAll(() => {
    saved.Ring = T.RingGeometry;
    saved.Box = T.BoxGeometry;
    saved.intersectObjects = raycaster.intersectObjects;
    saved.intersectObject = raycaster.intersectObject;
    saved.intersectPlane = raycaster.ray.intersectPlane;
    T.RingGeometry = class extends saved.Ring {
        constructor(innerRadius = 0.5, outerRadius = 1) {
            super();
            this.parameters = { kind: "ring", innerRadius, outerRadius };
        }
    };
    T.BoxGeometry = class extends saved.Box {
        constructor(width = 1, height = 1, depth = 1) {
            super();
            this.parameters = { kind: "box", width, height, depth };
        }
    };
    raycaster.intersectObjects = (objects, recursive = false) => {
        const hits = [];
        for (const o of objects) intersectObject(o, hits, recursive);
        hits.sort((a, b) => a.distance - b.distance);
        // Described now, before the click's side effects (a delete) run.
        lastHit = hits[0] ? describeHit(hits[0].object) : null;
        return hits;
    };
    raycaster.intersectObject = (obj, recursive = false) => {
        const hits = [];
        intersectObject(obj, hits, recursive);
        return hits.sort((a, b) => a.distance - b.distance);
    };
    raycaster.ray.intersectPlane = (_plane, target) => target.set(pointer.x, 0, pointer.z);
});

afterAll(() => {
    T.RingGeometry = saved.Ring;
    T.BoxGeometry = saved.Box;
    raycaster.intersectObjects = saved.intersectObjects;
    raycaster.intersectObject = saved.intersectObject;
    raycaster.ray.intersectPlane = saved.intersectPlane;
});

const container = () => document.getElementById("canvas-container");

function clickWorld(x, z) {
    pointer = { x, z };
    lastHit = null;
    container().dispatchEvent(
        new globalThis.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })
    );
    return lastHit || "nothing (ground)";
}

beforeEach(() => {
    resetGame("survival");
    applyToolbarGating(null, null);
    STATE.isRunning = true;
    STATE.money = 10000;
});

// The empty tile at (4,0,0) sits beside a Compute at the origin. The click
// lands 0.8 from that tile's centre, toward the Compute: well inside the empty
// tile (half-width 2), 3.2 from the Compute, where only the Link ring reaches.
const CLICK_X = 3.2;

describe("a click on the empty tile beside a service reaches that tile", () => {
    it("the Compute tool places a new Compute there, not an upgrade of the neighbour", () => {
        createService("compute", new T.Vector3(0, 0, 0));
        const original = STATE.services[0];
        setToolbarCategory("compute");
        window.setTool("lambda");
        showLinkTargets();
        const moneyBefore = STATE.money;

        const hit = clickWorld(CLICK_X, 0);

        expect({
            pickedBy: hit,
            services: STATE.services.map((s) => `${s.type}@${s.position.x},${s.position.z}`),
            originalTier: original.tier,
            spent: moneyBefore - STATE.money,
        }).toEqual({
            pickedBy: "nothing (ground)",
            services: ["compute@0,0", "compute@4,0"],
            originalTier: 1,
            spent: CONFIG.services.compute.cost,
        });
    });

    it("the Delete tool demolishes nothing", () => {
        createService("compute", new T.Vector3(0, 0, 0));
        window.setTool("delete");
        showLinkTargets();

        const hit = clickWorld(CLICK_X, 0);

        expect({ pickedBy: hit, services: STATE.services.length }).toEqual({
            pickedBy: "nothing (ground)",
            services: 1,
        });
    });

    it("the Link tool picks no source", () => {
        createService("compute", new T.Vector3(0, 0, 0));
        window.setTool("connect");
        showLinkTargets();

        const hit = clickWorld(CLICK_X, 0);

        expect({ pickedBy: hit, selected: STATE.selectedNodeId }).toEqual({
            pickedBy: "nothing (ground)",
            selected: null,
        });
    });

    it("even while the ring is showing, it is a cue and never a click target", () => {
        const compute = (createService("compute", new T.Vector3(0, 0, 0)), STATE.services[0]);
        createService("db", new T.Vector3(12, 0, 0));
        window.setTool("connect");
        STATE.selectedNodeId = compute.id;
        showLinkTargets();
        expect(STATE.services[1].linkTargetRing.visible, "the DB is offered").toBe(true);

        const hit = clickWorld(12 - CLICK_X, 0);

        expect(hit).toBe("nothing (ground)");
        expect(STATE.connections).toHaveLength(0);
    });
});

describe("control: the picker does pick services", () => {
    it("a click on a service's own body still picks it", () => {
        createService("compute", new T.Vector3(0, 0, 0));
        window.setTool("delete");
        // The top hit may be the body or a part stacked on it; either is the Compute.
        expect(clickWorld(0, 0)).toMatch(/^compute (body|child)$/);
        expect(STATE.services.length).toBe(0);
    });
});
