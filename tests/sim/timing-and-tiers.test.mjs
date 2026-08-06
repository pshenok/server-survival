// Three shipped bugs where a promise in the UI disagreed with the simulation
// (#242). Each test below fails on the code as it was:
//
//   1. Memory Cache tier upgrades bought capacity only. The handler rolled
//      `job.req.cacheHitRate` — a per-traffic-type constant — so a $180 tier-3
//      cache had exactly the hit rate of a free tier-1 one, while the tooltip
//      and `cache_desc_long` ("Upgrade tiers for higher hit rates") sold the
//      upgrade. The CDN handler had always read the SERVICE's rate; this is
//      Memory Cache matching it.
//   2. Random events expired on the wall clock (Date.now()), so they kept
//      running while the game was paused and lasted 3x their advertised
//      duration in game time at timeScale 3. The achievements-proof harness
//      documented this in a comment as untestable — it is testable now.
//   3. The survival ramp smoothed toward its target by a per-FRAME constant,
//      so the traffic a player faced at a given elapsed time depended on their
//      monitor's refresh rate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import {
  endRandomEvent,
  triggerRandomEvent,
  updateRandomEvents,
} from "../../src/core/events.js";
import { calculateTargetRPS, smoothTowardsRPS } from "../../game.js";
import {
  STATE,
  CONFIG,
  resetWorld,
  place,
  connect,
  run,
} from "../helpers/sim-world.mjs";

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- cache tiers

describe("Memory Cache tier upgrades actually change the hit rate (#242)", () => {
  function cacheWorld() {
    const alb = place("alb");
    const compute = place("compute");
    const cache = place("cache");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, cache);
    connect(cache, db);
    return { cache, db };
  }

  // Rolls one READ through a cache pinned at `quality` and reports whether it
  // was served from cache. Math.random is pinned AFTER world building so
  // service-id generation keeps its own entropy (the house rule). The world is
  // rebuilt per roll because these tests compare two tiers in one `it` — a
  // second cacheWorld() on a live board leaves the first cache wired up and
  // the request goes there instead.
  function rollRead(quality, roll) {
    vi.restoreAllMocks();
    resetWorld();
    const { cache } = cacheWorld();
    if (quality !== null) cache.config = { ...cache.config, cacheHitRate: quality };
    const req = new Request("READ");
    STATE.requests.push(req);
    routeRequestToEntry(req, "READ");
    vi.spyOn(Math, "random").mockReturnValue(roll);
    run(10);
    return req.cached === true;
  }

  const TIERS = CONFIG.services.cache.tiers;
  const READ = CONFIG.trafficTypes.READ.cacheHitRate; // 0.4

  it("tier 1 is bit-for-bit the old behaviour — the traffic type's own rate", () => {
    // This is the test that protects all 25 shipped campaign levels: they
    // never pre-build an upgraded cache, so if tier 1 still rolls exactly
    // READ's 0.4 their balance cannot have moved.
    expect(TIERS[0].cacheHitRate).toBe(CONFIG.services.cache.cacheHitRate);
    expect(rollRead(TIERS[0].cacheHitRate, READ - 0.01)).toBe(true);
    expect(rollRead(TIERS[0].cacheHitRate, READ + 0.01)).toBe(false);
  });

  it("tier 3 serves a READ the old code would have sent to the DB", () => {
    // 0.6 is a miss at tier 1 (0.4) and a hit at tier 3 (0.4 * 0.65/0.35 =
    // 0.74). Before the fix both tiers missed — the upgrade did nothing.
    expect(rollRead(TIERS[0].cacheHitRate, 0.6)).toBe(false);
    expect(rollRead(TIERS[2].cacheHitRate, 0.6)).toBe(true);
  });

  it("tier 2 sits strictly between them", () => {
    expect(rollRead(TIERS[1].cacheHitRate, 0.5)).toBe(true); // 0.57 > 0.5
    expect(rollRead(TIERS[1].cacheHitRate, 0.6)).toBe(false); // 0.57 < 0.6
  });

  it("caps below certainty so a tier-3 cache never retires the origin", () => {
    // STATIC is 0.9 cacheable; unclamped, tier 3 would put it at 1.67 and no
    // STATIC request would ever reach Storage again.
    const { cache } = cacheWorld();
    cache.config = { ...cache.config, cacheHitRate: TIERS[2].cacheHitRate };
    const req = new Request("STATIC");
    STATE.requests.push(req);
    req.flyTo(cache);
    vi.spyOn(Math, "random").mockReturnValue(0.96); // above the 0.95 cap
    run(10);
    expect(req.cached).toBe(false);
  });

  it("no tier makes non-cacheable traffic cacheable", () => {
    const { cache } = cacheWorld();
    cache.config = { ...cache.config, cacheHitRate: TIERS[2].cacheHitRate };
    const req = new Request("WRITE"); // cacheHitRate 0, isCacheable false
    STATE.requests.push(req);
    req.flyTo(cache);
    vi.spyOn(Math, "random").mockReturnValue(0.0); // would hit if it rolled
    run(10);
    expect(req.cached).toBe(false);
    expect(STATE.requestsProcessed).toBe(1); // forwarded to the db, not lost
  });
});

