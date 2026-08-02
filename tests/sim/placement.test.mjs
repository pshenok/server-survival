// Canvas placement — the mouse-click path (#227).
//
// The bug this suite pins: the mousedown handler used to gate ground
// placement on a hardcoded tool allowlist that was separate from the
// tool → service-type map below it. The two drifted: five services
// (monitor, container, stream, dns, warehouse) were selectable in the
// toolbar but silent no-ops on the canvas, which made Level 15 "Flying
// Blind" unwinnable — its primary objective is "Deploy a Monitoring node".
// Every prior playthrough test called createService() directly, so the
// click path itself was never exercised; this suite dispatches real
// mousedown events (the three-stub raycaster resolves them to a ground
// hit) and pins the map against CONFIG.services so the gate cannot drift.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/config.js";
import { STATE } from "../../src/state.js";
// game.js must enter the module graph before handlers.js: the two form a
// runtime cycle, and game.js's own body calls into handlers — evaluating
// handlers first would hit its bindings in the temporal dead zone.
import { resetGame } from "../../game.js";
import { PLACEMENT_TYPE_MAP } from "../../src/input/handlers.js";
import { SERVICE_CATEGORIES } from "../../src/ui/toolbar.js";

const container = () => document.getElementById("canvas-container");

function clickCanvas() {
    container().dispatchEvent(
        new window.MouseEvent("mousedown", {
            button: 0,
            clientX: 400,
            clientY: 300,
            bubbles: true,
        })
    );
}

beforeEach(() => {
    resetGame("survival");
    STATE.isRunning = true;
    STATE.money = 999999;
});

describe("placement map completeness", () => {
    it("covers every placeable CONFIG service (the #227 drift)", () => {
        // Tool ids match service types except Compute, whose button has
        // always been "lambda".
        const expectedTools = Object.keys(CONFIG.services).map((t) =>
            t === "compute" ? "lambda" : t
        );
        expect(Object.keys(PLACEMENT_TYPE_MAP).sort()).toEqual(expectedTools.sort());
    });

    it("maps every tool back to a real CONFIG service type", () => {
        for (const [tool, type] of Object.entries(PLACEMENT_TYPE_MAP)) {
            expect(CONFIG.services[type], `${tool} → ${type}`).toBeTruthy();
        }
    });

    it("covers every toolbar category entry — no button can be a no-op", () => {
        const toolOf = (type) => (type === "compute" ? "lambda" : type);
        for (const cat of SERVICE_CATEGORIES) {
            for (const type of cat.types) {
                expect(
                    PLACEMENT_TYPE_MAP[toolOf(type)],
                    `toolbar offers "${type}" but the canvas cannot place it`
                ).toBe(type);
            }
        }
    });
});

describe("mouse-click placement (real event path)", () => {
    it("places a Monitoring node on canvas click — the Level 15 objective", () => {
        STATE.activeTool = "monitor";
        const before = STATE.money;
        clickCanvas();
        const monitor = STATE.services.find((s) => s.type === "monitor");
        expect(monitor).toBeTruthy();
        expect(STATE.money).toBe(before - CONFIG.services.monitor.cost);
    });

    it("places every mapped tool via a real click", () => {
        for (const [tool, type] of Object.entries(PLACEMENT_TYPE_MAP)) {
            resetGame("survival");
            STATE.isRunning = true;
            STATE.money = 999999;
            STATE.activeTool = tool;
            const countBefore = STATE.services.filter((s) => s.type === type).length;
            clickCanvas();
            const countAfter = STATE.services.filter((s) => s.type === type).length;
            expect(countAfter, `tool "${tool}" placed no "${type}"`).toBe(countBefore + 1);
        }
    });

    it("still ignores clicks for non-placement tools", () => {
        STATE.activeTool = "select";
        const before = STATE.services.length;
        clickCanvas();
        expect(STATE.services.length).toBe(before);
    });
});
