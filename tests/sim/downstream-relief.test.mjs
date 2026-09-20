// Where does a data-tier choice actually land? (#285)
//
// The claim in #285 is that a cache/replica/nosql choice "cannot relieve
// Compute" because the sim frees Compute's slot the instant it forwards a
// request downstream (Service.update splices the job out of `processing` and
// returns before the downstream node runs). Measured here, that claim is half
// right, and the other half decides how #285 should — and should not — be fixed.
//
// Three facts, all machine-checked below:
//
//   1. A cache DOES relieve the DATA tier. With a cache in front of it the DB
//      carries ~30% less load — the cache absorbs the ~40% of READs that hit.
//      So the data-tier choice is NOT inert; it reaches the data tier.
//
//   2. A cache does NOT relieve the APP tier. Compute's own load is the same
//      to within noise whether or not a cache sits downstream, because Compute
//      lets go of the request the moment it forwards it. This is #285's core
//      observation, and it is real.
//
//   3. There is no arrival rate at which the DB is the bottleneck. Below
//      Compute's throughput ceiling the DB is comfortable; ABOVE it Compute
//      saturates, fails traffic at its own door, and the DB is STARVED — its
//      load falls as arrival rises. So no amount of rps tuning can make a
//      DB-load objective bind on the cache the way L3's spike made the CDN
//      bind (#254). The lever L3/L9 used is not available here.
//
// Together these say the fix for the hollow data-tier levels (#285) is NOT
// arrival tuning and NOT (necessarily) the expensive "Compute holds its slot
// until the downstream answers" engine rewrite. The signal a cache genuinely
// produces is END-TO-END LATENCY (a cached READ completes in ~50ms where a DB
// round trip is ~300ms), which the goodput/SLO machinery from #248 already
// computes. Grading data-tier levels on that, rather than on node load, is the
// cheap lever that carries the choice without touching the core loop.
//
// This file is the evidence for that decision, pinned so it cannot rot. If the
// engine is ever changed so downstream latency feeds back into Compute
// occupancy, fact 2 flips — and that is exactly the signal to revisit the
// grading question.
import { describe, it, expect, afterEach, vi } from "vitest";
import { STATE, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { mulberry32, frame } from "../helpers/reference-board.mjs";

afterEach(() => vi.restoreAllMocks());

// READ-heavy so the data tier is the whole story. A pinch of MALICIOUS keeps
// the WAF honest; no STATIC/UPLOAD so nothing competes for the DB path.
const READ_MIX = { STATIC: 0, READ: 0.85, WRITE: 0.1, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05 };

// waf -> alb -> compute -> db, optionally with compute -> cache -> db in
// front. Compute is upgraded in BOTH arms so it is never the variable under
// test: the only difference is whether a cache sits between Compute and the DB.
function run({ withCache, rps, seconds = 40, seed = 0x5eed }) {
  resetWorld({ money: 1e9, gameMode: "survival" });
  vi.spyOn(Math, "random").mockImplementation(mulberry32(seed));
  const waf = place("waf");
  const alb = place("alb");
  const compute = place("compute");
  const db = place("db");
  connect("internet", waf);
  connect(waf, alb);
  connect(alb, compute);
  if (withCache) {
    const cache = place("cache");
    connect(compute, cache);
    connect(cache, db);
  }
  connect(compute, db);
  compute.upgrade(); // tier 2 in both arms — Compute is held constant
  STATE.trafficDistribution = { ...READ_MIX };
  STATE.currentRPS = rps;
  for (let i = 0; i < Math.round(seconds * 60); i++) frame(1 / 60);
  return {
    computeLoad: compute.smoothedLoad || 0,
    dbLoad: db.smoothedLoad || 0,
  };
}

describe("a cache relieves the data tier but not the app tier (#285)", () => {
  it("1. the DB carries meaningfully less load when a cache fronts it", () => {
    // Measured ~0.12 with vs ~0.18 without at rps 10; assert a ≥15% relief,
    // well inside that margin, so the fact is pinned without pinning noise.
    const withCache = run({ withCache: true, rps: 10 });
    const noCache = run({ withCache: false, rps: 10 });
    expect(withCache.dbLoad).toBeLessThan(noCache.dbLoad * 0.85);
  });

  it("2. Compute's load is unchanged by the cache — it lets go on forward", () => {
    // The #285 core fact. Compute frees its slot the instant it forwards, so
    // the downstream choice never reaches it. If the engine is ever changed to
    // hold the slot until the downstream answers, this assertion flips — the
    // intended signal to revisit how data-tier levels are graded.
    const withCache = run({ withCache: true, rps: 10 });
    const noCache = run({ withCache: false, rps: 10 });
    expect(Math.abs(withCache.computeLoad - noCache.computeLoad)).toBeLessThan(0.06);
  });

  it("3. no arrival rate makes the DB the bottleneck — Compute starves it first", () => {
    // Below Compute's ceiling the DB is comfortable; above it Compute
    // saturates and fails traffic at its own door, so LESS reaches the DB.
    // The DB's load therefore FALLS as arrival rises — the opposite of a
    // bottleneck. This is why rps tuning (the L3/L9 lever) cannot make a
    // DB-load objective bind here.
    const calm = run({ withCache: false, rps: 10 });
    const flooded = run({ withCache: false, rps: 44 });
    expect(flooded.dbLoad).toBeLessThan(calm.dbLoad * 0.5);
  });
});