// -------------------------------------------------------------- event timing

describe("random events expire on game time, not the wall clock (#242)", () => {
  beforeEach(() => {
    resetWorld({ gameMode: "survival" });
    STATE.intervention = {
      trafficShiftTimer: 0,
      trafficShiftActive: false,
      currentShift: null,
      originalTrafficDist: null,
      randomEventTimer: 0,
      activeEvent: null,
      eventEndTime: 0,
      currentMilestoneIndex: 0,
      rpsMultiplier: 1.0,
      recentEvents: [],
      warnings: [],
      costMultiplier: 1.0,
      trafficBurstMultiplier: 1.0,
    };
  });

  afterEach(() => {
    if (STATE.intervention?.activeEvent) endRandomEvent();
  });

  it("does not expire while game time stands still, however long the wall clock runs", () => {
    STATE.elapsedGameTime = 100;
    triggerRandomEvent("COST_SPIKE", 30000);
    expect(STATE.intervention.activeEvent).toBe("COST_SPIKE");

    // A paused game: real seconds pass (many update ticks), game time doesn't.
    const realStart = Date.now();
    while (Date.now() - realStart < 25) updateRandomEvents(0);
    expect(STATE.intervention.activeEvent).toBe("COST_SPIKE");
  });

  it("expires after exactly its duration in GAME seconds", () => {
    STATE.elapsedGameTime = 100;
    triggerRandomEvent("COST_SPIKE", 30000);

    STATE.elapsedGameTime = 129.9; // 29.9s in
    updateRandomEvents(0);
    expect(STATE.intervention.activeEvent).toBe("COST_SPIKE");

    STATE.elapsedGameTime = 130.1; // past 30s
    updateRandomEvents(0);
    expect(STATE.intervention.activeEvent).toBe(null);
  });

  it("a fast-forwarded outage lasts its 30 game seconds, not 90", () => {
    // The bug: at timeScale 3 the deadline was 30 WALL seconds away, which is
    // 90 seconds of game time — the player was punished three times over.
    const db = place("db");
    STATE.elapsedGameTime = 0;
    triggerRandomEvent("SERVICE_OUTAGE", 30000, db.id);
    expect(db.isDisabled).toBe(true);

    // 10 real seconds at timeScale 3 = 30 game seconds.
    STATE.elapsedGameTime = 30.1;
    updateRandomEvents(0);
    expect(STATE.intervention.activeEvent).toBe(null);
    expect(db.isDisabled).toBe(false);
  });
});

// ------------------------------------------------- session boundary (restart)

