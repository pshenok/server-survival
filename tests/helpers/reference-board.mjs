// The reference board and sweep runner for the failure-knee work (#74).
//
// This exists because the pre-implementation critique produced five different
// "reference boards" and five different collapse points (10-20 rps). A board
// described in prose is not a measurement. Everything the knee design claims
// is measured against THIS file: same wiring, same tiers, same traffic mix,
// same seeded PRNG, same frame loop.
//
// The frame loop mirrors game.js's animate() in its order and its scaling, so
// a sweep measures the game the player plays, not a reimplementation of it:
// services update, then requests move, then the spawner runs on game-scaled
// dt, then the reputation clamp animate() applies every frame.

import { vi } from "vitest";
import { STATE } from "../../src/state.js";
import { CONFIG } from "../../src/config.js";
import { spawnRequest } from "../../src/core/actions.js";
import { connect, place, resetWorld } from "./sim-world.mjs";

// Deterministic PRNG (mulberry32), the house standard — service ids, traffic
// mix, cache hits and failure rolls all draw from Math.random, so a sweep is
// only reproducible with this pinned.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The traffic mix. Fixed here rather than taken from CONFIG so that a balance
// tweak to survival's starting mix cannot silently move every baseline in the
// knee work. MALICIOUS is included because the WAF is on the board and the
// reputation arithmetic depends on it.
export const REFERENCE_MIX = {
  STATIC: 0.25,
  READ: 0.4,
  WRITE: 0.1,
  UPLOAD: 0.05,
  SEARCH: 0.1,
  MALICIOUS: 0.1,
  INFERENCE: 0,
};

// The board a competent player HAS by minute five: every traffic type has a
// home, nothing is upgraded, no ASG. Compute is the intended bottleneck — it
// is the node the knee is about, and the one the critique measured as the only
// node on a real board that ever exceeds totalLoad 0.2.
//
// Returns the nodes by role so a caller can name its bottleneck explicitly
// instead of guessing which node is hot.
export function buildReferenceBoard() {
  // place() throws if a node fails to appear, so a board that silently did not
  // build cannot masquerade as a healthy one.
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
  connect(alb, compute);
  connect(compute, cache);
  connect(cache, db);
  connect(compute, db);
  connect(compute, s3);
  connect(compute, search);
  connect("internet", cdn);
  connect(cdn, s3);

  return { waf, alb, compute, cache, db, s3, search, cdn, bottleneck: compute };
}

// One frame of animate()'s sim-relevant work, in animate()'s order.
export function frame(dt) {
  STATE.elapsedGameTime += dt;
  STATE.services.forEach((s) => s.update(dt));
  STATE.requests.slice().forEach((r) => r.update(dt));
  STATE.spawnTimer += dt;
  const effectiveRPS =
    STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
  if (effectiveRPS > 0) {
    const interval = 1 / effectiveRPS;
    while (STATE.spawnTimer >= interval) {
      STATE.spawnTimer -= interval;
      spawnRequest();
    }
  }
  STATE.reputation = Math.min(100, STATE.reputation);
}

/**
 * Hold the board at a fixed RPS and report what the player would experience.
 *
 * The metrics are chosen to be exactly the ones the knee design makes claims
 * about, so a claim can be falsified without writing new instrumentation:
 *   failures / processed  — is anything actually going wrong?
 *   minReputation         — is the run recoverable or over?
 *   bandResidencySec      — how long the bottleneck spends in the readable
 *                           band; the strobe finding lives here
 *   meanDwellSec          — mean length of ONE visit to that band
 *   timeToRepSec          — game seconds from the first dropped request to
 *                           reputation crossing `repFloor` (null if never)
 */
