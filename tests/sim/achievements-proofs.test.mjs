// Machine proofs for the feat achievements (#158, the #184 discipline):
// speed_demon, minimalist, pacifist_run and no_upgrades are proven WINNABLE
// through the REAL level path — startCampaignLevel → player placement via
// createService → the same frame ordering animate() uses (elapsed →
// campaign.tick → services → requests → spawn → achievements.tick) — not
// through synthetic _persistWin calls. If a balance change breaks one of
// these runs, the def must be re-proven or cut, never shipped hopeful.
//
// The harness never touches tuning: level budgets, rps, mixes and objective
// checks are the shipped ones. The only test-only concession is pre-setting
// STATE.animationId so resetGame does not start the requestAnimationFrame
// loop next to the manually-driven frames.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { CampaignObjectives } from "../../src/campaign/objectives.js";
import { spawnRequest } from "../../src/core/actions.js";
import {
  endRandomEvent,
  triggerRandomEvent,
  updateInferenceStaging,
  updateMaliciousSpike,
  updateTrafficShift,
} from "../../src/core/events.js";
import { toggleAutoscaling } from "../../src/sim/autoscaling.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { startCampaignLevel } from "../../src/ui/campaign-ui.js";
import { CONFIG, STATE, resetWorld } from "../helpers/sim-world.mjs";

const ACH_KEY = "serverSurvivalAchievements";
const CAMPAIGN_KEY = "serverSurvivalCampaignProgress";
const store = () => globalThis.localStorage;

// One frame of the animate() loop's sim-relevant work, in animate()'s order —
// including the reputation clamp animate applies every frame, so the proof
// never banks reputation above 100 the way a raw sim loop would.
function frame(dt) {
  STATE.elapsedGameTime += dt;
  if (globalThis.window.campaign?.active) globalThis.window.campaign.tick(dt);
  STATE.services.forEach((s) => s.update(dt));
  STATE.requests.slice().forEach((r) => r.update(dt));
  STATE.spawnTimer += dt;
  const effectiveRPS =
    STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
  if (effectiveRPS > 0) {
    const spawnInterval = 1 / effectiveRPS;
    while (STATE.spawnTimer >= spawnInterval) {
      STATE.spawnTimer -= spawnInterval;
      spawnRequest();
    }
  }
  STATE.reputation = Math.min(100, STATE.reputation);
  achievements.tick(dt);
}

function runUntilEnded(capSec, dt = 0.1, perFrame = null) {
  for (let t = 0; t < capSec; t += dt) {
    if (STATE.campaign.ended) break;
    frame(dt);
    if (perFrame) perFrame(STATE.elapsedGameTime);
  }
}

// Deterministic PRNG (mulberry32). The wave-2 replays are RNG-sensitive
// enough (L20's minimal build wins only ~4/6 on live Math.random) that each
// proof pins a seed; the SAME builds were verified across 6 seeds during
// calibration, so the pinned seed documents one known-good line, not a fluke.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REAL_RANDOM = Math.random;
function seedRandom(seed) {
  Math.random = mulberry32(seed);
}

// Player placement through the real path (createService — which also stamps
// playerPlaced), with the real money checks active.
function placeAt(type, x, z) {
  const before = STATE.services.length;
  createService(type, new globalThis.THREE.Vector3(x, 0, z));
  if (STATE.services.length === before) {
    throw new Error(`placement of ${type} failed (money? tile?)`);
  }
  return STATE.services[STATE.services.length - 1];
}

beforeEach(() => {
  resetWorld();
  store().removeItem(ACH_KEY);
  achievements._reloadForTests();
  // Unlock the whole campaign so startCampaignLevel(10) passes the gate.
  store().setItem(
    CAMPAIGN_KEY,
    JSON.stringify({ version: 1, completed: {}, highestUnlocked: 25 })
  );
  // Keep resetGame from starting the real rAF loop next to our frames.
  STATE.animationId = 1;
});

