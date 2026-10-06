// The Link tool rings the nodes a picked source can connect to (#89, item 4).
//
// The rings and the refusal come from one function, linkRefusal() in
// topology.js. The last block proves that on a mixed board: for every ordered
// pair, a ring is showing exactly when a click would make the link. If the two
// ever drift, the board offers links a click refuses, or hides ones it takes.
//
// animate() calls showLinkTargets() every frame; these tests call it the same
// way after each action, since the headless suite does not run animate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { createConnection, createService, deleteConnection } from "../../src/sim/topology.js";
import { showLinkTargets } from "../../src/ui/link-feedback.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const container = () => document.getElementById("canvas-container");

function place(type, x) {
    createService(type, new globalThis.THREE.Vector3(x, 0, 0));
    return STATE.services[STATE.services.length - 1];
}

function clickOn(svc) {
    raycastHits.services = [{ object: svc.mesh }];
    container().dispatchEvent(
        new globalThis.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })
    );
    resetRaycastHits();
}

const ringed = () => STATE.services.filter((s) => s.linkTargetRing.visible).map((s) => s.type);

beforeEach(() => {
    resetRaycastHits();
    resetGame("survival");
    STATE.isRunning = true;
    STATE.money = 999999;
});
afterEach(resetRaycastHits);

describe("picking a Link source rings where it can connect", () => {
    it("rings the valid targets, and neither the invalid ones nor the source", () => {
        const compute = place("compute", 0);
        place("db", 10);
        place("cache", 20);
        place("waf", 30);
        window.setTool("connect");

        clickOn(compute);
        showLinkTargets();

        expect(ringed().sort()).toEqual(["cache", "db"]);
    });

    it("no rings before a source is picked, and none after the link is made", () => {
        const compute = place("compute", 0);
        const db = place("db", 10);
        window.setTool("connect");

        showLinkTargets();
        expect(ringed()).toEqual([]);

        clickOn(compute);
        clickOn(db);
        showLinkTargets();
        expect(ringed()).toEqual([]);
    });

    it("no rings under any other tool, even with a node selected", () => {
        const compute = place("compute", 0);
        place("db", 10);
        window.setTool("connect");
        clickOn(compute);

        window.setTool("select");
        STATE.selectedNodeId = compute.id;
        showLinkTargets();

        expect(ringed()).toEqual([]);
    });

    it("a target already linked from the source is not offered again", () => {
        const compute = place("compute", 0);
        const db = place("db", 10);
        place("cache", 20);
        createConnection(compute.id, db.id);
        window.setTool("connect");

        clickOn(compute);
        showLinkTargets();

        expect(ringed()).toEqual(["cache"]);
    });

    it("the Internet can be the source too", () => {
        place("waf", 0);
        place("compute", 10);
        window.setTool("connect");
        STATE.selectedNodeId = "internet";

        showLinkTargets();

        expect(ringed()).toEqual(["waf"]);
    });
});

describe("a ring shows exactly when a click would make the link", () => {
    it("holds for every ordered pair on a mixed board", () => {
        const types = ["waf", "alb", "sqs", "compute", "cache", "db", "s3", "cdn", "apigw", "dlq"];
        const nodes = types.map((t, i) => place(t, i * 6));
        // One existing link of each direction-sensitive kind, so "exists" and
        // "reverse" are both on the board, not only "invalid".
        const byType = (t) => nodes.find((n) => n.type === t);
        createConnection(byType("sqs").id, byType("alb").id);
        createConnection(byType("compute").id, byType("db").id);
        window.setTool("connect");

        const disagreements = [];
        let accepted = 0;
        let refused = 0;
        for (const from of nodes) {
            STATE.selectedNodeId = from.id;
            showLinkTargets();
            const offered = new Set(nodes.filter((n) => n.linkTargetRing.visible).map((n) => n.id));
            for (const to of nodes) {
                const result = createConnection(from.id, to.id);
                if (result.ok) deleteConnection(from.id, to.id);
                if (result.ok) accepted++;
                else refused++;
                if (result.ok !== offered.has(to.id)) {
                    disagreements.push(`${from.type} -> ${to.type}: ring ${offered.has(to.id)}, click ${result.ok}`);
                }
            }
        }
        expect(disagreements).toEqual([]);
        // Not vacuous: the board holds both kinds of pair in quantity.
        expect(accepted).toBeGreaterThan(5);
        expect(refused).toBeGreaterThan(50);
    });
});

describe("the ring is disposed with its service", () => {
    it("destroy() releases the link ring and the load ring", () => {
        const compute = place("compute", 0);
        let disposed = 0;
        for (const ring of [compute.linkTargetRing, compute.loadRing]) {
            ring.geometry.dispose = () => disposed++;
            ring.material.dispose = () => disposed++;
        }
        compute.destroy();
        expect(disposed).toBe(4);
    });
});
