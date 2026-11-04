// Shift+click selects several nodes, and the operations act on all of them
// (#89 item 2): dragging moves the group, Link and Unlink carry the selection
// over and apply it to the node clicked next, and Delete removes it.
//
// Real mouse and key events throughout. The raycaster is primed per click, and
// the ground point follows `pointer`, because a drag is measured against it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { CONFIG } from "../../src/config.js";
import { resetGame, raycaster } from "../../game.js";
import { clearAllServices, createConnection, createService } from "../../src/sim/topology.js";
import { showLinkTargets, showSelectedLinks } from "../../src/ui/link-feedback.js";
import { loadGameState } from "../../src/persistence/save-load.js";
import { i18n } from "../../src/i18n.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const T = globalThis.THREE;
const TILE = CONFIG.tileSize;
const container = () => document.getElementById("canvas-container");
const savedIntersectPlane = raycaster.ray.intersectPlane;
let pointer = { x: 0, z: 0 };

function place(type, tileX, tileZ = 0) {
    createService(type, new T.Vector3(tileX * TILE, 0, tileZ * TILE));
    return STATE.services[STATE.services.length - 1];
}

function mouse(type, init = {}) {
    container().dispatchEvent(
        new globalThis.MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10, ...init })
    );
}

function down(node, { shiftKey = false } = {}) {
    raycastHits.services = node ? [{ object: node.mesh }] : [];
    mouse("mousedown", { shiftKey });
    resetRaycastHits();
}

function click(node, opts) {
    down(node, opts);
    mouse("mouseup");
}

function dragTo(tileX, tileZ = 0) {
    pointer = { x: tileX * TILE, z: tileZ * TILE };
    resetRaycastHits();
    mouse("mousemove");
}

const tile = (s) => [s.position.x / TILE, s.position.z / TILE];
const meshTile = (s) => [s.mesh.position.x / TILE, s.mesh.position.z / TILE];
const selection = () => [...STATE.selection];
const links = () => STATE.connections.map((c) => [c.from, c.to]);
const press = (key, target = document.body) =>
    target.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key, bubbles: true }));

let a, b, other;

beforeEach(() => {
    resetGame("survival");
    resetRaycastHits();
    raycaster.ray.intersectPlane = (_plane, target) => target.set(pointer.x, 0, pointer.z);
    STATE.isRunning = true;
    STATE.money = 100000;
    document.getElementById("main-menu-modal").classList.add("hidden");
    window.setTool("select");
    a = place("compute", 0);
    b = place("compute", 2);
    other = place("db", 10);
});