afterEach(() => {
  Math.random = REAL_RANDOM;
});

describe("level 1 through the real path — speed_demon + minimalist", () => {
  it("the intended 4-service chain wins in under 45s", () => {
    startCampaignLevel(1);
    expect(STATE.campaign.active).toBe(true);
    expect(STATE.money).toBe(300);

    // The briefing's own chain: Internet → WAF → ALB → Compute → DB.
    // Exactly 4 services (the whole budget), which is also the minimalist bar.
    const waf = placeAt("waf", -20, 0);
    const alb = placeAt("alb", -10, 0);
    const compute = placeAt("compute", 0, 0);
    const db = placeAt("db", 10, 0);
    createConnection("internet", waf.id);
    createConnection(waf.id, alb.id);
    createConnection(alb.id, compute.id);
    createConnection(compute.id, db.id);
    expect(STATE.services).toHaveLength(4);

    runUntilEnded(60);

    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    // The speed_demon proof: the win landed with real margin under 45s.
    expect(STATE.elapsedGameTime).toBeLessThan(45);

    expect(achievements.isUnlocked("first_win")).toBe(true);
    expect(achievements.isUnlocked("speed_demon")).toBe(true);
    expect(achievements.isUnlocked("minimalist")).toBe(true);
  });
});

describe("level 10 through the real path — pacifist_run + no_upgrades", () => {
  it("a serverless-only build wins without upgrades", () => {
    startCampaignLevel(10);
    expect(STATE.campaign.active).toBe(true);
    expect(STATE.money).toBe(500);

    // Serverless-only on a shoestring: WAF → SQS → Serverless → { NoSQL, S3 }.
    // $235 of $500 — NoSQL over SQL is the cost play (the 5% SEARCH share has
    // nowhere to land and fails; reputation absorbs it). No Compute ever
    // touches the board; nothing is upgraded.
    const waf = placeAt("waf", -20, 0);
    const sqs = placeAt("sqs", -10, 0);
    const fn = placeAt("serverless", 0, 0);
    const nosql = placeAt("nosql", 10, 5);
    const s3 = placeAt("s3", 10, -5);
    createConnection("internet", waf.id);
    createConnection(waf.id, sqs.id);
    createConnection(sqs.id, fn.id);
    createConnection(fn.id, nosql.id);
    createConnection(fn.id, s3.id);

    // The $235 purchase puts netProfit at -235 — below the -210 objective —
    // so this is NOT the empty-board instant win: serverless economics must
    // actually earn the gap back for the level to end (measured ~t=60, well
    // inside the 270s timeout).
    runUntilEnded(200);

    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(STATE.services.some((s) => s.type === "compute")).toBe(false);

    expect(achievements.isUnlocked("pacifist_run")).toBe(true);
    expect(achievements.isUnlocked("no_upgrades")).toBe(true);
    expect(achievements.isUnlocked("first_win")).toBe(true);
  });
});

// The verification finding: L10's primaries (netProfit >= -210, rep >= 70)
// are vacuously true on an untouched board, so the first 2 Hz objective
// check declared a 3-star win at t=0.5s — farming first_win, speed_demon,
// minimalist and no_upgrades (plus pacifist_run with one idle serverless)
// with zero play. The campaign-side gate (a win requires >= 1 completed
// request this attempt) must keep BOTH probes from ever winning, through
// the same real path the farm used.
describe("level 10 instant-win farm is closed (win requires a completed request)", () => {
  it("an untouched board never wins — no achievement is farmable with zero play", () => {
    startCampaignLevel(10);
    expect(STATE.campaign.active).toBe(true);

    // The measured farm window: the first 2 Hz check at t=0.5s used to win.
    frame(0.5);
    expect(STATE.campaign.ended).toBe(false);

    // Run the level out. With nothing placed no request can ever complete,
    // so the win gate stays shut and the failing traffic bleeds reputation
    // to the repBelow:30 fail line (timeoutSec would catch a level whose
    // reputation never collapses).
    runUntilEnded(300);
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("lose");

    expect(achievements.isUnlocked("first_win")).toBe(false);
    expect(achievements.isUnlocked("speed_demon")).toBe(false);
    expect(achievements.isUnlocked("minimalist")).toBe(false);
    expect(achievements.isUnlocked("no_upgrades")).toBe(false);
    expect(achievements.isUnlocked("pacifist_run")).toBe(false);
  });

  it("one idle serverless never wins — pacifist_run is not farmable", () => {
    startCampaignLevel(10);
    placeAt("serverless", 0, 0); // never connected, completes nothing

    frame(0.5);
    expect(STATE.campaign.ended).toBe(false);

    runUntilEnded(300);
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("lose");

    expect(achievements.isUnlocked("pacifist_run")).toBe(false);
    expect(achievements.isUnlocked("first_win")).toBe(false);
    expect(achievements.isUnlocked("speed_demon")).toBe(false);
  });
});

