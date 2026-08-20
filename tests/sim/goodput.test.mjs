// Lateness has a price (#248) — the lesson, machine-proven.
//
// The bug this closes is not a crash, it is a LESSON TAUGHT BACKWARDS.
// Measured on main: a board with a Message Queue in front of a saturated
// Compute scored 0 failures and reputation 100 while requests stood twelve
// seconds in the pipe. In production that board is an outage. Worse,
// src/core/hints.js fires `hint_compute_overload` — "Your Compute nodes are
// overwhelmed. Add a Message Queue to buffer requests." — so the game was
// actively recommending the move that gets people paged.
//
// A queue does not remove load. It converts drops into latency, and past the
// caller's deadline that is the same drop with the bill still paid.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE, CONFIG, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { Request } from "../../src/entities/Request.js";
import { getRollingGoodput, metricsTick, resetMetrics } from "../../src/core/metrics.js";
import { finishRequest } from "../../src/core/actions.js";
import { mulberry32, REFERENCE_MIX, frame } from "../helpers/reference-board.mjs";

beforeEach(() => resetWorld({ gameMode: "survival" }));
afterEach(() => vi.restoreAllMocks());

// The board the hint system tells the player to build, with and without the
// queue it recommends. Everything else is identical.
function board({ withQueue }) {
  resetWorld({ money: 1e9, gameMode: "survival" });
  vi.spyOn(Math, "random").mockImplementation(mulberry32(0x5eed));
  const waf = place("waf");
  const alb = place("alb");
  const compute = place("compute");
  const cache = place("cache");
  const db = place("db");
  const s3 = place("s3");
  const search = place("search");
  const cdn = place("cdn");
  connect("internet", waf);
  connect(waf, alb);
  if (withQueue) {
    const sqs = place("sqs");
    connect(alb, sqs);
    connect(sqs, compute);
  } else {
    connect(alb, compute);
  }
  connect(compute, cache);
  connect(cache, db);
  connect(compute, db);
  connect(compute, s3);
  connect(compute, search);
  // STATIC goes to the edge, as it does on the reference board — without this
  // a quarter of the traffic lands on Compute and the "healthy" board is not.
  connect("internet", cdn);
  connect(cdn, s3);
  STATE.trafficDistribution = { ...REFERENCE_MIX };
  return { compute };
}

function run({ withQueue, rps, seconds = 60 }) {
  board({ withQueue });
  STATE.currentRPS = rps;
  if (!STATE.services.length) throw new Error("board did not build");
  for (let i = 0; i < Math.round(seconds * 60); i++) frame(1 / 60);
  const failures = Object.values(STATE.failures).reduce((a, b) => a + b, 0);
  const processed = STATE.requestsProcessed;
  const late = STATE.lateCompletions || 0;
  const out = {
    processed,
    late,
    failures,
    lateShare: processed ? late / processed : 0,
    // Goodput: completions that were still wanted, over everything the board
    // was asked to do. Throughput counts answers; goodput counts answers
    // someone was still waiting for.
    goodput: processed + failures ? (processed - late) / (processed + failures) : 0,
    reputation: +STATE.reputation.toFixed(1),
  };
  vi.restoreAllMocks();
  return out;
}

describe("a request carries its own game-time age (#248)", () => {
  it("ages by GAME time, so fast-forward does not shorten a wait", () => {
    const req = new Request("READ");
    STATE.requests.push(req);
    for (let i = 0; i < 60; i++) req.update(1 / 60); // one second at 1x
    const atNormal = req.age;

    const req2 = new Request("READ");
    STATE.requests.push(req2);
    for (let i = 0; i < 20; i++) req2.update(3 / 60); // one game-second at 3x
    expect(req2.age).toBeCloseTo(atNormal, 6);
  });

  it("a queued request ages while it waits — it is not free time", () => {
    const compute = place("compute");
    const req = new Request("READ");
    STATE.requests.push(req);
    compute.queue.push(req); // parked, going nowhere
    for (let i = 0; i < 120; i++) req.update(1 / 60);
    expect(req.age).toBeCloseTo(2, 1);
  });
});

