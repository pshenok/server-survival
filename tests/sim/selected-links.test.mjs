// With the Select tool, clicking a node shows its links: what it sends to in
// one colour, what it receives from in another, the rest dimmed (#89 item 3).
//
// The picture is drawn by a painter once per frame, and the hover path repaints
// every link on every pointer move, four times a second even with the mouse
// still. So these tests go through the real click and the real frame.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

// Installed before game.js loads, so the frames below are the real animate().
const pending = [];
globalThis.requestAnimationFrame = (cb) => { pending.push(cb); return pending.length; };
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../src/state.js");
const { CONFIG } = await import("../../src/config.js");
const { resetGame } = await import("../../game.js");
const { createConnection, createService, deleteObject } = await import("../../src/sim/topology.js");
const { selectedLinksLine, showSelectedLinks } = await import("../../src/ui/link-feedback.js");

const T = globalThis.THREE;
const { line, lineActive, lineIncoming, lineDim } = CONFIG.colors;
const container = () => document.getElementById("canvas-container");

function place(type, x) {
    createService(type, new T.Vector3(x, 0, 0));
    return STATE.services[STATE.services.length - 1];
}

function down(hit, init = {}) {
    raycastHits.services = hit ? [{ object: hit.mesh }] : [];
    container().dispatchEvent(
        new globalThis.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10, ...init })
    );
    container().dispatchEvent(new globalThis.MouseEvent("mouseup", { bubbles: true, button: 0 }));
    resetRaycastHits();
}

const colourOf = (from, to) => {
    const c = STATE.connections.find((k) => k.from === from.id && k.to === to.id);
    return c.mesh.material.color.getHex();
};

let waf, alb, compute, db;

beforeEach(() => {
    resetGame("survival");
    resetRaycastHits();
    STATE.isRunning = true;
    STATE.money = 100000;
    // waf -> alb -> compute -> db
    waf = place("waf", 0);
    alb = place("alb", 8);
    compute = place("compute", 16);
    db = place("db", 24);
    createConnection(waf.id, alb.id);
    createConnection(alb.id, compute.id);
    createConnection(compute.id, db.id);
    window.setTool("select");
});

afterEach(() => {
    resetRaycastHits();
    pending.length = 0;
    STATE.animationId = null;
});

describe("clicking a node with the Select tool", () => {
    it("selects it", () => {
        down(alb);

        expect([...STATE.selection]).toEqual([alb.id]);
    });

    it("colours its outgoing and incoming links differently, and dims the rest", () => {
        down(compute);
        showSelectedLinks();

        expect(colourOf(compute, db), "outgoing").toBe(lineActive);
        expect(colourOf(alb, compute), "incoming").toBe(lineIncoming);
        expect(colourOf(waf, alb), "unrelated").toBe(lineDim);
        expect(new Set([line, lineActive, lineIncoming, lineDim]).size).toBe(4);
    });

    it("also works for the Internet node", () => {
        STATE.internetNode.connections = [];
        createConnection("internet", waf.id);
        STATE.selection.add("internet");
        showSelectedLinks();

        const c = STATE.connections.find((k) => k.from === "internet");
        expect(c.mesh.material.color.getHex()).toBe(lineActive);
    });

    it("still drags the node it selected", () => {
        raycastHits.services = [{ object: alb.mesh }];
        container().dispatchEvent(
            new globalThis.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })
        );

        expect([...STATE.selection]).toEqual([alb.id]);
        expect(container().style.cursor).toBe("grabbing");
    });

    it("still repairs a damaged node, and selects it too", () => {
        alb.health = 10;
        down(alb);

        expect(alb.health).toBeGreaterThan(10);
        expect([...STATE.selection]).toEqual([alb.id]);
    });

    it("clicking another node moves the selection", () => {
        down(compute);
        showSelectedLinks();
        down(waf);
        showSelectedLinks();

        expect(colourOf(waf, alb)).toBe(lineActive);
        expect(colourOf(compute, db)).toBe(lineDim);
    });
});

describe("the links go back to normal", () => {
    const allNormal = () => STATE.connections.map((c) => c.mesh.material.color.getHex());
    const normal = () => STATE.connections.map(() => line);

    it("when the ground is clicked", () => {
        down(compute);
        showSelectedLinks();

        down(null);
        showSelectedLinks();

        expect(STATE.selection.size).toBe(0);
        expect(allNormal()).toEqual(normal());
    });

    it("when another tool is chosen", () => {
        down(compute);
        showSelectedLinks();

        window.setTool("connect");
        showSelectedLinks();

        expect(allNormal()).toEqual(normal());
    });

    it("a Link source is not treated as a selection", () => {
        window.setTool("connect");
        STATE.selectedNodeId = compute.id;

        showSelectedLinks();

        expect(allNormal()).toEqual(normal());
    });

    it("a selected node that has gone from the board dims nothing", () => {
        down(compute);
        showSelectedLinks();

        deleteObject(compute.id);
        showSelectedLinks();

        expect(allNormal()).toEqual(normal());
    });
});

describe("in the real frame", () => {
    let clock = 0;
    function frame() {
        const cb = pending.pop();
        pending.length = 0;
        if (!cb) return false;
        clock += 50;
        cb(clock);
        return true;
    }

    it("the colours survive the tooltip's own repaint of every link", () => {
        STATE.lastTime = clock;
        down(compute);
        // A still mouse on an open tooltip: animate() re-sends a mousemove four
        // times a second, and the hover path starts by resetting every link.
        raycastHits.services = [{ object: alb.mesh }];
        container().dispatchEvent(new globalThis.MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
        expect(document.getElementById("tooltip").style.display).toBe("block");

        for (let i = 0; i < 8; i++) {
            expect(frame(), "animate() must be running for this to prove anything").toBe(true);
            expect(colourOf(compute, db), `outgoing after frame ${i}`).toBe(lineActive);
            expect(colourOf(alb, compute), `incoming after frame ${i}`).toBe(lineIncoming);
        }
    });
});

describe("the painter leaves the Unlink hover alone", () => {
    it("with nothing selected it writes no colours, so a red hover stays red", () => {
        window.setTool("unlink");
        showSelectedLinks(); // the one reset pass, if any was owed
        const c = STATE.connections[0];
        c.mesh.material.color.setHex(0xff4444);

        showSelectedLinks();

        expect(c.mesh.material.color.getHex()).toBe(0xff4444);
    });
});

describe("the tooltip explains the colours", () => {
    it("names the counts with the two colours and no words to translate", () => {
        const html = selectedLinksLine(alb.id);

        expect(html).toContain("→ 1");
        expect(html).toContain("← 1");
        expect(html).toContain("text-cyan-400");
        expect(html).toContain("text-fuchsia-400");
    });

    it("the selected node's tooltip carries it, an unselected one does not", () => {
        down(alb);
        raycastHits.services = [{ object: alb.mesh }];
        container().dispatchEvent(new globalThis.MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
        expect(document.getElementById("tooltip").innerHTML).toContain("→ 1");

        raycastHits.services = [{ object: waf.mesh }];
        container().dispatchEvent(new globalThis.MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
        expect(document.getElementById("tooltip").innerHTML).not.toContain("→");
    });
});