// ===========================================================================
// Wave 2 (#234): the depth set. Every feat def below is machine-proven
// achievable through the REAL paths (startCampaignLevel replays; a scripted
// survival session driving the same sim work animate() does). Measured
// numbers quoted in the assertions come from the calibration battery run
// during implementation; the seeds pin one verified line of play.
// ===========================================================================

describe("level 21 replay — small_model_big_heart (tier-1 GPU win)", () => {
  it("a never-upgraded tier-1 GPU wins the primaries", () => {
    seedRandom(2101);
    startCampaignLevel(21);
    const computes = STATE.services.filter((s) => s.type === "compute");
    const gpu = placeAt("gpu", 10, -6);
    for (const c of computes) createConnection(c.id, gpu.id);

    runUntilEnded(120);

    // Calibration (unseeded): win t=58.5, rep 86.5, rep floor 78.6 — the
    // tuning comment's "tier-1 survives the primaries (rep 81-96)".
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(gpu.tier).toBe(1);
    expect(achievements.isUnlocked("small_model_big_heart")).toBe(true);
  });
});

describe("level 22 replay — one_gpu_economist (exactly one GPU)", () => {
  it("one GPU behind the gateway wins inside the profit floor", () => {
    seedRandom(2201);
    startCampaignLevel(22);
    const alb = STATE.services.find((s) => s.type === "alb");
    const infgw = placeAt("infgw", 0, -10);
    const gpu = placeAt("gpu", 10, -10);
    createConnection(alb.id, infgw.id);
    createConnection(infgw.id, gpu.id);

    runUntilEnded(160);

    // Calibration (unseeded): win t=54, netProfit -393 (floor -500).
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(STATE.services.filter((s) => s.type === "gpu")).toHaveLength(1);
    expect(CampaignObjectives.netProfit(STATE)).toBeGreaterThanOrEqual(-500);
    expect(achievements.isUnlocked("one_gpu_economist")).toBe(true);
  });
});

describe("level 23 replay — slo_clean (zero expiries)", () => {
  it("a second GPU placed before Play rides the warmup grace expiry-free", () => {
    seedRandom(2301);
    startCampaignLevel(23);
    const infgw = STATE.services.find((s) => s.type === "infgw");
    const gpu2 = placeAt("gpu", 10, -14);
    createConnection(infgw.id, gpu2.id);

    runUntilEnded(240);

    // Calibration (unseeded): win t=113, expiries 0 — the tuning comment's
    // "the winning fleet rides the grace through the cold start with ZERO
    // expiries".
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(CampaignObjectives.expiredRequests(STATE)).toBe(0);
    expect(achievements.isUnlocked("slo_clean")).toBe(true);
  });
});