describe("a late completion is worth less (#248)", () => {
  function completeAt(age, type = "READ") {
    resetWorld({ gameMode: "survival" });
    const db = place("db");
    const req = new Request(type);
    STATE.requests.push(req);
    req.age = age;
    const before = { money: STATE.money, rep: STATE.reputation };
    finishRequest(req, db.type, db);
    return {
      earned: STATE.money - before.money,
      repDelta: +(STATE.reputation - before.rep).toFixed(4),
      wasLate: req.wasLate === true,
    };
  }

  const SLO = CONFIG.trafficTypes.READ.sloSec;

  it("inside the SLO it pays in full and earns reputation", () => {
    const r = completeAt(SLO - 0.5);
    expect(r.wasLate).toBe(false);
    expect(r.earned).toBeCloseTo(CONFIG.trafficTypes.READ.reward, 5);
    expect(r.repDelta).toBeCloseTo(CONFIG.survival.SCORE_POINTS.SUCCESS_REPUTATION, 5);
  });

  it("past the SLO it still completes, but pays less and COSTS reputation", () => {
    // The whole point: not a failure. The request was served, the customer
    // had gone. STATE.failures must not move.
    const before = { ...STATE.failures };
    const r = completeAt(SLO * 2);
    expect(r.wasLate).toBe(true);
    expect(r.earned).toBeLessThan(CONFIG.trafficTypes.READ.reward);
    expect(r.repDelta).toBeLessThan(0);
    expect(STATE.failures).toEqual(before);
  });

  it("the penalty is a GRADIENT, not a cliff", () => {
    const barely = completeAt(SLO * 1.05).earned;
    const middling = completeAt(SLO * 1.5).earned;
    const hopeless = completeAt(SLO * 3).earned;
    expect(barely).toBeGreaterThan(middling);
    expect(middling).toBeGreaterThan(hopeless);
    // Even a hopelessly late answer is worth serving — shedding it would be
    // worse for the player and would teach the wrong reflex.
    expect(hopeless).toBeGreaterThan(0);
  });

  it("campaign play is untouched — the price is survival-only", () => {
    resetWorld({ gameMode: "campaign" });
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.age = SLO * 5; // catastrophically late
    const before = { money: STATE.money, rep: STATE.reputation };
    finishRequest(req, db.type, db);
    expect(STATE.money - before.money).toBeCloseTo(CONFIG.trafficTypes.READ.reward, 5);
    expect(STATE.reputation - before.rep).toBeCloseTo(
      CONFIG.survival.SCORE_POINTS.SUCCESS_REPUTATION,
      5
    );
    expect(req.wasLate).toBeUndefined();
  });

  it("survival counts each late completion ONCE — the price and the count are separate", () => {
    // The count moved out of the survival-only branch so the campaign could
    // have it too. Leaving a copy behind in that branch double-counts, and
    // the debrief would then report more late requests than were served.
    resetWorld({ gameMode: "survival" });
    const db = place("db");
    for (let i = 0; i < 4; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      req.age = SLO * 2;
      finishRequest(req, db.type, db);
    }
    expect(STATE.lateCompletions).toBe(4);
    expect(STATE.lateCompletions).toBeLessThanOrEqual(STATE.requestsProcessed);
  });

  it("GOODPUT IS A REPORT, NOT A PRICE: it sees lateness in every mode", () => {
    // The headline HUD number read the priced flag (req.wasLate), which is
    // survival-only by design. So the same board — every answer three SLOs
    // late — measured 0% in survival and 100% GREEN in campaign and sandbox.
    // The one number meant to separate "healthy" from "drowning" said the
    // opposite of the truth for two of the three modes.
    const measure = (mode) => {
      resetWorld({ gameMode: mode });
      resetMetrics();
      const db = place("db");
      for (let i = 0; i < 10; i++) {
        const req = new Request("READ");
        STATE.requests.push(req);
        req.age = SLO * 3;
        finishRequest(req, db.type, db);
      }
      metricsTick(0.5);
      return getRollingGoodput();
    };
    const survival = measure("survival");
    const campaign = measure("campaign");
    const sandbox = measure("sandbox");
    expect(survival).toBe(0);
    expect(campaign, "campaign read 100% while every answer was late").toBe(survival);
    expect(sandbox, "sandbox read 100% while every answer was late").toBe(survival);
  });

  it("...and a PUNCTUAL board still reads 100% in every mode", () => {
    // The mirror. A fix that simply buckets everything as late would satisfy
    // the test above and be just as wrong.
    for (const mode of ["survival", "campaign", "sandbox"]) {
      resetWorld({ gameMode: mode });
      resetMetrics();
      const db = place("db");
      for (let i = 0; i < 10; i++) {
        const req = new Request("READ");
        STATE.requests.push(req);
        req.age = SLO - 0.5;
        finishRequest(req, db.type, db);
      }
      metricsTick(0.5);
      expect(getRollingGoodput(), `${mode} punished a board that was on time`).toBe(1);
    }
  });

  it("the PRICE stays survival-only — the report moving must not move balance", () => {
    // pastSlo is the observation; wasLate is what reputation and the SLOW
    // badge read back. If the fix had set wasLate in every mode instead, it
    // would have re-priced twenty-five tuned campaign levels.
    resetWorld({ gameMode: "campaign" });
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.age = SLO * 5;
    const before = { money: STATE.money, rep: STATE.reputation };
    finishRequest(req, db.type, db);
    expect(req.wasLate).toBeUndefined();
    expect(req.pastSlo).toBe(true);
    expect(STATE.money - before.money).toBeCloseTo(CONFIG.trafficTypes.READ.reward, 5);
    expect(STATE.reputation - before.rep).toBeCloseTo(
      CONFIG.survival.SCORE_POINTS.SUCCESS_REPUTATION, 5
    );
  });

  it("...but the campaign DEBRIEF still counts it, or it reports a lie", () => {
    // The price is survival-only on purpose. The COUNT must not be: the
    // debrief divides onTime by processed, so a campaign board where every
    // request stood past its SLO used to report "served N/N on time, 100%"
    // — a true statement about the counter and a false one about the room.
    resetWorld({ gameMode: "campaign" });
    const db = place("db");
    for (let i = 0; i < 3; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      req.age = SLO * 5;
      finishRequest(req, db.type, db);
    }
    const punctual = new Request("READ");
    STATE.requests.push(punctual);
    punctual.age = SLO - 0.5;
    finishRequest(punctual, db.type, db);

    expect(STATE.lateCompletions).toBe(3);
    expect(STATE.requestsProcessed).toBe(4);
    // ...and the counter is inert: nothing in the simulation reads it back,
    // which is what makes counting it in a campaign level safe. The test
    // above this one pins the money and the reputation that prove it.
  });
});