export function sweepAt({
  rps,
  seed = 0x5eed,
  seconds = 60,
  dt = 1 / 60,
  gameMode = "survival",
  band = [0.9, 1.2],
  repFloor = 50,
  upkeep = false,
} = {}) {
  resetWorld({ money: 1e9, gameMode });
  // Pinned AFTER resetWorld so world building consumes its own entropy, and
  // BEFORE the board so service ids are deterministic too.
  vi.spyOn(Math, "random").mockImplementation(mulberry32(seed));

  const nodes = buildReferenceBoard();
  STATE.upkeepEnabled = upkeep;
  STATE.currentRPS = rps;
  STATE.trafficDistribution = { ...REFERENCE_MIX };

  // Harness guards. A silently dead sweep reports a clean board and a passing
  // objective, which is the exact false negative this file exists to prevent.
  if (!STATE.services.length) throw new Error("reference board did not build");
  if (!STATE.currentRPS) throw new Error("sweep has no RPS");

  const b = nodes.bottleneck;
  let minReputation = STATE.reputation;
  // Both axes are tracked, always: the raw instantaneous signal and the
  // smoothed one (#74 step 2). Reporting only one of them would make the
  // knee work look like it moved the world when it moved the ruler.
  let bandFrames = 0;
  let episodes = 0;
  let inBand = false;
  let rawBandFrames = 0;
  let rawEpisodes = 0;
  let rawInBand = false;
  let firstFailAt = null;
  let repCrossAt = null;
  let peakUtil = 0;

  const totalFrames = Math.round(seconds / dt);
  for (let i = 0; i < totalFrames; i++) {
    frame(dt);

    const util = (b.smoothedLoad ?? b.totalLoad) * 2;
    if (util > peakUtil) peakUtil = util;
    const isIn = util > band[0] && util < band[1];
    if (isIn) {
      bandFrames++;
      if (!inBand) episodes++;
    }
    inBand = isIn;

    const rawUtil = b.totalLoad * 2;
    const rawIsIn = rawUtil > band[0] && rawUtil < band[1];
    if (rawIsIn) {
      rawBandFrames++;
      if (!rawInBand) rawEpisodes++;
    }
    rawInBand = rawIsIn;

    if (STATE.reputation < minReputation) minReputation = STATE.reputation;
    const failures = totalFailures();
    if (firstFailAt === null && failures > 0) firstFailAt = STATE.elapsedGameTime;
    if (
      repCrossAt === null &&
      firstFailAt !== null &&
      STATE.reputation <= repFloor
    ) {
      repCrossAt = STATE.elapsedGameTime;
    }
  }

  vi.restoreAllMocks();

  return {
    rps,
    seed,
    failures: totalFailures(),
    processed: STATE.requestsProcessed,
    minReputation: +minReputation.toFixed(1),
    endReputation: +STATE.reputation.toFixed(1),
    bandResidencySec: +(bandFrames * dt).toFixed(2),
    episodes,
    meanDwellSec: episodes ? +((bandFrames * dt) / episodes).toFixed(3) : 0,
    rawBandResidencySec: +(rawBandFrames * dt).toFixed(2),
    rawEpisodes,
    rawMeanDwellSec: rawEpisodes ? +((rawBandFrames * dt) / rawEpisodes).toFixed(3) : 0,
    timeToRepSec:
      repCrossAt !== null && firstFailAt !== null
        ? +(repCrossAt - firstFailAt).toFixed(1)
        : null,
    peakUtil: +peakUtil.toFixed(3),
  };
}

function totalFailures() {
  return Object.values(STATE.failures || {}).reduce(
    (a, n) => a + (typeof n === "number" ? n : 0),
    0
  );
}

/** Median across seeds — robust to one unlucky run, unlike a mean. */
export function medianOf(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const SEEDS = [
  0x5eed, 0x1234, 0xabcd, 0x0f0f, 0x7777, 0xbeef, 0xc0de, 0x2468,
];

/** Run one RPS across every seed and reduce to the medians that matter. */
export function sweepSeeds(opts) {
  const runs = SEEDS.map((seed) => sweepAt({ ...opts, seed }));
  return {
    rps: opts.rps,
    runs,
    medFailures: medianOf(runs.map((r) => r.failures)),
    medMinRep: medianOf(runs.map((r) => r.minReputation)),
    medBandSec: medianOf(runs.map((r) => r.bandResidencySec)),
    medDwell: medianOf(runs.map((r) => r.meanDwellSec)),
    seedsWithFailures: runs.filter((r) => r.failures > 0).length,
    seedsSurviving: runs.filter((r) => r.minReputation >= 80).length,
  };
}