describe("level 24 replay — megawatt (the 18 kW winning build)", () => {
  it("two substations + three GPUs draw exactly 18 kW and win", () => {
    seedRandom(2401);
    startCampaignLevel(24);
    const alb = STATE.services.find((s) => s.type === "alb");
    placeAt("power", -20, -10);
    placeAt("power", -30, -10);
    const infgw = placeAt("infgw", 0, -8);
    createConnection(alb.id, infgw.id);
    for (const [x, z] of [[10, -8], [18, -8], [26, -8]]) {
      const g = placeAt("gpu", x, z);
      createConnection(infgw.id, g.id);
    }
    expect(STATE.power.usedKw).toBe(18);

    runUntilEnded(240);

    // Calibration (unseeded): win t=57, rep 65.9. megawatt lands mid-run,
    // the moment the third player-placed GPU joins the grid.
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(achievements.isUnlocked("megawatt")).toBe(true);
  });
});

// The farmability guard the wave-2 comment block in definitions.js documents:
// L17 FORCES the outage and its natural winning play (a second Firewall wired
// before t=30) keeps reputation at ~100 through it — measured repAtOutage
// 100, rep floor after the outage 100. The issue's rep >= 90 gate alone would
// therefore auto-grant on every decent L17 win, which is why failover_proven
// is survival-only. This replay pins the guard through the real level.
describe("level 17 winning replay — failover_proven is NOT campaign-farmable", () => {
  it("wins with outages > 0 and rep >= 90, yet grants nothing", () => {
    seedRandom(1701);
    startCampaignLevel(17);
    const alb = STATE.services.find((s) => s.type === "alb");
    const waf2 = placeAt("waf", -22, -8);
    createConnection("internet", waf2.id);
    createConnection(waf2.id, alb.id);

    runUntilEnded(240);

    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    // The trigger the def names IS present and the rep gate IS met...
    expect(STATE.resilience.outages).toBeGreaterThan(0);
    expect(STATE.reputation).toBeGreaterThanOrEqual(90);
    // ...and the survival gate still holds the def shut.
    expect(achievements.isUnlocked("failover_proven")).toBe(false);
    expect(achievements.isUnlocked("breaker_comeback")).toBe(false);
  });
});

describe("level 20 replay — region_blackout through the real outage", () => {
  it("region B carries the 25s blackout: 60+ completions during the dark", () => {
    seedRandom(7919);
    startCampaignLevel(20);
    const dns = STATE.services.find((s) => s.type === "dns");
    const db = STATE.services.find((s) => s.type === "db");
    const wafB = placeAt("waf", -20, -7);
    const albB = placeAt("alb", -10, -7);
    const compB = placeAt("compute", 0, -7);
    createConnection(dns.id, wafB.id);
    createConnection(wafB.id, albB.id);
    createConnection(albB.id, compB.id);
    createConnection(compB.id, db.id);

    // The reinforced play (verified winning across 6 seeds, 6/6): buy a
    // second region-B compute from income before the t=35 lights-out. The
    // minimal $150 build wins only ~4/6 on RNG — region B alone runs at
    // ~90% of one Tier-1 Compute's ceiling during the blackout.
    let bought = false;
    runUntilEnded(270, 0.1, (t) => {
      if (!bought && t >= 20 && STATE.money >= 60) {
        const c2 = placeAt("compute", 0, -14);
        createConnection(albB.id, c2.id);
        createConnection(c2.id, db.id);
        bought = true;
      }
    });

    // Calibration across seeds 1-6: win t=67-71, outage completions 110-120,
    // rep floor 94-97. Collapsed (losing) runs measure 28-42 completions —
    // the 60 bar separates "region B carried it" from "region B drowned".
    expect(STATE.campaign.ended).toBe(true);
    expect(STATE.campaign.outcome).toBe("win");
    expect(CampaignObjectives.completedDuringRegionOutage(STATE)).toBeGreaterThanOrEqual(60);
    expect(achievements.isUnlocked("region_blackout")).toBe(true);
    // Campaign mode: none of the survival-only resilience defs leak.
    expect(achievements.isUnlocked("failover_proven")).toBe(false);
  });
});

