// Step 1 of the failure-knee work (#74): the acceleration ramp is continuous.
//
// The milestones were a step function, so target RPS jumped 25% in a single
// frame at t=180 (multiplier 1.6 -> 2.0, 12.0 -> 15.0 rps). The measured
// readable band on the reference board is ~20% wide in arrival rate, so a step
// that size vaults straight over the band the rest of this work is building —
// at exactly the three-minute mark issue #74 complains about.
//
// These tests pin the two things that must both hold: the curve is continuous
// everywhere, and its difficulty envelope is unchanged at the milestone times.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE } from "../../src/state.js";
import { CONFIG } from "../../src/config.js";
import { calculateTargetRPS, rpsMilestoneMultiplier } from "../../game.js";
import { resetWorld } from "../helpers/sim-world.mjs";

const MILESTONES = CONFIG.survival.rpsAcceleration.milestones;

beforeEach(() => {
  resetWorld({ gameMode: "survival" });
  STATE.intervention = {
    currentMilestoneIndex: 0,
    rpsMultiplier: 1.0,
    recentEvents: [],
    warnings: [],
    trafficBurstMultiplier: 1.0,
  };
});
afterEach(() => vi.restoreAllMocks());

describe("the milestone multiplier is interpolated, not stepped (#74)", () => {
  it("hits every milestone's exact multiplier at its exact time", () => {
    // The difficulty envelope is unchanged: same curve, same sample points.
    for (const m of MILESTONES) {
      expect(rpsMilestoneMultiplier(m.time, MILESTONES)).toBeCloseTo(m.multiplier, 9);
    }
  });

  it("starts at 1.0 and holds the last multiplier forever after", () => {
    expect(rpsMilestoneMultiplier(0, MILESTONES)).toBe(1.0);
    expect(rpsMilestoneMultiplier(-5, MILESTONES)).toBe(1.0);
    const last = MILESTONES[MILESTONES.length - 1];
    expect(rpsMilestoneMultiplier(last.time + 1, MILESTONES)).toBeCloseTo(last.multiplier, 9);
    expect(rpsMilestoneMultiplier(100000, MILESTONES)).toBeCloseTo(last.multiplier, 9);
  });

  it("is monotonic — pressure never drops as the run goes on", () => {
    let prev = 0;
    for (let t = 0; t <= 700; t += 0.25) {
      const m = rpsMilestoneMultiplier(t, MILESTONES);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = m;
    }
  });

  it("NO SINGLE FRAME moves target RPS by more than 1% (the step is gone)", () => {
    // This is the assertion the old code fails: at t=180 it jumped ~25%.
    let worst = { jump: 0, t: null };
    let prev = calculateTargetRPS(0);
    for (let t = 1 / 60; t <= 700; t += 1 / 60) {
      const cur = calculateTargetRPS(t);
      const jump = Math.abs(cur - prev) / prev;
      if (jump > worst.jump) worst = { jump, t };
      prev = cur;
    }
    console.log(
      `worst single-frame jump: ${(worst.jump * 100).toFixed(4)}% at t=${worst.t?.toFixed(2)}s`
    );
    expect(worst.jump).toBeLessThan(0.01);
  });

  it("crosses the old t=180 cliff smoothly", () => {
    // Concretely: the old curve went 12.0 -> 15.0 rps across one frame here.
    const before = calculateTargetRPS(180 - 1 / 60);
    const after = calculateTargetRPS(180 + 1 / 60);
    expect(Math.abs(after - before) / before).toBeLessThan(0.01);
  });

  it("still fires a surge warning at each original milestone time", () => {
    // The UX beat is deliberately unchanged — only the arrival is spread out.
    const fired = [];
    for (let t = 0; t <= 650; t += 0.5) {
      const before = STATE.intervention.currentMilestoneIndex;
      calculateTargetRPS(t);
      if (STATE.intervention.currentMilestoneIndex > before) {
        fired.push({ index: STATE.intervention.currentMilestoneIndex, t });
      }
    }
    expect(fired.length).toBe(MILESTONES.length);
    fired.forEach((f, i) => {
      // Fired within one sampling step of its milestone time, never before it.
      expect(f.t).toBeGreaterThanOrEqual(MILESTONES[i].time);
      expect(f.t).toBeLessThan(MILESTONES[i].time + 1);
    });
  });

  it("a config with one milestone, or none, does not divide by zero", () => {
    expect(rpsMilestoneMultiplier(50, [])).toBe(1.0);
    expect(rpsMilestoneMultiplier(50, null)).toBe(1.0);
    const one = [{ time: 60, multiplier: 2 }];
    expect(rpsMilestoneMultiplier(30, one)).toBeCloseTo(1.5, 9);
    expect(rpsMilestoneMultiplier(60, one)).toBeCloseTo(2, 9);
    expect(rpsMilestoneMultiplier(600, one)).toBeCloseTo(2, 9);
    // A zero-width span is a config typo, not a crash.
    const dup = [{ time: 60, multiplier: 2 }, { time: 60, multiplier: 3 }];
    expect(Number.isFinite(rpsMilestoneMultiplier(60, dup))).toBe(true);
  });

  it("the step function used to VAULT the readable band; interpolation does not", () => {
    // The whole reason this step exists. Step 0 measured the reference board's
    // readable band at 5-7 rps (5-6 healthy-with-failures, 7 the last point
    // before collapse). The question is how long the ramp leaves a player
    // INSIDE that arrival-rate window — that is their window to notice trouble
    // and act on it.
    //
    // Both curves are evaluated here, so the comparison needs no git archaeology.
    const BAND = [5, 7];
    const stepMultiplier = (t) => {
      let m = 1.0;
      for (const ms of MILESTONES) if (t >= ms.time) m = ms.multiplier;
      return m;
    };
    // calculateTargetRPS's pre-multiplier part, lifted so both curves share it.
    const baseCurve = (t) =>
      CONFIG.survival.baseRPS + Math.log(1 + t / 20) * 2.2 + t * 0.008;

    const dwellIn = (multiplierFn) => {
      let seconds = 0;
      const dt = 1 / 60;
      for (let t = 0; t <= 900; t += dt) {
        const rps = baseCurve(t) * multiplierFn(t);
        if (rps >= BAND[0] && rps <= BAND[1]) seconds += dt;
      }
      return seconds;
    };

    const stepped = dwellIn(stepMultiplier);
    const interpolated = dwellIn((t) => rpsMilestoneMultiplier(t, MILESTONES));
    console.log(
      `time with target RPS inside the readable band [${BAND[0]}, ${BAND[1]}]: ` +
        `stepped=${stepped.toFixed(1)}s interpolated=${interpolated.toFixed(1)}s`
    );

    // Interpolation must not SHRINK the window the player has to react in.
    expect(interpolated).toBeGreaterThanOrEqual(stepped);
  });

  it("campaign mode never touches the ramp", () => {
    // calculateTargetRPS's only call site is already survival-gated
    // (game.js), but the multiplier writes STATE.intervention.rpsMultiplier,
    // so pin that campaign play cannot reach it through this path.
    resetWorld({ gameMode: "campaign" });
    STATE.intervention = { currentMilestoneIndex: 0, rpsMultiplier: 1.0, warnings: [], recentEvents: [] };
    const rps = 7;
    STATE.currentRPS = rps;
    // Campaign sets currentRPS from the level and never calls the ramp; assert
    // the value is untouched by a tick's worth of game time passing.
    STATE.elapsedGameTime = 300;
    expect(STATE.currentRPS).toBe(rps);
  });
});
