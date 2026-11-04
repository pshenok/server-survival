// The Metrics panel is the dashboard #89 item 5 asked for: per service, its
// name, tier and health over its load, queue, errors and latency.
//
// Names used to be cut to ten letters and then to four beside a badge, in a
// 48px column. Each row now has a line of its own for them. Tier and health
// were not on the panel at all, and both change while the game is paused (an
// upgrade, a click to repair), when no new metrics sample lands.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { createService } from "../../src/sim/topology.js";
import { toggleAutoscaling } from "../../src/sim/autoscaling.js";
import { renderMetricsPanel } from "../../src/ui/metrics-panel.js";
import { i18n } from "../../src/i18n.js";

const T = globalThis.THREE;

function place(type, x) {
    createService(type, new T.Vector3(x, 0, 0));
    return STATE.services[STATE.services.length - 1];
}

const rowsEl = () => document.getElementById("metrics-rows");
const rows = () => [...rowsEl().querySelectorAll("[data-metrics-row]")];
const rowOf = (s) => rowsEl().querySelector(`[data-metrics-row="${s.id}"]`);
const nameOf = (s) => rowOf(s).querySelector("[data-metrics-name]");
const tierOf = (s) => rowOf(s).querySelector("[data-metrics-tier]");
const healthOf = (s) => rowOf(s).querySelector("[data-metrics-health]");

beforeEach(() => {
    i18n.setLocale("en");
    resetGame("survival");
    STATE.money = 100000;
});

afterEach(() => {
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("unlocking", () => {
    it("stays locked without a Monitoring service", () => {
        place("alb", 0);

        renderMetricsPanel();

        expect(document.getElementById("metrics-locked").classList.contains("hidden")).toBe(false);
        expect(rowsEl().classList.contains("hidden")).toBe(true);
    });

    it("one row per service, leaving out the monitor itself", () => {
        const lb = place("alb", 0);
        const db = place("db", 8);
        place("monitor", 16);

        renderMetricsPanel();

        expect(rowsEl().classList.contains("hidden")).toBe(false);
        expect(rows().map((r) => r.getAttribute("data-metrics-row"))).toEqual([lb.id, db.id]);
    });
});

describe("each row says what the service is", () => {
    it("the full name, not ten letters of it", () => {
        const dlq = place("dlq", 0);
        place("monitor", 8);

        renderMetricsPanel();

        expect(nameOf(dlq).textContent).toBe("Dead-Letter Queue");
    });

    it("a badge does not cost the name its letters", () => {
        const compute = place("compute", 0);
        const lb = place("alb", 8);
        place("monitor", 16);
        toggleAutoscaling(compute);
        lb.breakerState = "open";

        renderMetricsPanel();

        expect(nameOf(compute).textContent).toBe(i18n.t("compute"));
        expect(rowOf(compute).textContent).toContain("×1");
        expect(nameOf(lb).textContent).toBe(i18n.t("alb"));
        expect(rowOf(lb).textContent).toContain(i18n.t("breaker_open"));
    });

    it("a language switch relabels the rows", () => {
        const scheduler = place("scheduler", 0);
        place("monitor", 8);
        renderMetricsPanel();
        const english = nameOf(scheduler).textContent;

        i18n.setLocale("ru");
        renderMetricsPanel();

        expect(nameOf(scheduler).textContent).toBe(i18n.t("scheduler"));
        expect(nameOf(scheduler).textContent).not.toBe(english);
        expect(rowsEl().textContent).toContain(i18n.t("metrics_col_util"));
    });
});

describe("tier", () => {
    it("shows on a service that has tiers", () => {
        const compute = place("compute", 0);
        place("monitor", 8);

        renderMetricsPanel();

        expect(tierOf(compute).textContent).toBe("T1");
    });

    it("a service with no tiers shows none, since T1 would mean nothing", () => {
        const lb = place("alb", 0);
        place("monitor", 8);

        renderMetricsPanel();

        expect(tierOf(lb)).toBeNull();
    });

    it("follows an upgrade while paused", () => {
        const compute = place("compute", 0);
        place("monitor", 8);
        STATE.timeScale = 0;
        renderMetricsPanel();

        compute.upgrade();
        renderMetricsPanel();

        expect(tierOf(compute).textContent).toBe("T2");
    });
});

describe("health", () => {
    it("shows as a percentage in the colour the tooltip uses", () => {
        const lb = place("alb", 0);
        place("monitor", 8);

        lb.health = 100;
        renderMetricsPanel();
        expect(healthOf(lb).textContent).toBe("100%");
        expect(healthOf(lb).classList.contains("text-green-400")).toBe(true);

        lb.health = 55.4;
        renderMetricsPanel();
        expect(healthOf(lb).textContent).toBe("55%");
        expect(healthOf(lb).classList.contains("text-yellow-400")).toBe(true);
        expect(healthOf(lb).classList.contains("text-green-400")).toBe(false);

        lb.health = 12;
        renderMetricsPanel();
        expect(healthOf(lb).textContent).toBe("12%");
        expect(healthOf(lb).classList.contains("text-red-400")).toBe(true);
        expect(healthOf(lb).classList.contains("text-yellow-400")).toBe(false);
    });

    it("updates in place, without rebuilding the row or its sparklines", () => {
        const lb = place("alb", 0);
        place("monitor", 8);
        renderMetricsPanel();
        const canvas = rowOf(lb).querySelector("canvas");

        lb.health = 30;
        renderMetricsPanel();

        expect(healthOf(lb).textContent).toBe("30%");
        expect(rowOf(lb).querySelector("canvas")).toBe(canvas);
    });
});

describe("the sparklines", () => {
    it("every row has one per column, as wide as its header", () => {
        const lb = place("alb", 0);
        place("monitor", 8);

        renderMetricsPanel();

        const canvases = [...rowOf(lb).querySelectorAll("canvas")];
        const header = rowsEl().querySelector("[data-metrics-header]");
        expect(canvases).toHaveLength(4);
        expect(header.children).toHaveLength(4);
        for (const label of header.children) {
            expect(label.style.width).toBe(`${canvases[0].width}px`);
        }
    });
});