// ===========================================================================
// Survival-mode proofs. The harness replicates animate()'s sim-relevant
// survival work: spawn + the real RPS curve (pinned AT the target each frame
// — the real loop lags toward it, so pinning is strictly harder), malicious
// spikes, traffic shifts, inference staging, and the random-event system
// driven through its real trigger/end sites on a deterministic schedule
// (updateRandomEvents itself times out events on the wall clock, which a
// headless run cannot advance).
// ===========================================================================

// Replicates game.js calculateTargetRPS (sans the DOM milestone warning).
function survivalTargetRPS(t) {
  const base = CONFIG.survival.baseRPS;
  let target = base + Math.log(1 + t / 20) * 2.2 + t * 0.008;
  let multiplier = 1.0;
  for (const m of CONFIG.survival.rpsAcceleration.milestones) {
    if (t >= m.time) multiplier = m.multiplier;
  }
  return target * multiplier;
}

function startSurvival() {
  resetWorld({ money: CONFIG.survival.startBudget, gameMode: "survival" });
  STATE.upkeepEnabled = true;
  STATE.currentRPS = CONFIG.survival.baseRPS;
  STATE.trafficDistribution = { ...CONFIG.survival.trafficDistribution };
  STATE.maliciousSpikeTimer = 0;
  STATE.maliciousSpikeActive = false;
  STATE.normalTrafficDist = null;
  STATE.intervention.trafficShiftTimer = 0;
  STATE.intervention.trafficShiftActive = false;
  STATE.intervention.currentShift = null;
  STATE.intervention.originalTrafficDist = null;
  STATE.intervention.randomEventTimer = 0;
  STATE.intervention.activeEvent = null;
  STATE.intervention.trafficBurstMultiplier = 1.0;
  STATE.intervention.costMultiplier = 1.0;
  achievements.onSessionStart();
}

// `interventions: false` scopes a proof to the bare sim loop (no spikes, no
// traffic shifts): the fleet and breaker scenarios pin a single mechanic on
// a controlled traffic mix — a shift overwriting the mix mid-proof would
// re-introduce MALICIOUS against a deliberately WAF-less lane. The marathon
// runs with the full machinery on.
function survivalFrame(dt, { rampRPS = true, interventions = true } = {}) {
  STATE.elapsedGameTime += dt;
  STATE.services.forEach((s) => s.update(dt));
  STATE.requests.slice().forEach((r) => r.update(dt));
  STATE.spawnTimer += dt;
  const effectiveRPS =
    STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
  if (effectiveRPS > 0) {
    const spawnInterval = 1 / effectiveRPS;
    while (STATE.spawnTimer >= spawnInterval) {
      STATE.spawnTimer -= spawnInterval;
      spawnRequest();
    }
  }
  if (rampRPS) {
    STATE.currentRPS = Math.min(
      survivalTargetRPS(STATE.elapsedGameTime),
      CONFIG.survival.maxRPS
    );
  }
  if (interventions) {
    updateMaliciousSpike(dt);
    updateInferenceStaging();
    updateTrafficShift(dt);
  }
  STATE.reputation = Math.min(100, STATE.reputation);
  achievements.tick(dt);
}