describe("THE LESSON: buffering relocates failure, it does not remove it", () => {
  it("a queue converts drops into lateness — and lateness is now visible", () => {
    const bare = run({ withQueue: false, rps: 8 });
    const queued = run({ withQueue: true, rps: 8 });

    console.log(
      `\nNO QUEUE : processed=${bare.processed} late=${bare.late} ` +
        `(${(bare.lateShare * 100).toFixed(0)}%) failures=${bare.failures} rep=${bare.reputation}` +
        `\nWITH SQS : processed=${queued.processed} late=${queued.late} ` +
        `(${(queued.lateShare * 100).toFixed(0)}%) failures=${queued.failures} rep=${queued.reputation}`
    );

    // The queue really does absorb drops — that part was always true, and it
    // is why the hint recommends it. Measured: 165 failures -> 6.
    expect(queued.failures).toBeLessThan(bare.failures / 5);
    // ...but it pays for them in WAITING, and the waiting is no longer free:
    // measured, 42% of the answers this board gives arrive after the customer
    // stopped waiting. On main that board scored a clean run.
    expect(bare.late).toBe(0); // the unbuffered board drops instead of stalling
    expect(queued.lateShare).toBeGreaterThan(0.35);
  });

  it("a healthy board is never late — the price only bites under saturation", () => {
    // If a well-built board paid this tax, the mechanic would be a flat tax
    // on playing, not a lesson about saturation.
    for (const rps of [2, 4, 6]) {
      const r = run({ withQueue: false, rps, seconds: 30 });
      expect(r.late, `rps=${rps} should have no late completions`).toBe(0);
      expect(r.reputation).toBeGreaterThan(80);
    }
  });

  it("goodput separates a working board from a busy one", () => {
    // Throughput alone cannot tell these apart; that is why it is the wrong
    // number to steer by, and why the game could not show trouble before.
    const healthy = run({ withQueue: true, rps: 4, seconds: 30 });
    const drowning = run({ withQueue: true, rps: 10, seconds: 30 });
    console.log(
      `goodput — healthy(4rps)=${healthy.goodput.toFixed(3)} drowning(10rps)=${drowning.goodput.toFixed(3)}`
    );
    // A healthy buffered board wastes nothing; a drowning one throws away
    // roughly a third of everything it does, while its THROUGHPUT still looks
    // busy — which is exactly why throughput is the wrong number to steer by.
    expect(healthy.goodput).toBeGreaterThan(0.9);
    expect(drowning.goodput).toBeLessThan(healthy.goodput * 0.8);
  });
});
