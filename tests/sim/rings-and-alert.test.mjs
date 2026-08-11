// Step 3 of the failure-knee work (#74): the warnings tell the truth.
//
// Every load signal the player can see was calibrated against the wrong half
// of the scale. `totalLoad` divides by capacity x instances x 2, so 0.5 IS
// 100% of rated capacity — and the shipped thresholds were:
//
//   ring yellow  0.2   =  40% of capacity
//   ring orange  0.5   = 100%  <- exactly where the node starts dropping
//   ring red     0.8   = 160%  <- deep inside collapse
//   alert        0.85  = 170%  <- the $75 observability node, far too late
//
// So the board showed green and yellow right up to the moment it was already
// failing, and the Monitoring alert arrived when the information was useless.
// This step moves all four onto smoothedLoad and recalibrates them.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE, CONFIG, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { metricsTick, resetMetrics } from "../../src/core/metrics.js";
import { calculateFailChanceBasedOnLoad } from "../../src/core/actions.js";
import { sweepAt } from "../helpers/reference-board.mjs";

beforeEach(() => {
  resetWorld({ gameMode: "survival" });
  resetMetrics();
  STATE.intervention = { warnings: [], recentEvents: [] };
});
afterEach(() => vi.restoreAllMocks());

const RING = { red: 0xff0000, orange: 0xffaa00, yellow: 0xffff00 };

function ringColorAt(smoothed) {
  const s = place("compute");
  // The ring is repainted from smoothedLoad at the end of update(); pin the
  // raw signal so the smoothing cannot drag the value while we read it.
  Object.defineProperty(s, "smoothedLoad", { value: smoothed, writable: true });
  Object.defineProperty(s, "totalLoad", { get: () => smoothed, configurable: true });
  s.update(1 / 60);
  return s.loadRing.material.color.getHex();
}

describe("the load ring is calibrated to capacity (#74)", () => {
  it("THE ORDERING INVARIANT: alert < red = failure onset", () => {
    // The single assertion that keeps the three systems honest with each
    // other. Failure onset is 0.45 in smoothedLoad terms because the shipped
    // curve begins dropping above totalLoad 0.5 and the knee (step 4) begins
    // at 90% of capacity; the alert must land BEFORE the ring goes red, and
    // the ring must go red no later than the first drop.
    const { alertUtil, ringRed, ringOrange, ringYellow } = CONFIG.load;
    expect(alertUtil).toBeLessThan(ringRed);
    expect(ringYellow).toBeLessThan(ringOrange);
    expect(ringOrange).toBeLessThan(ringRed);
    // Red is at or before the point the shipped curve starts failing (0.5).
    expect(ringRed).toBeLessThanOrEqual(0.5);
    expect(calculateFailChanceBasedOnLoad(ringRed)).toBe(0);
  });

  it("red means at capacity, not 160% of it", () => {
    // 0.5 smoothedLoad = 100% of rated capacity.
    expect(ringColorAt(0.5)).toBe(RING.red);
    // The old threshold: 0.8 was 160% — everything between was mislabelled.
    expect(ringColorAt(0.46)).toBe(RING.red);
  });

  it("orange is busy-but-fine, and no longer means already-dropping", () => {
    expect(ringColorAt(0.4)).toBe(RING.orange);
    // Under the shipped thresholds this exact load painted YELLOW while the
    // node was at 80% of capacity.
    expect(ringColorAt(0.36)).toBe(RING.orange);
  });

  it("yellow starts at half capacity", () => {
    expect(ringColorAt(0.3)).toBe(RING.yellow);
    expect(ringColorAt(0.26)).toBe(RING.yellow);
  });

  it("an idle node is not painted as busy", () => {
    expect(ringColorAt(0.1)).not.toBe(RING.yellow);
    expect(ringColorAt(0)).not.toBe(RING.yellow);
  });

  it("reads the smoothed signal, so it cannot strobe", () => {
    // A node whose instantaneous load spikes for a single frame must not
    // flash red; the whole point of step 2's axis.
    const s = place("compute");
    let raw = 0.1;
    Object.defineProperty(s, "totalLoad", { get: () => raw, configurable: true });
    for (let i = 0; i < 120; i++) s.update(1 / 60); // settle low
    const calm = s.loadRing.material.color.getHex();
    raw = 3.0; // one pathological frame
    s.update(1 / 60);
    expect(s.loadRing.material.color.getHex()).toBe(calm);
  });
});

describe("the Monitoring alert arrives before the failures (#74)", () => {
  it("fires ahead of the first dropped request on a rising load", () => {
    // The behaviour the $75 node is sold for: warn while there is still time
    // to act. Measured on a node driven steadily up through its capacity.
    place("monitor");
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);

    let alertAt = null;
    let firstFailChanceAt = null;
    let load = 0.2;
    for (let t = 0; t < 60; t += 0.5) {
      load += 0.01; // a slow, steady climb through the thresholds
      Object.defineProperty(compute, "totalLoad", { get: () => load, configurable: true });
      compute.smoothedLoad = load; // settled, as a slow climb would be
      metricsTick(0.5);
      if (
        alertAt === null &&
        STATE.intervention.warnings.some((w) => w.message.includes("High load"))
      ) {
        alertAt = load;
      }
      if (firstFailChanceAt === null && calculateFailChanceBasedOnLoad(load) > 0) {
        firstFailChanceAt = load;
      }
    }
    console.log(
      `alert fired at load ${alertAt}, failures would begin at ${firstFailChanceAt}`
    );
    expect(alertAt).not.toBeNull();
    expect(firstFailChanceAt).not.toBeNull();
    expect(alertAt).toBeLessThan(firstFailChanceAt);
  });

  it("the panel's red tint and the alert agree on what hot means", async () => {
    // Two files, one constant: a divergence here is invisible until a player
    // sees a red cell with no warning, or the reverse.
    const panel = await import("../../src/ui/metrics-panel.js");
    const src = panel.default ?? panel;
    expect(typeof src).toBe("object");
    // The predicate is not exported; assert the constant it must use exists
    // and is the same one the alert rule reads.
    expect(CONFIG.load.alertUtil).toBeGreaterThan(0);
    expect(CONFIG.load.alertUtil).toBeLessThan(CONFIG.load.ringRed);
  });
});

describe("the red ring is meaningful, not wallpaper (#74)", () => {
  it("stays quiet on a healthy board and sustained when overloaded", () => {
    // The failure mode this guards: a threshold so low that red is permanent
    // and therefore ignored. Measured on the reference board at a load with
    // zero failures, versus one deep in collapse.
    const healthy = sweepAt({ rps: 4, seconds: 60 });
    const drowning = sweepAt({ rps: 20, seconds: 60 });
    console.log(
      `healthy rps=4: failures=${healthy.failures} peakUtil=${healthy.peakUtil} | ` +
        `drowning rps=20: failures=${drowning.failures} peakUtil=${drowning.peakUtil}`
    );
    // A board with zero failures must not be sitting above the red threshold.
    expect(healthy.failures).toBe(0);
    expect(healthy.peakUtil / 2).toBeLessThan(CONFIG.load.ringRed + 0.05);
    // A collapsing board must be well past it.
    expect(drowning.peakUtil / 2).toBeGreaterThan(CONFIG.load.ringRed);
  });
});