describe("survival marathon — quarter_hour + high_score_200k proven at 900s", () => {
  it("a competent veteran build survives past the 2x upkeep wall to 900s+", () => {
    seedRandom(101);
    startSurvival();

    // ---- t=0: the classic spine ($360 of $500) ----
    const waf1 = placeAt("waf", -20, 0);
    const alb = placeAt("alb", -10, 0);
    const sl1 = placeAt("serverless", 0, 6);
    const sl2 = placeAt("serverless", 0, -6);
    const nosql = placeAt("nosql", 10, 6);
    const db = placeAt("db", 10, -6);
    const s3 = placeAt("s3", 10, 14);
    createConnection("internet", waf1.id);
    createConnection(waf1.id, alb.id);
    createConnection(alb.id, sl1.id);
    createConnection(alb.id, sl2.id);
    for (const sl of [sl1, sl2]) {
      createConnection(sl.id, nosql.id);
      createConnection(sl.id, db.id);
      createConnection(sl.id, s3.id);
    }

    const steps = [];
    const buy = (when, fn) => steps.push({ when, fn, done: false });
    const albs = [alb];
    const s3s = [s3];
    const backends = [nosql, db, s3];
    const wireServerless = (sl) => {
      for (const a of albs) createConnection(a.id, sl.id);
      for (const b of backends) createConnection(sl.id, b.id);
    };
    const addBackend = (svc) => {
      backends.push(svc);
      for (const sl of STATE.services.filter((x) => x.type === "serverless")) {
        createConnection(sl.id, svc.id);
      }
    };

    let cdn = null;
    buy((t, m) => m >= 90, () => {
      cdn = placeAt("cdn", -20, 10);
      createConnection("internet", cdn.id);
      createConnection(cdn.id, s3.id);
    });
    buy((t, m) => t >= 60 && m >= 80, () => {
      const waf2 = placeAt("waf", -20, -10);
      createConnection("internet", waf2.id);
      createConnection(waf2.id, alb.id);
    });
    // Redundancy against SERVICE_OUTAGE: a 15s blackout of the single ALB
    // (or single S3) at late-game RPS is unsurvivable — both measured
    // deaths during calibration. Double the request-path singles.
    buy((t, m) => t >= 100 && m >= 100, () => {
      const alb2 = placeAt("alb", -10, -14);
      for (const w of STATE.services.filter((x) => x.type === "waf")) {
        createConnection(w.id, alb2.id);
      }
      for (const sl of STATE.services.filter((x) => x.type === "serverless")) {
        createConnection(alb2.id, sl.id);
      }
      albs.push(alb2);
      const s3b = placeAt("s3", 18, 14);
      addBackend(s3b);
      if (cdn) createConnection(cdn.id, s3b.id);
      s3s.push(s3b);
    });
    // Specialized backends EARLY: a Search Storm shift overlapping a 3x
    // burst kills the SQL tier otherwise (measured death #3).
    buy((t, m) => t >= 180 && m >= 140, () => {
      addBackend(placeAt("search", 26, -6));
    });
    buy((t, m) => t >= 210 && m >= 120, () => {
      const rep = placeAt("replica", 18, -6);
      createConnection(rep.id, db.id);
      addBackend(rep);
    });
    buy((t, m) => t >= 150 && m >= 100, () => {
      wireServerless(placeAt("serverless", 0, -22));
    });
    // An SQS-fed ASG lane + a DLQ over the whole serving tier: the
    // nothing_lost drains accrue here organically.
    let sqs = null;
    let asg = null;
    buy((t, m) => t >= 90 && m >= 200, () => {
      sqs = placeAt("sqs", -2, 20);
      asg = placeAt("compute", 6, 26);
      createConnection(alb.id, sqs.id);
      createConnection(sqs.id, asg.id);
      createConnection(asg.id, nosql.id);
      createConnection(asg.id, db.id);
      createConnection(asg.id, s3.id);
      toggleAutoscaling(asg);
    });
    buy((t, m) => t >= 120 && m >= 80, () => {
      const dlq = placeAt("dlq", 0, 32);
      createConnection(sl1.id, dlq.id);
      createConnection(sl2.id, dlq.id);
      if (asg) createConnection(asg.id, dlq.id);
    });
    // NO AI layer, deliberately: owning a GPU adds the 25% AI Hype Wave to
    // the shift rotation (requiresService: "gpu"), and at late-game 58+ rps
    // that is ~14.5/s INFERENCE against what even three tier-1 GPUs serve
    // (~8.9/s) — the measured death spiral (expiries at -1 each). The
    // GPU-less 3% base bleed is strictly smaller than the success flow at
    // this scale. megawatt is proven on the L24 replay instead.
    buy((t, m) => t >= 300 && m >= 100, () => {
      const waf3 = placeAt("waf", -28, 0);
      createConnection("internet", waf3.id);
      for (const a of albs) createConnection(waf3.id, a.id);
    });
    buy((t, m) => t >= 500 && m >= 150, () => {
      wireServerless(placeAt("serverless", 0, 20));
    });
    buy((t, m) => t >= 350 && m >= 250, () => { nosql.upgrade(); });
    buy((t, m) => t >= 600 && m >= 350, () => { db.upgrade(); nosql.upgrade(); });

    // Deterministic random-event schedule through the REAL trigger/end
    // sites: one event per minute, 15 game-seconds each, cycling all four
    // types — denser than the live 30%-per-30s roll.
    const EVENTS = ["TRAFFIC_BURST", "SERVICE_OUTAGE", "COST_SPIKE", "CAPACITY_DROP"];
    let nextEventAt = 75;
    let eventEndAt = -1;
    let eventIdx = 0;

    const dt = 0.1;
    let playerAcc = 0;
    let dead = false;
    let scoreAt900 = 0;
    let slExtra = 0;
    let nextSlAt = 0;
    for (let i = 0; i < 10000; i++) {
      survivalFrame(dt);
      const t = STATE.elapsedGameTime;

      if (t >= nextEventAt && eventEndAt < 0) {
        triggerRandomEvent(EVENTS[eventIdx % EVENTS.length]);
        eventIdx++;
        eventEndAt = t + 15;
      }
      if (eventEndAt > 0 && t >= eventEndAt) {
        endRandomEvent();
        eventEndAt = -1;
        nextEventAt = t + 45;
      }

      playerAcc += dt;
      if (playerAcc >= 1) {
        playerAcc = 0;
        for (const st of steps) {
          if (!st.done && st.when(t, STATE.money)) {
            st.fn();
            st.done = true;
          }
        }
        // Standing rule — the 3x TRAFFIC_BURST answer: overprovision the
        // elastic tier from t=300, one serverless a minute while rich.
        if (t >= 300 && STATE.money >= 400 && slExtra < 8 && t >= nextSlAt) {
          wireServerless(placeAt("serverless", 30 + slExtra * 8, 20));
          slExtra++;
          nextSlAt = t + 45;
        }
        for (const s of STATE.services) {
          if (s.health < 55) s.repair();
        }
      }

      if (t >= 900 && scoreAt900 === 0) scoreAt900 = STATE.score.total;
      if (STATE.reputation <= 0 || STATE.money <= -1000) {
        dead = true;
        break;
      }
    }

    // The proof: alive past 900s (the game-over line never crossed), with
    // the 2x upkeep wall at t=600 long behind. Calibration: rep holds ~100
    // for the whole run, bank five figures, score 213.9k at t=900.
    expect(dead).toBe(false);
    expect(STATE.elapsedGameTime).toBeGreaterThan(900);
    expect(achievements.isUnlocked("quarter_hour")).toBe(true);

    // Score calibration documented in-code: 200k crossed at ~t=875 by this
    // near-full-throughput build — the issue's 50k falls at ~t=425 and would
    // be granted by ANY surviving run (failures bleed rep AND score, so a
    // 900s survivor serves nearly everything).
    expect(scoreAt900).toBeGreaterThan(200000);
    expect(achievements.isUnlocked("high_score_200k")).toBe(true);

    // Organic wave-2 unlocks along the way, all through real sim paths:
    // the DLQ drains bursts' final failures (calibration: 117 drains by
    // t=900)...
    expect(STATE.resilience.drained).toBeGreaterThanOrEqual(25);
    expect(achievements.isUnlocked("nothing_lost")).toBe(true);
    // ...and the scheduled SERVICE_OUTAGE events are survived at rep >= 90.
    expect(STATE.resilience.outages).toBeGreaterThan(0);
    expect(achievements.isUnlocked("failover_proven")).toBe(true);
  }, 120000);
});

