// The rolling goodput readout (#261).
//
// Reputation is the game's headline number and it is an unbounded integral
// clamped at 100: it reads 100 for a board that is merely coasting, it starts
// every run pinned at the ceiling, and it cannot tell "healthy" from
// "recovering". Goodput is a bounded RATIO over a short window — of everything
// the board was asked to do in the last 30 game seconds, what share was
// answered while someone still wanted it.
//
// #248 is what made it computable: before late completions had a distinct
// outcome, "answered in time" did not exist as a category.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE, resetWorld, place } from "../helpers/sim-world.mjs";
import { CONFIG } from "../../src/config.js";
import {
  getRollingGoodput,
  metricsTick,
  resetMetrics,
} from "../../src/core/metrics.js";
import { failRequest, finishRequest } from "../../src/core/actions.js";
import { FAIL_REASONS } from "../../src/core/failure-reasons.js";
import { Request } from "../../src/entities/Request.js";

const SLO = CONFIG.trafficTypes.READ.sloSec;

beforeEach(() => {
  resetWorld({ gameMode: "survival" });
  resetMetrics();
});
afterEach(() => vi.restoreAllMocks());

// Terminate one request the way the sim does, then roll the sample window.
function serve({ age = 0, fail = false } = {}) {
  const db = STATE.services.find((s) => s.type === "db") || place("db");
  const req = new Request("READ");
  STATE.requests.push(req);
  req.age = age;
  if (fail) failRequest(req, FAIL_REASONS.QUEUE_FULL);
  else finishRequest(req, db.type, db);
}

function roll(samples = 1) {
  for (let i = 0; i < samples; i++) metricsTick(0.5);
}

describe("goodput is a bounded ratio, not an integral (#261)", () => {
  it("reads null on an idle board — silence is not success", () => {
    // The precise failure it must not repeat: reputation says 100 when
    // nothing has happened, which is the least informative moment possible.
    roll(4);
    expect(getRollingGoodput()).toBeNull();
  });

  it("is 1.0 when every request is answered in time", () => {
    for (let i = 0; i < 10; i++) serve({ age: SLO - 1 });
    roll();
    expect(getRollingGoodput()).toBe(1);
  });

  it("counts a LATE completion against you, though it is not a failure", () => {
    // The distinction the whole #248 line of work exists to make: served, but
    // after the customer left. STATE.failures stays at zero here.
    const before = { ...STATE.failures };
    for (let i = 0; i < 5; i++) serve({ age: SLO - 1 });
    for (let i = 0; i < 5; i++) serve({ age: SLO * 2 });
    roll();
    expect(getRollingGoodput()).toBeCloseTo(0.5, 6);
    expect(STATE.failures).toEqual(before);
  });

  it("counts drops in the denominator", () => {
    // Otherwise a board that drops everything and serves three requests fast
    // would proudly report 100%.
    for (let i = 0; i < 3; i++) serve({ age: SLO - 1 });
    for (let i = 0; i < 7; i++) serve({ fail: true });
    roll();
    expect(getRollingGoodput()).toBeCloseTo(0.3, 6);
  });

  it("is bounded to 0..1 whatever happens", () => {
    for (let i = 0; i < 200; i++) serve({ fail: true });
    roll();
    const g = getRollingGoodput();
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
  });
});

describe("the window actually rolls (#261)", () => {
  it("forgets a bad patch after the window passes", () => {
    // The point of a WINDOW: a board that was drowning and then recovered
    // must be able to show it, which reputation structurally cannot — it only
    // climbs back at +0.1 per request.
    for (let i = 0; i < 20; i++) serve({ fail: true });
    roll();
    expect(getRollingGoodput()).toBe(0);

    // 30 game seconds of clean serving = 60 samples at 2 Hz.
    for (let s = 0; s < 60; s++) {
      serve({ age: SLO - 1 });
      roll();
    }
    expect(getRollingGoodput()).toBe(1);
  });

  it("resets with the run", () => {
    for (let i = 0; i < 5; i++) serve({ fail: true });
    roll();
    expect(getRollingGoodput()).toBe(0);
    resetMetrics();
    expect(getRollingGoodput()).toBeNull();
  });
});

describe("it says something reputation cannot (#261)", () => {
  it("separates a coasting board from a recovering one", () => {
    // Both boards sit at the same reputation ceiling; only goodput can tell
    // you which one just came out of trouble.
    STATE.reputation = 100;
    roll(4);
    const coasting = getRollingGoodput();

    resetMetrics();
    for (let i = 0; i < 10; i++) serve({ age: SLO * 2 }); // all late
    roll();
    const struggling = getRollingGoodput();

    expect(coasting).toBeNull(); // nothing happening
    expect(struggling).toBe(0); // busy, and every answer wasted
    expect(STATE.reputation).toBeGreaterThan(0); // reputation cannot tell them apart yet
  });
});
