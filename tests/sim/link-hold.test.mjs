// Shift keeps the Link source (#89 item 2): wiring one node to several used to
// mean clicking it again before every link. Off by default, because the
// tutorial and every player so far expect a link to end on its destination.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { createService } from "../../src/sim/topology.js";
import { showLinkTargets } from "../../src/ui/link-feedback.js";
import { i18n } from "../../src/i18n.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const container = () => document.getElementById("canvas-container");

function place(type, x) {
    createService(type, new globalThis.THREE.Vector3(x, 0, 0));
    return STATE.services[STATE.services.length - 1];
}

function clickOn(svc, { shiftKey = false } = {}) {
    raycastHits.services = [{ object: svc.mesh }];
    container().dispatchEvent(
        new globalThis.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10, shiftKey })
    );
    resetRaycastHits();
}

const links = () => STATE.connections.map((c) => [c.from, c.to]);

let alb, c1, c2, c3;

beforeEach(() => {
    resetGame("survival");
    resetRaycastHits();
    STATE.isRunning = true;
    STATE.money = 100000;
    alb = place("alb", 0);
    c1 = place("compute", 8);
    c2 = place("compute", 16);
    c3 = place("compute", 24);
    window.setTool("connect");
});

afterEach(() => {
    resetRaycastHits();
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("Shift on the destination keeps the Link source", () => {
    it("links one source to several without picking it again", () => {
        clickOn(alb);
        clickOn(c1, { shiftKey: true });
        clickOn(c2, { shiftKey: true });
        clickOn(c3);

        expect(links()).toEqual([
            [alb.id, c1.id],
            [alb.id, c2.id],
            [alb.id, c3.id],
        ]);
    });

    it("a plain click on the last destination ends the chain", () => {
        clickOn(alb);
        clickOn(c1, { shiftKey: true });
        expect(STATE.selectedNodeId).toBe(alb.id);

        clickOn(c2);

        expect(STATE.selectedNodeId).toBeNull();
    });

    it("the source stays offered: the rings drop only what is already linked", () => {
        clickOn(alb);
        clickOn(c1, { shiftKey: true });

        showLinkTargets();

        expect(c1.linkTargetRing.visible, "already linked").toBe(false);
        expect(c2.linkTargetRing.visible).toBe(true);
        expect(c3.linkTargetRing.visible).toBe(true);
    });

    it("a refused link keeps the source too, so the next try needs no extra click", () => {
        const db = place("db", 32);
        clickOn(alb);

        clickOn(db, { shiftKey: true });

        expect(links()).toEqual([]);
        expect(STATE.selectedNodeId).toBe(alb.id);
    });

    it("Shift on the first click only picks the source", () => {
        clickOn(alb, { shiftKey: true });

        expect(STATE.selectedNodeId).toBe(alb.id);
        expect(links()).toEqual([]);
    });

    it("changing tool still drops the source", () => {
        clickOn(alb);
        clickOn(c1, { shiftKey: true });

        window.setTool("select");

        expect(STATE.selectedNodeId).toBeNull();
    });
});

describe("without Shift nothing changes", () => {
    it("a link ends on its destination, which the tutorial's chain relies on", () => {
        clickOn(alb);
        clickOn(c1);

        expect(links()).toEqual([[alb.id, c1.id]]);
        expect(STATE.selectedNodeId).toBeNull();

        clickOn(c2);
        expect(STATE.selectedNodeId, "the next click picks a new source").toBe(c2.id);
    });

    it("clicking the source again still drops it", () => {
        clickOn(alb);
        clickOn(alb);

        expect(STATE.selectedNodeId).toBeNull();
        expect(links()).toEqual([]);
    });
});

describe("the Link tool's description teaches it", () => {
    it.each(["en", "de", "fr", "hi", "it", "ko", "nep", "pt-BR", "ru", "uk", "zh"])("in %s", (locale) => {
        i18n.setLocale(locale);
        const key = { fr: "Maj", it: "Maiusc" }[locale] || "Shift";

        expect(i18n.t("tool_connect_desc")).toContain(key);
    });
});