describe("survival fleet — fleet_of_four through the real ASG engine", () => {
  it("a queue-fed fleet grows to 4 ready instances and the run stays alive", () => {
    seedRandom(4242);
    startSurvival();
    STATE.money = 100000;
    // A clean READ-only lane: the point is the scaling engine, not WAF play.
    STATE.trafficDistribution = { STATIC: 0, READ: 1, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0, INFERENCE: 0 };
    const alb = placeAt("alb", -10, 0);
    const sqs = placeAt("sqs", 0, 0);
    const asg = placeAt("compute", 10, 0);
    const db = placeAt("db", 20, 0);
    createConnection("internet", alb.id);
    createConnection(alb.id, sqs.id);
    createConnection(sqs.id, asg.id);
    createConnection(asg.id, db.id);
    toggleAutoscaling(asg);

    const dt = 0.1;
    let maxFleet = 0;
    let minRep = 200;
    for (let i = 0; i < 1200; i++) {
      STATE.currentRPS = 12; // a hair above one instance, the L16 regime
      survivalFrame(dt, { rampRPS: false, interventions: false });
      if (asg.instances > maxFleet) maxFleet = asg.instances;
      if (STATE.reputation < minRep) minRep = STATE.reputation;
      if (maxFleet >= 4 && STATE.reputation > 90) break;
    }

    // Calibration: fleet reaches 4 READY instances at ~t=30 with a rep floor
    // of 26 (alive), then recovers past 90. FIVE ready instances was
    // measured rep-lethal (< -1000): the load-failure roll prices every
    // sustained-pressure window, which is why the def (and the issue's own
    // threshold text) says 4.
    expect(maxFleet).toBeGreaterThanOrEqual(4);
    expect(minRep).toBeGreaterThan(0);
    expect(STATE.reputation).toBeGreaterThan(90);
    expect(achievements.isUnlocked("fleet_of_four")).toBe(true);
  }, 60000);
});