describe("a live event does not survive into the next run (#242)", () => {
  // Caught by adversarial review of the fix above, and it was a REGRESSION the
  // fix introduced: resetGame() zeroes elapsedGameTime but never touched
  // STATE.intervention, so a game-time deadline from the dead run
  // (elapsed 400 + 30) was suddenly measured against a clock restarting at 0.
  // A player who died mid-TRAFFIC_BURST and hit Restart played the whole next
  // run at 3x traffic. Under the old wall clock the same stranded event
  // cleared itself within 30 real seconds, so this had to be fixed at the
  // source: the run boundary now ends the event and reverses its effects.
  it("Restart clears the event and its effects", async () => {
    const { resetGame } = await import("../../game.js");
    resetWorld({ gameMode: "survival" });
    STATE.intervention = {
      trafficShiftTimer: 0, trafficShiftActive: false, currentShift: null,
      originalTrafficDist: null, randomEventTimer: 0, activeEvent: null,
      eventEndTime: 0, currentMilestoneIndex: 0, rpsMultiplier: 1.0,
      recentEvents: [], warnings: [], costMultiplier: 1.0,
      trafficBurstMultiplier: 1.0,
    };
    STATE.animationId = 1; // keep resetGame from starting a real rAF loop
    STATE.elapsedGameTime = 400;
    triggerRandomEvent("TRAFFIC_BURST", 30000);
    expect(STATE.intervention.trafficBurstMultiplier).toBeGreaterThan(1);

    resetGame("survival");

    expect(STATE.intervention.activeEvent).toBe(null);
    expect(STATE.intervention.trafficBurstMultiplier).toBe(1);
    expect(STATE.intervention.costMultiplier).toBe(1);
    expect(STATE.intervention.eventEndTime).toBe(0);

    // And the fresh run stays clean as its clock advances past the old deadline.
    STATE.elapsedGameTime = 200;
    updateRandomEvents(0);
    expect(STATE.intervention.trafficBurstMultiplier).toBe(1);
  });

  it("a COST_SPIKE does not bill the next run", async () => {
    const { resetGame } = await import("../../game.js");
    resetWorld({ gameMode: "survival" });
    STATE.intervention = {
      randomEventTimer: 0, activeEvent: null, eventEndTime: 0,
      recentEvents: [], warnings: [], costMultiplier: 1.0,
      trafficBurstMultiplier: 1.0, currentMilestoneIndex: 0, rpsMultiplier: 1.0,
    };
    STATE.animationId = 1;
    STATE.elapsedGameTime = 250;
    triggerRandomEvent("COST_SPIKE", 30000);
    expect(STATE.intervention.costMultiplier).toBeGreaterThan(1);

    resetGame("survival");
    expect(STATE.intervention.costMultiplier).toBe(1);
  });
});

// ----------------------------------------------------------------- ramp math

describe("the survival ramp is frame-rate independent (#242)", () => {
  it("one 60 fps frame still closes 1% of the gap (shipped feel preserved)", () => {
    expect(smoothTowardsRPS(0, 100, 1 / 60)).toBeCloseTo(1, 9);
  });

  it("one second of game time lands identically at 60, 144 and 30 fps", () => {
    const target = 50;
    const advance = (fps) => {
      let rps = 2;
      for (let i = 0; i < fps; i++) rps = smoothTowardsRPS(rps, target, 1 / fps);
      return rps;
    };
    const at60 = advance(60);
    expect(advance(144)).toBeCloseTo(at60, 6);
    expect(advance(30)).toBeCloseTo(at60, 6);
  });

  it("a big fast-forward step matches many small ones (timeScale safety)", () => {
    // dt carries timeScale, so a 3x frame must not overshoot the target the
    // way a linear per-frame constant would.
    let stepwise = 2;
    for (let i = 0; i < 30; i++) stepwise = smoothTowardsRPS(stepwise, 50, 0.1);
    expect(smoothTowardsRPS(2, 50, 3)).toBeCloseTo(stepwise, 6);
  });

  it("never overshoots its target", () => {
    expect(smoothTowardsRPS(2, 50, 1000)).toBeLessThanOrEqual(50);
    expect(smoothTowardsRPS(80, 50, 1000)).toBeGreaterThanOrEqual(50);
  });

  it("the ramp target is the real shipped curve, not a copy", () => {
    // achievements-proofs.test.mjs re-derived this by hand; now the export
    // exists, a drift in game.js can be caught instead of mirrored.
    const base = CONFIG.survival.baseRPS;
    expect(calculateTargetRPS(0)).toBeCloseTo(base, 6);
    expect(calculateTargetRPS(60)).toBeGreaterThan(calculateTargetRPS(30));
  });
});