afterEach(() => {
    resetRaycastHits();
    raycaster.ray.intersectPlane = savedIntersectPlane;
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("building a selection", () => {
    it("Shift+click adds a node, and again removes it", () => {
        click(a);
        click(b, { shiftKey: true });
        expect(selection()).toEqual([a.id, b.id]);

        click(a, { shiftKey: true });
        expect(selection()).toEqual([b.id]);
    });

    it("Shift+click neither grabs nor repairs", () => {
        a.health = 10;

        down(a, { shiftKey: true });

        expect(a.health).toBe(10);
        expect(container().style.cursor).not.toBe("grabbing");
        mouse("mouseup");
    });

    it("a plain click on a node outside it starts over", () => {
        click(a);
        click(b, { shiftKey: true });

        click(other);

        expect(selection()).toEqual([other.id]);
    });

    it("a plain click on the ground clears it, Shift on the ground keeps it", () => {
        click(a);
        click(b, { shiftKey: true });

        click(null, { shiftKey: true });
        expect(selection()).toEqual([a.id, b.id]);

        click(null);
        expect(selection()).toEqual([]);
    });

    it("the Internet node can join", () => {
        click(a);
        raycastHits.internet = [{ object: STATE.internetNode.mesh }];
        mouse("mousedown", { shiftKey: true });
        mouse("mouseup");
        resetRaycastHits();

        expect(selection()).toEqual([a.id, "internet"]);
    });

    it("every selected node gets the bright ring", () => {
        click(a);
        click(b, { shiftKey: true });

        for (const s of STATE.services) s.update(0);

        expect(a.loadRing.material.opacity).toBe(1);
        expect(b.loadRing.material.opacity).toBe(1);
        expect(other.loadRing.material.opacity).toBeLessThan(1);
    });

    it("a Link source keeps its bright ring too", () => {
        window.setTool("connect");
        click(a);

        for (const s of STATE.services) s.update(0);

        expect(a.loadRing.material.opacity).toBe(1);
        expect(b.loadRing.material.opacity).toBeLessThan(1);
    });

    it("the links of all of them are coloured", () => {
        const c = place("db", 4);
        const d = place("alb", -2);
        createConnection(a.id, c.id);
        createConnection(d.id, b.id);
        createConnection(d.id, a.id);
        click(a);
        click(b, { shiftKey: true });

        showSelectedLinks();

        const colour = (from, to) =>
            STATE.connections.find((k) => k.from === from.id && k.to === to.id).mesh.material.color.getHex();
        expect(colour(a, c)).toBe(CONFIG.colors.lineActive);
        expect(colour(d, b)).toBe(CONFIG.colors.lineIncoming);
        expect(colour(d, a)).toBe(CONFIG.colors.lineIncoming);
    });
});

describe("dragging a selected node moves the group", () => {
    beforeEach(() => {
        click(a);
        click(b, { shiftKey: true });
    });

    it("every member moves by the same number of tiles and stays selected", () => {
        down(a);
        dragTo(5, 3);
        mouse("mouseup");

        expect(tile(a)).toEqual([5, 3]);
        expect(tile(b)).toEqual([7, 3]);
        expect(meshTile(b)).toEqual([7, 3]);
        expect(selection()).toEqual([a.id, b.id]);
    });

    it("the group follows the pointer during the drag", () => {
        down(a);
        dragTo(1, 1);

        expect(tile(b)).toEqual([3, 1]);
        mouse("mouseup");
    });

    it("the links of a member that was not grabbed follow it", () => {
        const c = place("db", 4);
        createConnection(b.id, c.id);
        const line = STATE.connections.find((k) => k.from === b.id).mesh;

        down(a);
        dragTo(0, 3);
        mouse("mouseup");

        const start = line.geometry.points[0];
        expect([start.x / TILE, start.z / TILE]).toEqual([2, 3]);
    });

    it("if one member would land on an occupied tile, the whole group goes back", () => {
        // a lands on (8,0), free; b would land on (10,0), the DB's tile.
        down(a);
        dragTo(8);
        mouse("mouseup");

        expect(tile(a)).toEqual([0, 0]);
        expect(tile(b)).toEqual([2, 0]);
        expect(meshTile(b)).toEqual([2, 0]);
    });

    it("members may land on tiles the group itself is leaving", () => {
        down(a);
        dragTo(2);
        mouse("mouseup");

        expect(tile(a)).toEqual([2, 0]);
        expect(tile(b)).toEqual([4, 0]);
    });

    it("a click that moves nothing narrows the selection to that node", () => {
        click(b);

        expect(selection()).toEqual([b.id]);
        expect(tile(b)).toEqual([2, 0]);
    });

    it("a blocked drop keeps the selection, so the player can try again", () => {
        down(a);
        dragTo(8);
        mouse("mouseup");

        expect(selection()).toEqual([a.id, b.id]);
    });

    it("a single node still drags alone", () => {
        click(other);
        down(other);
        dragTo(14);
        mouse("mouseup");

        expect(tile(other)).toEqual([14, 0]);
        expect(tile(a)).toEqual([0, 0]);
    });
});

describe("Link acts on all of a multi-selection", () => {
    it("links every selected node to the node clicked next", () => {
        click(a);
        click(b, { shiftKey: true });
        window.setTool("connect");

        click(other);

        expect(links()).toEqual([[a.id, other.id], [b.id, other.id]]);
        expect(selection()).toEqual([]);
        expect(STATE.selectedNodeId).toBeNull();
    });

    it("Shift on the target keeps the selection for another target", () => {
        const db2 = place("db", 14);
        click(a);
        click(b, { shiftKey: true });
        window.setTool("connect");

        click(other, { shiftKey: true });
        click(db2);

        expect(links().length).toBe(4);
        expect(selection()).toEqual([]);
    });

    it("skips the members that may not link, without a refusal", () => {
        const alb = place("alb", 6);
        document.getElementById("intervention-warnings").innerHTML = "";
        click(alb);
        click(a, { shiftKey: true });
        window.setTool("connect");

        click(b);

        // The LB may send to Compute; a Compute may not.
        expect(links()).toEqual([[alb.id, b.id]]);
        expect(document.querySelector("[data-link-rejected]")).toBeNull();
    });

    it("when none may, one refusal explains why", () => {
        const dbs = [other, place("db", 14)];
        document.getElementById("intervention-warnings").innerHTML = "";
        click(dbs[0]);
        click(dbs[1], { shiftKey: true });
        window.setTool("connect");

        click(a);

        expect(links()).toEqual([]);
        expect(document.querySelectorAll("[data-link-rejected]").length).toBe(1);
    });

    it("rings every node at least one of them can reach", () => {
        const alb = place("alb", 6);
        click(alb);
        click(a, { shiftKey: true });
        window.setTool("connect");

        showLinkTargets();

        expect(other.linkTargetRing.visible, "a Compute can reach the DB").toBe(true);
        expect(b.linkTargetRing.visible, "the LB can reach this Compute").toBe(true);
    });

    it("a single selected node does not carry over: a drag must not arm a link", () => {
        click(a);
        window.setTool("connect");
        expect(selection()).toEqual([]);

        click(other);

        expect(links()).toEqual([]);
        expect(STATE.selectedNodeId, "the click picks a source, as ever").toBe(other.id);
    });
});

describe("Unlink acts on all of a multi-selection", () => {
    beforeEach(() => {
        createConnection(a.id, other.id);
        createConnection(b.id, other.id);
    });

    it("removes the links between the selection and the node clicked", () => {
        const keep = place("compute", 6);
        createConnection(keep.id, other.id);
        click(a);
        click(b, { shiftKey: true });
        window.setTool("unlink");

        click(other);

        expect(links()).toEqual([[keep.id, other.id]]);
        expect(selection()).toEqual([]);
    });

    it("works in either direction", () => {
        const lb = place("alb", 6);
        createConnection(lb.id, a.id);
        createConnection(lb.id, b.id);
        click(a);
        click(b, { shiftKey: true });
        window.setTool("unlink");

        click(lb);

        expect(links()).toEqual([[a.id, other.id], [b.id, other.id]]);
    });

    it("with nothing to remove it keeps the selection", () => {
        const lone = place("compute", 14);
        click(a);
        click(b, { shiftKey: true });
        window.setTool("unlink");

        click(lone);

        expect(links().length).toBe(2);
        expect(selection()).toEqual([a.id, b.id]);
    });

    it("with no selection, clicking a node removes nothing", () => {
        window.setTool("unlink");

        click(other);

        expect(links().length).toBe(2);
    });
});

describe("Delete removes the selection", () => {
    beforeEach(() => {
        click(a);
        click(b, { shiftKey: true });
    });

    it.each(["Delete", "Backspace"])("%s removes every selected node", (key) => {
        press(key);

        expect(STATE.services).toEqual([other]);
        expect(selection()).toEqual([]);
    });

    it("refunds them as the Demolish tool does", () => {
        const before = STATE.money;

        press("Delete");

        expect(STATE.money).toBe(before + CONFIG.services.compute.cost);
    });

    it("the Internet node survives it", () => {
        STATE.selection.add("internet");

        press("Delete");

        expect(STATE.internetNode.mesh).toBeTruthy();
        expect(STATE.services).toEqual([other]);
    });

    it("not while typing in a field", () => {
        const field = document.createElement("input");
        document.body.appendChild(field);

        press("Backspace", field);

        expect(STATE.services.length).toBe(3);
        field.remove();
    });

    it("not with the main menu open", () => {
        document.getElementById("main-menu-modal").classList.remove("hidden");

        press("Delete");

        expect(STATE.services.length).toBe(3);
    });

    it.each(["share-modal", "faq-modal", "save-modal", "trophies-modal"])("not behind the %s", (id) => {
        const dialog = document.getElementById(id);
        dialog.classList.remove("hidden");

        press("Delete");

        dialog.classList.add("hidden");
        expect(STATE.services.length).toBe(3);
    });

    it("not during the tutorial", () => {
        window.tutorial.isActive = true;

        press("Delete");

        window.tutorial.isActive = false;
        expect(STATE.services.length).toBe(3);
    });
});

describe("the selection ends", () => {
    beforeEach(() => {
        click(a);
        click(b, { shiftKey: true });
    });

    it("when a placement or Demolish tool is chosen", () => {
        window.setTool("delete");
        expect(selection()).toEqual([]);
    });

    it("with the run", () => {
        resetGame("sandbox");
        expect(selection()).toEqual([]);
    });

    it("when a save is loaded", () => {
        loadGameState({
            version: "2.0",
            money: 500,
            reputation: 80,
            requestsProcessed: 0,
            isRunning: false,
            services: [],
            connections: [],
            internetConnections: [],
        });
        expect(selection()).toEqual([]);
    });

    it("when the sandbox board is cleared", () => {
        clearAllServices();
        expect(selection()).toEqual([]);
    });
});

describe("the help screen teaches it", () => {
    it.each(["en", "de", "fr", "hi", "it", "ko", "nep", "pt-BR", "ru", "uk", "zh"])("in %s", (locale) => {
        i18n.setLocale(locale);
        const key = { fr: "Maj", it: "Maiusc" }[locale] || "Shift";

        expect(i18n.t("tool_select_desc")).toContain(key);
        expect(i18n.t("tool_select_desc")).toContain("text-cyan-400");
        expect(i18n.t("tool_select_desc")).toContain("text-fuchsia-400");
    });
});