describe("survival resilience — breaker_comeback + second_chance", () => {
  it("pulsed floods bank retries and a genuine trip->recover->close at rep >= 90", () => {
    seedRandom(777);
    startSurvival();
    STATE.money = 100000;
    STATE.trafficDistribution = { STATIC: 0, READ: 1, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0, INFERENCE: 0 };
    const alb = placeAt("alb", -10, 0);
    const c1 = placeAt("compute", 0, 6);
    const c2 = placeAt("compute", 0, -6);
    const db = placeAt("db", 10, 0);
    createConnection("internet", alb.id);
    createConnection(alb.id, c1.id);
    createConnection(alb.id, c2.id);
    createConnection(c1.id, db.id);
    createConnection(c2.id, db.id);
    c2.upgrade();
    c2.upgrade(); // tier 3: the healthy peer that absorbs the floods

    const dt = 0.1;
    let minRep = 200;
    for (let t = 0; t < 150; t += dt) {
      // Flood while c1's breaker is closed (its load failures retry to the
      // tier-3 peer), calm while it is open/half-open so it genuinely
      // recovers and closes. Each cycle banks ~15-20 retries at ~2 rep.
      STATE.currentRPS = c1.breakerState === "closed" ? 26 : 6;
      survivalFrame(dt, { rampRPS: false, interventions: false });
      if (STATE.reputation < minRep) minRep = STATE.reputation;
      if (
        achievements.isUnlocked("breaker_comeback") &&
        achievements.isUnlocked("second_chance")
      ) break;
    }

    // Calibration: trip within the first flood, first close at ~t=10 with
    // rep ~99 (floor 96.5 across the whole run); 50 retries banked by ~t=30.
    expect(STATE.resilience.trips).toBeGreaterThan(0);
    expect(STATE.resilience.retries).toBeGreaterThanOrEqual(50);
    expect(minRep).toBeGreaterThanOrEqual(90);
    expect(achievements.isUnlocked("breaker_comeback")).toBe(true);
    expect(achievements.isUnlocked("second_chance")).toBe(true);
  }, 60000);
});
