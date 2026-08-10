// Step 2 of the failure-knee work (#74): the smoothed load signal.
//
// Step 0 measured why this exists: `totalLoad`'s numerator is an integer job
// count, so on a tier-1 Compute it can only be 0.75, 1.00 or 1.25, and its mean
// dwell inside the band the knee cares about never exceeded 0.245 s at any
// load. A threshold on that signal describes a strobe. `smoothedLoad` is the
// same quantity through a trailing exponential mean.
//
// This step adds the signal and NOTHING reads it yet, so the acceptance bar is
// deliberately harsh: the rest of the suite must stay green with zero changed
// assertions. If something moved, a consumer already existed and that is a bug,
// not a test to update.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE, CONFIG, resetWorld, place, connect, run } from "../helpers/sim-world.mjs";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import { mulberry32 } from "../helpers/reference-board.mjs";

const TAU = CONFIG.load.smoothingTau;

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

// Drive one service's smoothing in isolation by pinning totalLoad, so the test
// measures the filter rather than the whole simulation around it.
function pin(service, value) {
  Object.defineProperty(service, "totalLoad", {
    get: () => value,
    configurable: true,
  });
}

describe("smoothedLoad is a correct trailing mean (#74)", () => {
  it("starts cold at zero on a freshly placed service", () => {
    const s = place("compute");
    expect(s.smoothedLoad).toBe(0);
  });

  it("reaches ~63% of a step after exactly tau, and ~95% after 3 tau", () => {
    // The defining property of an exponential mean: 1 - 1/e after one tau.
    const s = place("compute");
    pin(s, 1.0);
    for (let t = 0; t < TAU; t += 1 / 60) s.update(1 / 60);
    expect(s.smoothedLoad).toBeGreaterThan(0.6);
    expect(s.smoothedLoad).toBeLessThan(0.68);

    for (let t = 0; t < 2 * TAU; t += 1 / 60) s.update(1 / 60);
    expect(s.smoothedLoad).toBeGreaterThan(0.93);
    expect(s.smoothedLoad).toBeLessThan(0.99);
  });

  it("converges to a steady load and never overshoots it", () => {
    const s = place("compute");
    pin(s, 0.8);
    for (let t = 0; t < 10 * TAU; t += 1 / 60) {
      s.update(1 / 60);
      expect(s.smoothedLoad).toBeLessThanOrEqual(0.8 + 1e-9);
    }
    expect(s.smoothedLoad).toBeCloseTo(0.8, 3);
  });

  it("decays back toward zero when the load goes away", () => {
    const s = place("compute");
    pin(s, 1.0);
    for (let t = 0; t < 5 * TAU; t += 1 / 60) s.update(1 / 60);
    expect(s.smoothedLoad).toBeGreaterThan(0.95);

    pin(s, 0);
    for (let t = 0; t < 3 * TAU; t += 1 / 60) s.update(1 / 60);
    expect(s.smoothedLoad).toBeLessThan(0.06);
  });

  it("tracks by GAME time, so fast-forward is not an advantage", () => {
    // The bug this forbids: a per-frame constant would make the signal move
    // 3x faster at timeScale 3 and differ between a 60 Hz and a 144 Hz screen.
    const advance = (dt, seconds) => {
      resetWorld();
      const s = place("compute");
      pin(s, 1.0);
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) s.update(dt);
      return s.smoothedLoad;
    };
    // The exponential alpha is EXACTLY step-size invariant, so these agree to
    // floating-point noise rather than merely "closely" — asserted at 9
    // decimals, which the naive linear alpha (dt/tau) fails by 0.0005.
    const at60 = advance(1 / 60, 5);
    const at144 = advance(1 / 144, 5);
    const fastForward = advance(3 / 60, 5); // timeScale 3: dt is 3x per frame
    const oneBigStep = advance(5, 5); // the whole interval in a single frame
    expect(at144).toBeCloseTo(at60, 9);
    expect(fastForward).toBeCloseTo(at60, 9);
    expect(oneBigStep).toBeCloseTo(at60, 9);
  });

  it("a pathological frame cannot overshoot the target", () => {
    // No clamp is needed: e^(-dt/tau) > 0 for every finite dt, so the signal
    // approaches the target from below and never crosses it.
    const s = place("compute");
    pin(s, 1.0);
    s.update(60); // a 60-second frame
    expect(s.smoothedLoad).toBeLessThanOrEqual(1.0);
    expect(s.smoothedLoad).toBeCloseTo(1.0, 6);
  });

  it("is smoother than the raw signal it follows — the point of the step", () => {
    // A real board, not a pinned value: measure how much each signal jumps
    // frame to frame while traffic churns through a saturated node.
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);

    let rawJumps = 0;
    let smoothJumps = 0;
    let prevRaw = compute.totalLoad;
    let prevSmooth = compute.smoothedLoad;
    let spawnTimer = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 20; i++) {
      spawnTimer += dt;
      while (spawnTimer >= 1 / 8) {
        spawnTimer -= 1 / 8;
        const req = new Request("READ");
        STATE.requests.push(req);
        routeRequestToEntry(req, "READ");
      }
      STATE.services.forEach((s) => s.update(dt));
      STATE.requests.slice().forEach((r) => r.update(dt));
      rawJumps += Math.abs(compute.totalLoad - prevRaw);
      smoothJumps += Math.abs(compute.smoothedLoad - prevSmooth);
      prevRaw = compute.totalLoad;
      prevSmooth = compute.smoothedLoad;
    }
    console.log(
      `total frame-to-frame variation over 20s — raw: ${rawJumps.toFixed(2)}, smoothed: ${smoothJumps.toFixed(2)}`
    );
    expect(rawJumps).toBeGreaterThan(0); // the raw signal really is churning
    expect(smoothJumps).toBeLessThan(rawJumps);
  });

  it("nothing reads it yet: pinning it to nonsense changes no outcome", () => {
    // The inertness proof for this step. If a consumer existed, forcing the
    // signal to an absurd value would move something.
    const build = () => {
      const alb = place("alb");
      const compute = place("compute");
      const db = place("db");
      connect("internet", alb);
      connect(alb, compute);
      connect(compute, db);
      return { compute };
    };

    resetWorld();
    build();
    // Pin the PRNG after world building (service ids draw from it) so the two
    // runs differ only in the forced signal. Without this the comparison is
    // just two samples of a random process and fails at random.
    vi.spyOn(Math, "random").mockImplementation(mulberry32(0xc0ffee));
    for (let i = 0; i < 40; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      routeRequestToEntry(req, "READ");
    }
    run(20);
    const normal = {
      processed: STATE.requestsProcessed,
      failures: { ...STATE.failures },
      reputation: STATE.reputation,
      money: STATE.money,
    };

    vi.restoreAllMocks();
    resetWorld();
    const { compute } = build();
    // Force the smoothed signal far past anything the sim could produce.
    Object.defineProperty(compute, "smoothedLoad", {
      get: () => 99,
      set: () => {},
      configurable: true,
    });
    vi.spyOn(Math, "random").mockImplementation(mulberry32(0xc0ffee));
    for (let i = 0; i < 40; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      routeRequestToEntry(req, "READ");
    }
    run(20);

    expect(STATE.requestsProcessed).toBe(normal.processed);
    expect(STATE.failures).toEqual(normal.failures);
    expect(STATE.reputation).toBe(normal.reputation);
    expect(STATE.money).toBe(normal.money);
  });
});
