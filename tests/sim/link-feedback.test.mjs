// A refused link explains itself (src/ui/link-feedback.js).
//
// Before this, linking two nodes the edge table does not allow played a click
// and called console.error with a translated sentence no player ever saw, and
// that sentence described a five-service chain the game outgrew long ago. The
// player clicked, nothing happened, and nothing said why.
//
// The links here are made through the real click path: the Link tool, a
// mousedown on the source, a mousedown on the target. The three-stub raycaster
// is primed with the node each click should land on, as pointer-release.test
// does for a grab.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { createService, validTargets } from "../../src/sim/topology.js";
import { applyToolbarGating } from "../../src/ui/toolbar.js";
import { linkRejectionLines } from "../../src/ui/link-feedback.js";
import { i18n } from "../../src/i18n.js";
import { raycastHits, resetRaycastHits } from "../helpers/three-stub.mjs";

const container = () => document.getElementById("canvas-container");
const hints = () => [...document.querySelectorAll("[data-link-rejected]")];

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

function link(from, to) {
    window.setTool("connect");
    clickOn(from);
    clickOn(to);
}

beforeEach(() => {
    resetRaycastHits();
    resetGame("survival");
    applyToolbarGating(null, null);
    STATE.isRunning = true;
    STATE.money = 999999;
    hints().forEach((h) => h.remove());
});
afterEach(() => {
    resetRaycastHits();
    applyToolbarGating(null, null);
});

describe("a refused link says why, and what would work", () => {
    it("names both ends and lists where the source CAN send", () => {
        const compute = place("compute", 0);
        const waf = place("waf", 10);

        link(compute, waf);

        expect(STATE.connections).toHaveLength(0);
        expect(hints()).toHaveLength(1);
        const text = hints()[0].textContent;
        expect(text).toContain("Compute can't send traffic to Firewall.");
        expect(text).toContain("SQL Database");
        expect(text).toContain("Memory Cache");
        expect(text).not.toMatch(/can send to[^.]*Firewall/);
    });

    it("a valid link makes the connection and says nothing", () => {
        const compute = place("compute", 0);
        const db = place("db", 10);

        link(compute, db);

        expect(STATE.connections).toHaveLength(1);
        expect(hints()).toEqual([]);
    });

    it("a second refusal replaces the first instead of stacking", () => {
        const compute = place("compute", 0);
        const waf = place("waf", 10);
        const cdn = place("cdn", 20);

        link(compute, waf);
        link(compute, cdn);

        expect(hints()).toHaveLength(1);
        expect(hints()[0].textContent).toContain("Compute can't send traffic to CDN.");
    });

    it("a node that forwards nothing gets the headline alone, not an empty list", () => {
        const dlq = place("dlq", 0);
        const compute = place("compute", 10);

        link(dlq, compute);

        expect(hints()).toHaveLength(1);
        expect(hints()[0].children).toHaveLength(1);
    });

    it("no longer logs to the console, where no player looks", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            link(place("compute", 0), place("waf", 10));
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("in a campaign level, the hint only offers what the level allows", () => {
    it("drops services the level forbids from the list", () => {
        const compute = place("compute", 0);
        const waf = place("waf", 10);
        applyToolbarGating(["compute", "db", "waf", "alb"], null);

        link(compute, waf);

        const text = hints()[0].textContent;
        expect(text).toContain("SQL Database");
        expect(text).not.toContain("Memory Cache");
    });
});

describe("every locale renders a readable hint", () => {
    const LOCALES = ["en", "ru", "uk", "de", "fr", "it", "pt-BR", "zh", "ko", "hi", "ne"];

    afterEach(() => i18n.setLocale("en"));

    it.each(LOCALES)("%s fills every slot and spaces every comma", async (code) => {
        await i18n.setLocale(code);
        const lines = linkRejectionLines("compute", "waf", validTargets("compute"));

        expect(lines).toHaveLength(2);
        for (const line of lines) {
            expect(line, "a placeholder was left unfilled").not.toMatch(/\{\w+\}/);
            // ICU's Nepali list pattern writes "A,B, C"; the hint must not.
            expect(line).not.toMatch(/,\S/);
        }
        expect(lines[0]).toContain(i18n.t("compute"));
        expect(lines[0]).toContain(i18n.t("waf"));
        expect(lines[1]).toContain(i18n.t("db"));
    });
});

describe("validTargets is the edge table, read from the other side", () => {
    it.each([
        ["cdn", ["s3"]],
        ["dlq", []],
        ["notify", []],
    ])("%s sends to %j", (from, expected) => {
        expect(validTargets(from)).toEqual(expected);
    });

    it("the Internet reaches the edge services and nothing behind them", () => {
        const t = validTargets("internet");
        expect(t).toEqual(expect.arrayContaining(["waf", "alb", "cdn", "apigw", "auth"]));
        expect(t).not.toContain("compute");
        expect(t).not.toContain("db");
    });
});

describe("createConnection reports what happened", () => {
    it("ok for a new link, a reason for each kind of no-op", async () => {
        const { createConnection } = await import("../../src/sim/topology.js");
        const compute = place("compute", 0);
        const db = place("db", 10);
        const waf = place("waf", 20);

        expect(createConnection(compute.id, db.id)).toEqual({ ok: true });
        expect(createConnection(compute.id, db.id)).toEqual({ ok: false, reason: "exists" });
        expect(createConnection(compute.id, compute.id)).toEqual({ ok: false, reason: "self" });
        expect(createConnection(compute.id, "nope")).toEqual({ ok: false, reason: "missing" });
        expect(createConnection(compute.id, waf.id)).toEqual({
            ok: false,
            reason: "invalid",
            fromType: "compute",
            toType: "waf",
        });
    });
});
