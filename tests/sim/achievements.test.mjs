// Achievements engine + hooks (#158, tier 2 — the engine's import chain
// reaches game.js, so it runs in the sim env over the real index.html
// fixture). Covers: unlock-once, persistence round-trip, corrupt store and
// version gate, the 2 Hz poll cadence + all-unlocked short-circuit, the
// session-boundary baselines (restored saves, the failures-panel clear-all),
// the player-placed filter on architecture polls, the real-site spike and
// locale hooks, levelWin ordering (chapter grants in the same _persistWin
// call), the upgrade counter, and the toast-guard-is-cosmetic rule.
import { describe, it, expect, beforeEach } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { ACHIEVEMENT_DEFS, POLL_DEFS } from "../../src/achievements/definitions.js";
import { CampaignController } from "../../src/campaign/campaign.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { triggerRandomEvent, updateMaliciousSpike } from "../../src/core/events.js";
import { Request } from "../../src/entities/Request.js";
import { Service } from "../../src/entities/Service.js";
import { i18n } from "../../src/i18n.js";
import {
  recordBreakerFailure,
  recordBreakerSuccess,
  updateBreaker,
} from "../../src/sim/circuit-breaker.js";
import { parkInDLQ } from "../../src/sim/dlq.js";
import { recomputePower } from "../../src/sim/power.js";
import { createService } from "../../src/sim/topology.js";
import { CONFIG, STATE, resetWorld, place, connect, step } from "../helpers/sim-world.mjs";

const ACH_KEY = "serverSurvivalAchievements";
const CAMPAIGN_KEY = "serverSurvivalCampaignProgress";
const store = () => globalThis.localStorage;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One forced poll evaluation (0.5s of game time in one step).
function pollOnce() {
  return achievements.tick(0.5);
}

beforeEach(() => {
  resetWorld();
  store().removeItem(ACH_KEY);
  store().removeItem(CAMPAIGN_KEY);
  achievements._reloadForTests();
  achievements.onSessionStart();
});

// ---------------------------------------------------------------------------
// Engine: persistence, unlock-once, corrupt store, version gate
// ---------------------------------------------------------------------------
describe("engine store", () => {
  it("starts empty and round-trips an unlock through localStorage", () => {
    expect(achievements.unlockedCount()).toBe(0);
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    expect(achievements.isUnlocked("fortress")).toBe(true);

    // Fresh in-memory engine re-reads the persisted store.
    achievements._reloadForTests();
    expect(achievements.isUnlocked("fortress")).toBe(true);
    const raw = JSON.parse(store().getItem(ACH_KEY));
    expect(raw.version).toBe(1);
    expect(typeof raw.unlocked.fortress).toBe("number");
  });

  it("unlocks exactly once — the first timestamp is never overwritten", () => {
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    const first = achievements.unlockedMap().fortress;
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    expect(achievements.unlockedMap().fortress).toBe(first);
    expect(achievements.unlockedCount()).toBe(1);
  });

  it("resets on corrupt JSON instead of throwing", () => {
    store().setItem(ACH_KEY, "{not json");
    achievements._reloadForTests();
    expect(achievements.unlockedCount()).toBe(0);
    // ...and the engine still works afterwards.
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    expect(achievements.isUnlocked("fortress")).toBe(true);
  });

  it("resets on a schema version mismatch", () => {
    store().setItem(ACH_KEY, JSON.stringify({ version: 999, unlocked: { first_win: 1 } }));
    achievements._reloadForTests();
    expect(achievements.unlockedCount()).toBe(0);
  });

  it("shape-hardens a store with mangled unlocked/seen fields", () => {
    store().setItem(ACH_KEY, JSON.stringify({ version: 1, unlocked: "nope", seen: 42 }));
    achievements._reloadForTests();
    expect(achievements.unlockedCount()).toBe(0);
    achievements.onLocaleChange("ru");
    const raw = JSON.parse(store().getItem(ACH_KEY));
    expect(raw.seen.localeSet).toEqual(["ru"]);
  });
});

// ---------------------------------------------------------------------------
// Poll cadence + short-circuit
// ---------------------------------------------------------------------------
describe("poll cadence", () => {
  it("evaluates at 2 Hz on accumulated game time, not per call", () => {
    expect(achievements.tick(0.4)).toBe(false);
    expect(achievements.tick(0.05)).toBe(false);
    expect(achievements.tick(0.05)).toBe(true); // 0.5s crossed
    expect(achievements.tick(0.4)).toBe(false); // accumulator restarted
  });

  it("a paused game (dt 0) never advances the accumulator", () => {
    for (let i = 0; i < 100; i++) expect(achievements.tick(0)).toBe(false);
  });

  it("skips entirely once every poll def is unlocked", () => {
    const unlocked = {};
    for (const d of POLL_DEFS) unlocked[d.id] = 1;
    store().setItem(ACH_KEY, JSON.stringify({ version: 1, unlocked, seen: { localeSet: [] } }));
    achievements._reloadForTests();
    expect(achievements.tick(10)).toBe(false);
    expect(achievements.tick(10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Survival benchmarks: live-play baselines (the session-boundary amendment)
// ---------------------------------------------------------------------------
describe("survival time benchmarks", () => {
  it("grants first_minute after 60 LIVE seconds in survival", () => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
    STATE.elapsedGameTime = 59;
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(false);
    STATE.elapsedGameTime = 61;
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(true);
    expect(achievements.isUnlocked("five_minutes")).toBe(false);
  });

  it("never grants time benchmarks in sandbox mode", () => {
    STATE.gameMode = "sandbox";
    achievements.onSessionStart();
    STATE.elapsedGameTime = 1000;
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(false);
    expect(achievements.isUnlocked("five_minutes")).toBe(false);
  });

  it("a restored save (elapsed 400s) earns nothing until NEW seconds pass", () => {
    STATE.gameMode = "survival";
    STATE.elapsedGameTime = 400; // what loadGameState restores
    achievements.onSessionStart(); // the loadGameState call site
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(false);
    expect(achievements.isUnlocked("five_minutes")).toBe(false);

    STATE.elapsedGameTime = 461; // 61 live seconds later
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(true);
    expect(achievements.isUnlocked("five_minutes")).toBe(false);
  });

  it("grants high_score thresholds from the live score, survival only", () => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
    STATE.score.total = 1500;
    pollOnce();
    expect(achievements.isUnlocked("high_score_1k")).toBe(true);
    expect(achievements.isUnlocked("high_score_10k")).toBe(false);
    STATE.score.total = 10000;
    pollOnce();
    expect(achievements.isUnlocked("high_score_10k")).toBe(true);
  });
});

describe("clean_two_minutes", () => {
  beforeEach(() => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
  });

  it("grants after 120 clean live seconds", () => {
    STATE.elapsedGameTime = 121;
    pollOnce();
    expect(achievements.isUnlocked("clean_two_minutes")).toBe(true);
  });

  it("a failure restarts the clean window", () => {
    STATE.elapsedGameTime = 50;
    STATE.failures.READ = 1;
    pollOnce(); // engine observes the increase at t=50
    STATE.elapsedGameTime = 130;
    pollOnce();
    expect(achievements.isUnlocked("clean_two_minutes")).toBe(false); // only 80s clean
    STATE.elapsedGameTime = 171; // 121s after the failure
    pollOnce();
    expect(achievements.isUnlocked("clean_two_minutes")).toBe(true);
  });

  it("the failures-panel clear-all button cannot fake a clean window", () => {
    STATE.elapsedGameTime = 50;
    STATE.failures.READ = 5;
    pollOnce();
    // Player clicks clear-all at t=125: raw counters drop to zero.
    STATE.elapsedGameTime = 125;
    STATE.failures.READ = 0;
    pollOnce();
    STATE.elapsedGameTime = 130; // >120s elapsed, counters read zero
    pollOnce();
    expect(achievements.isUnlocked("clean_two_minutes")).toBe(false);
    // The window still runs from the last observed failure at t=50.
    STATE.elapsedGameTime = 171;
    pollOnce();
    expect(achievements.isUnlocked("clean_two_minutes")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Architecture variety: player-placed services only
// ---------------------------------------------------------------------------
describe("architecture polls", () => {
  it("pre-built services (constructed outside createService) grant nothing", () => {
    for (const type of ["db", "nosql", "search", "replica"]) {
      const s = new Service(type, new globalThis.THREE.Vector3(Math.random() * 90, 0, 40));
      STATE.services.push(s); // the startCampaignLevel pre-build path
    }
    pollOnce();
    expect(achievements.isUnlocked("polyglot_db")).toBe(false);
  });

  it("polyglot_db: SQL + NoSQL + Search + Replica, all player-placed", () => {
    place("db");
    place("nosql");
    place("search");
    pollOnce();
    expect(achievements.isUnlocked("polyglot_db")).toBe(false);
    place("replica");
    pollOnce();
    expect(achievements.isUnlocked("polyglot_db")).toBe(true);
  });

  it("triple_firewall wants 3 ROUTABLE player-placed WAFs", () => {
    const w1 = place("waf");
    place("waf");
    place("waf");
    w1.isDisabled = true;
    pollOnce();
    expect(achievements.isUnlocked("triple_firewall")).toBe(false);
    w1.isDisabled = false;
    pollOnce();
    expect(achievements.isUnlocked("triple_firewall")).toBe(true);
  });

  it("full_stack_ai: GPU + Inference Gateway + Substation together", () => {
    place("power");
    place("gpu");
    pollOnce();
    expect(achievements.isUnlocked("full_stack_ai")).toBe(false);
    place("infgw");
    pollOnce();
    expect(achievements.isUnlocked("full_stack_ai")).toBe(true);
  });

  it("city_block counts only player placements toward 15", () => {
    // 10 pre-built + 14 player-placed = 24 on the board, 14 eligible.
    for (let i = 0; i < 10; i++) {
      STATE.services.push(new Service("s3", new globalThis.THREE.Vector3(200 + i * 8, 0, 40)));
    }
    for (let i = 0; i < 14; i++) place("s3");
    pollOnce();
    expect(achievements.isUnlocked("city_block")).toBe(false);
    place("s3"); // 15th player placement
    pollOnce();
    expect(achievements.isUnlocked("city_block")).toBe(true);
  });

  it("the shared-arch rebuild opt-out leaves playerPlaced false", () => {
    createService("waf", new globalThis.THREE.Vector3(300, 0, 0), { playerPlaced: false });
    const s = STATE.services[STATE.services.length - 1];
    expect(s.type).toBe("waf");
    expect(s.playerPlaced).toBe(false);
    // ...while the normal path marks true.
    const mine = place("waf");
    expect(mine.playerPlaced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fortress: real spike sites through updateMaliciousSpike
// ---------------------------------------------------------------------------
describe("fortress (spike events from the real sites)", () => {
  function driveSpikeCycle(untilSec) {
    for (let t = 0; t < untilSec; t += 0.1) updateMaliciousSpike(0.1);
  }

  beforeEach(() => {
    STATE.gameMode = "survival";
    STATE.maliciousSpikeTimer = 0;
    STATE.maliciousSpikeActive = false;
    STATE.intervention.trafficShiftActive = false;
    achievements.onSessionStart();
  });

  it("grants when a full spike ends with reputation >= 95", () => {
    STATE.reputation = 100;
    // interval 45 + duration 12 → one full cycle inside 58s.
    driveSpikeCycle(58);
    expect(STATE.maliciousSpikeActive).toBe(false); // spike came and went
    expect(achievements.isUnlocked("fortress")).toBe(true);
  });

  it("does not grant when reputation dropped below 95 during the spike", () => {
    driveSpikeCycle(46); // spike started
    expect(STATE.maliciousSpikeActive).toBe(true);
    STATE.reputation = 80;
    driveSpikeCycle(12); // spike ends
    expect(STATE.maliciousSpikeActive).toBe(false);
    expect(achievements.isUnlocked("fortress")).toBe(false);
  });

  it("a session boundary mid-spike disarms — the next end never grants", () => {
    driveSpikeCycle(46); // armed
    expect(STATE.maliciousSpikeActive).toBe(true);
    achievements.onSessionStart(); // resetGame / loadGameState mid-spike
    STATE.reputation = 100;
    driveSpikeCycle(12); // endMaliciousSpike fires with rep 100
    expect(STATE.maliciousSpikeActive).toBe(false);
    expect(achievements.isUnlocked("fortress")).toBe(false);
  });

  it("an end without a start (stranded flag semantics) never grants", () => {
    achievements.onSpikeEnd({ reputation: 100 });
    expect(achievements.isUnlocked("fortress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// polyglot: real locale site (i18n.setLocale → boundary listener)
// ---------------------------------------------------------------------------
describe("polyglot (locale hook from the real site)", () => {
  it("i18n.setLocale drives the engine through game.js's boundary listener", async () => {
    // The listener registers in game.js's deferred boot block (~100ms).
    await sleep(150);
    store().removeItem(ACH_KEY);
    achievements._reloadForTests();
    achievements.init(i18n.currentLocale); // records "en", the boot behavior

    i18n.setLocale("ru");
    expect(achievements.isUnlocked("polyglot")).toBe(false); // en + ru = 2
    i18n.setLocale("uk");
    expect(achievements.isUnlocked("polyglot")).toBe(true); // 3 locales
    const raw = JSON.parse(store().getItem(ACH_KEY));
    expect(raw.seen.localeSet).toEqual(["en", "ru", "uk"]);
    i18n.setLocale("en"); // restore for the rest of the file
  });

  it("repeat locales do not double-count", () => {
    achievements.onLocaleChange("en");
    achievements.onLocaleChange("en");
    achievements.onLocaleChange("ru");
    achievements.onLocaleChange("ru");
    expect(achievements.isUnlocked("polyglot")).toBe(false);
    achievements.onLocaleChange("uk");
    expect(achievements.isUnlocked("polyglot")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// levelWin defs through the real _persistWin site (ordering included)
// ---------------------------------------------------------------------------
describe("levelWin defs via _persistWin", () => {
  let c;
  beforeEach(() => {
    c = new CampaignController();
    STATE.campaign.upgradesPerformed = 0;
  });

  it("first_win lands on any win", () => {
    c._persistWin(1, 1, 60);
    expect(achievements.isUnlocked("first_win")).toBe(true);
  });

  it("speed_demon needs elapsed < 45", () => {
    c._persistWin(2, 1, 46);
    expect(achievements.isUnlocked("speed_demon")).toBe(false);
    c._persistWin(2, 1, 44.5);
    expect(achievements.isUnlocked("speed_demon")).toBe(true);
  });

  it("cache/replica/search/gpu masters want 3 stars on their level", () => {
    c._persistWin(4, 2, 60);
    expect(achievements.isUnlocked("cache_master")).toBe(false);
    c._persistWin(4, 3, 60);
    expect(achievements.isUnlocked("cache_master")).toBe(true);
    c._persistWin(6, 3, 60);
    c._persistWin(7, 3, 60);
    c._persistWin(21, 3, 60);
    expect(achievements.isUnlocked("replica_master")).toBe(true);
    expect(achievements.isUnlocked("search_master")).toBe(true);
    expect(achievements.isUnlocked("gpu_graduate")).toBe(true);
  });

  it("winning a chapter's FINAL level grants the chapter def in the same call", () => {
    c.saveProgress({
      version: 1,
      completed: { 1: { stars: 1, bestTimeSec: 60 }, 2: { stars: 1, bestTimeSec: 60 } },
      highestUnlocked: 25,
    });
    expect(achievements.isUnlocked("chapter_one_done")).toBe(false);
    c._persistWin(3, 1, 60); // chapter 1 = levels 1-3
    expect(achievements.isUnlocked("chapter_one_done")).toBe(true);
    expect(achievements.isUnlocked("chapter_two_done")).toBe(false);
  });

  it("completionist wants 3 stars on EVERY level, granted in the same call", () => {
    const completed = {};
    for (const l of CAMPAIGN_LEVELS) completed[l.id] = { stars: 3, bestTimeSec: 60 };
    completed[5] = { stars: 2, bestTimeSec: 60 }; // one hole
    c.saveProgress({ version: 1, completed, highestUnlocked: 26 });
    c._persistWin(1, 3, 60);
    expect(achievements.isUnlocked("completionist")).toBe(false);
    c._persistWin(5, 3, 60); // plug the hole
    expect(achievements.isUnlocked("completionist")).toBe(true);
  });

  it("minimalist counts services alive at the win (<= 4)", () => {
    for (let i = 0; i < 5; i++) place("s3");
    c._persistWin(1, 1, 60);
    expect(achievements.isUnlocked("minimalist")).toBe(false);
    STATE.services = STATE.services.slice(0, 4);
    c._persistWin(1, 1, 60);
    expect(achievements.isUnlocked("minimalist")).toBe(true);
  });

  it("pacifist_run wants a serverless-only board on a level 10 win", () => {
    place("serverless");
    place("compute");
    c._persistWin(10, 1, 60);
    expect(achievements.isUnlocked("pacifist_run")).toBe(false);
    STATE.services = STATE.services.filter((s) => s.type !== "compute");
    c._persistWin(10, 1, 60);
    expect(achievements.isUnlocked("pacifist_run")).toBe(true);
  });

  it("no_upgrades wants chapter 2+ and a zero upgrade counter", () => {
    STATE.campaign.upgradesPerformed = 0;
    c._persistWin(1, 1, 60); // chapter 1 never qualifies
    expect(achievements.isUnlocked("no_upgrades")).toBe(false);
    STATE.campaign.upgradesPerformed = 2;
    c._persistWin(4, 1, 60);
    expect(achievements.isUnlocked("no_upgrades")).toBe(false);
    STATE.campaign.upgradesPerformed = 0;
    c._persistWin(4, 1, 60);
    expect(achievements.isUnlocked("no_upgrades")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The upgrade counter feeding no_upgrades
// ---------------------------------------------------------------------------
describe("upgrade counter", () => {
  it("Service.upgrade() increments only after a real, affordable tier move", () => {
    STATE.campaign.upgradesPerformed = 0;
    const compute = place("compute");
    STATE.money = 100000;
    compute.upgrade();
    expect(STATE.campaign.upgradesPerformed).toBe(1);

    // Unaffordable: the early return must not count.
    const compute2 = place("compute");
    STATE.money = 0;
    compute2.upgrade();
    expect(STATE.campaign.upgradesPerformed).toBe(1);

    // Non-upgradeable type: no count.
    STATE.money = 100000;
    const waf = place("waf");
    waf.upgrade();
    expect(STATE.campaign.upgradesPerformed).toBe(1);

    // Max tier: no count.
    compute.upgrade(); // tier 2 -> 3 (counts)
    expect(STATE.campaign.upgradesPerformed).toBe(2);
    compute.upgrade(); // already max
    expect(STATE.campaign.upgradesPerformed).toBe(2);
  });

  it("CampaignController.loadLevel resets the counter", () => {
    STATE.campaign.upgradesPerformed = 7;
    const c = new CampaignController();
    expect(c.loadLevel(1)).toBe(true);
    expect(STATE.campaign.upgradesPerformed).toBe(0);
    c.exit();
  });
});

// ---------------------------------------------------------------------------
// Toast guard is cosmetics only; badge/panel surface
// ---------------------------------------------------------------------------
describe("unlock flow", () => {
  it("unlocks land immediately even inside the 3s toast quiet window", () => {
    achievements.onSessionStart(); // startedAtMs = now → quiet window active
    expect(achievements.msUntilToastsAllowed()).toBeGreaterThan(0);
    STATE.gameMode = "survival";
    STATE.elapsedGameTime = 61;
    // Baseline was captured at 61? No — captured at onSessionStart above with
    // elapsed 0 from resetWorld; advancing to 61 is 61 live seconds.
    pollOnce();
    expect(achievements.isUnlocked("first_minute")).toBe(true);
  });

  it("an unlock refreshes the main-menu Trophies badge", () => {
    const label = document.getElementById("trophies-progress-label");
    expect(label).toBeTruthy();
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    expect(label.textContent).toBe(`1/${ACHIEVEMENT_DEFS.length}`);
  });

  it("the Trophies panel renders every def, unlocked ones with a date", async () => {
    const { renderTrophiesPanel } = await import("../../src/achievements/ui.js");
    achievements.onSpikeStart();
    achievements.onSpikeEnd({ reputation: 100 });
    renderTrophiesPanel();
    const grid = document.getElementById("trophies-grid");
    expect(grid.children.length).toBe(ACHIEVEMENT_DEFS.length);
    expect(document.getElementById("trophies-count").textContent)
      .toBe(`1/${ACHIEVEMENT_DEFS.length}`);
  });
});

// ---------------------------------------------------------------------------
// Cardinal invariant: the engine observes, never mutates
// ---------------------------------------------------------------------------
describe("observation only", () => {
  it("a full poll evaluation leaves the sim state untouched", () => {
    STATE.gameMode = "survival";
    place("waf");
    place("db");
    achievements.onSessionStart();
    STATE.elapsedGameTime = 61;
    const snapshot = JSON.stringify({
      money: STATE.money,
      reputation: STATE.reputation,
      score: STATE.score,
      failures: STATE.failures,
      services: STATE.services.map((s) => [s.id, s.type, s.tier]),
      elapsed: STATE.elapsedGameTime,
      mode: STATE.gameMode,
    });
    pollOnce();
    const after = JSON.stringify({
      money: STATE.money,
      reputation: STATE.reputation,
      score: STATE.score,
      failures: STATE.failures,
      services: STATE.services.map((s) => [s.id, s.type, s.tier]),
      elapsed: STATE.elapsedGameTime,
      mode: STATE.gameMode,
    });
    expect(after).toBe(snapshot);
  });
});

// ===========================================================================
// Wave 2 (#234): the depth set — engine semantics. The achievability proofs
// (real replays, the survival marathon) live in achievements-proofs.test.mjs;
// these pin the sanitized-ctx semantics, the session baselines and the
// farmability gates.
// ===========================================================================

describe("wave 2 — resilience polls (survival-only, session deltas)", () => {
  beforeEach(() => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
  });

  it("failover_proven: a REAL SERVICE_OUTAGE event + rep >= 90 grants", () => {
    place("alb");
    place("db");
    triggerRandomEvent("SERVICE_OUTAGE"); // the real site bumps the counter
    expect(STATE.resilience.outages).toBe(1);
    STATE.reputation = 92;
    pollOnce();
    expect(achievements.isUnlocked("failover_proven")).toBe(true);
  });

  it("failover_proven: rep below 90 after the failure grants nothing", () => {
    STATE.resilience.outages = 1;
    STATE.reputation = 89.5;
    pollOnce();
    expect(achievements.isUnlocked("failover_proven")).toBe(false);
  });

  it("failover_proven: stale counters from a restored save earn nothing", () => {
    // A loaded save leaves the previous session's counters in memory:
    // baselines are captured AT onSessionStart, so only NEW failures count.
    STATE.resilience.outages = 4;
    STATE.resilience.trips = 2;
    achievements.onSessionStart(); // the loadGameState call site
    STATE.reputation = 100;
    pollOnce();
    expect(achievements.isUnlocked("failover_proven")).toBe(false);
    STATE.resilience.outages++; // a LIVE failure
    pollOnce();
    expect(achievements.isUnlocked("failover_proven")).toBe(true);
  });

  it("second_chance wants 50 LIVE retries", () => {
    STATE.resilience.retries = 30;
    achievements.onSessionStart(); // stale 30 becomes the baseline
    STATE.resilience.retries = 79; // +49 live
    pollOnce();
    expect(achievements.isUnlocked("second_chance")).toBe(false);
    STATE.resilience.retries = 80; // +50 live
    pollOnce();
    expect(achievements.isUnlocked("second_chance")).toBe(true);
  });

  it("nothing_lost wants 25 LIVE drains", () => {
    STATE.resilience.drained = 10;
    achievements.onSessionStart();
    STATE.resilience.drained = 34; // +24 live
    pollOnce();
    expect(achievements.isUnlocked("nothing_lost")).toBe(false);
    STATE.resilience.drained = 35; // +25 live
    pollOnce();
    expect(achievements.isUnlocked("nothing_lost")).toBe(true);
  });

  it("none of the resilience polls grant outside survival", () => {
    STATE.gameMode = "sandbox";
    achievements.onSessionStart();
    STATE.resilience.outages = 5;
    STATE.resilience.retries = 500;
    STATE.resilience.drained = 500;
    STATE.reputation = 100;
    pollOnce();
    expect(achievements.isUnlocked("failover_proven")).toBe(false);
    expect(achievements.isUnlocked("second_chance")).toBe(false);
    expect(achievements.isUnlocked("nothing_lost")).toBe(false);
  });
});

describe("wave 2 — the DLQ drain counter (the one-line #234 plumbing)", () => {
  it("tickDLQ bumps STATE.resilience.drained once per recovered request", () => {
    resetWorld();
    const compute = place("compute");
    const dlq = place("dlq");
    connect(compute, dlq);
    const req = new Request("WRITE");
    expect(parkInDLQ(req, compute)).toBe(true);
    expect(STATE.resilience.drained).toBe(0);
    for (let i = 0; i < 20; i++) step(0.1); // > drainIntervalSec
    expect(dlq.parked.length).toBe(0);
    expect(STATE.resilience.drained).toBe(1);
  });

  it("resetResilience() zeroes it with the other session counters", () => {
    STATE.resilience.drained = 7;
    resetWorld(); // calls resetResilience()
    expect(STATE.resilience.drained).toBe(0);
  });
});

describe("wave 2 — breaker_comeback (breakerClose event from the real sites)", () => {
  // Walk a placed service's breaker through its REAL state machine:
  // 8 recorded failures trip it (rate 1.0 over tripMinEvents), openSec of
  // game time half-opens it, probeCount successes close it.
  function tripAndClose(svc) {
    for (let i = 0; i < CONFIG.resilience.tripMinEvents; i++) {
      recordBreakerFailure(svc);
    }
    expect(svc.breakerState).toBe("open");
    updateBreaker(svc, CONFIG.resilience.openSec + 0.1);
    expect(svc.breakerState).toBe("half-open");
    for (let i = 0; i < CONFIG.resilience.probeCount; i++) {
      recordBreakerSuccess(svc);
    }
    expect(svc.breakerState).toBe("closed");
  }

  beforeEach(() => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
  });

  it("grants when a tripped breaker closes with rep >= 90 in survival", () => {
    const c = place("compute");
    STATE.reputation = 93;
    tripAndClose(c);
    expect(achievements.isUnlocked("breaker_comeback")).toBe(true);
  });

  it("does not grant when the close lands below 90", () => {
    const c = place("compute");
    STATE.reputation = 88;
    tripAndClose(c);
    expect(achievements.isUnlocked("breaker_comeback")).toBe(false);
  });

  it("does not grant outside survival", () => {
    STATE.gameMode = "sandbox";
    const c = place("compute");
    STATE.reputation = 100;
    tripAndClose(c);
    expect(achievements.isUnlocked("breaker_comeback")).toBe(false);
  });

  it("a session boundary between trip and close disarms (restored-save rule)", () => {
    const c = place("compute");
    STATE.reputation = 100;
    for (let i = 0; i < CONFIG.resilience.tripMinEvents; i++) {
      recordBreakerFailure(c);
    }
    expect(c.breakerState).toBe("open");
    achievements.onSessionStart(); // load/reset mid-open
    updateBreaker(c, CONFIG.resilience.openSec + 0.1);
    for (let i = 0; i < CONFIG.resilience.probeCount; i++) {
      recordBreakerSuccess(c);
    }
    expect(c.breakerState).toBe("closed"); // the close DID fire...
    expect(achievements.isUnlocked("breaker_comeback")).toBe(false); // ...unarmed
  });
});

describe("wave 2 — fleet_of_four poll semantics", () => {
  beforeEach(() => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
  });

  it("wants 4 READY instances on a player-placed ASG node", () => {
    const c = place("compute");
    c.asgEnabled = true;
    c.instances = 3;
    c.warming = [{ remaining: 2 }]; // warming carries no traffic: no credit
    pollOnce();
    expect(achievements.isUnlocked("fleet_of_four")).toBe(false);
    c.instances = 4;
    c.warming = [];
    pollOnce();
    expect(achievements.isUnlocked("fleet_of_four")).toBe(true);
  });

  it("a pre-built fleet earns nothing (player-placed only)", () => {
    createService("compute", new globalThis.THREE.Vector3(300, 0, 0), { playerPlaced: false });
    const c = STATE.services[STATE.services.length - 1];
    c.asgEnabled = true;
    c.instances = 5;
    pollOnce();
    expect(achievements.isUnlocked("fleet_of_four")).toBe(false);
  });

  it("never grants in sandbox", () => {
    STATE.gameMode = "sandbox";
    const c = place("compute");
    c.asgEnabled = true;
    c.instances = 5;
    pollOnce();
    expect(achievements.isUnlocked("fleet_of_four")).toBe(false);
  });
});

describe("wave 2 — megawatt (player-placed GPUs, mode-free per the variety precedent)", () => {
  it("three player-placed GPUs (18 kW) grant, the second does not", () => {
    place("power");
    place("power");
    place("gpu");
    place("gpu");
    pollOnce();
    expect(achievements.isUnlocked("megawatt")).toBe(false);
    place("gpu");
    pollOnce();
    expect(achievements.isUnlocked("megawatt")).toBe(true);
  });

  it("pre-built GPUs earn nothing", () => {
    for (let i = 0; i < 3; i++) {
      STATE.services.push(new Service("gpu", new globalThis.THREE.Vector3(200 + i * 8, 0, 40)));
    }
    pollOnce();
    expect(achievements.isUnlocked("megawatt")).toBe(false);
  });
});

describe("wave 2 — region_blackout poll (campaign-by-construction)", () => {
  it("reads the latched outage-completion delta: 60 grants, 59 does not", () => {
    STATE.campaign.regionOutage = { active: true, startedCompleted: 0 };
    STATE.campaign.completedByType = { READ: 59 };
    pollOnce();
    expect(achievements.isUnlocked("region_blackout")).toBe(false);
    STATE.campaign.completedByType.READ = 60;
    pollOnce();
    expect(achievements.isUnlocked("region_blackout")).toBe(true);
  });

  it("stays shut with no outage record (survival/sandbox boards)", () => {
    STATE.campaign.regionOutage = null;
    STATE.campaign.completedByType = { READ: 5000 };
    pollOnce();
    expect(achievements.isUnlocked("region_blackout")).toBe(false);
  });
});

describe("wave 2 — AI Wave levelWin defs via _persistWin", () => {
  let c;
  beforeEach(() => {
    c = new CampaignController();
    STATE.inference.expired = 0;
  });

  it("slo_clean: level 23 win with zero expiries only", () => {
    STATE.inference.expired = 1;
    c._persistWin(23, 1, 90);
    expect(achievements.isUnlocked("slo_clean")).toBe(false);
    STATE.inference.expired = 0;
    c._persistWin(22, 1, 90); // wrong level
    expect(achievements.isUnlocked("slo_clean")).toBe(false);
    c._persistWin(23, 1, 90);
    expect(achievements.isUnlocked("slo_clean")).toBe(true);
  });

  it("one_gpu_economist: level 22 win with EXACTLY one GPU alive", () => {
    c._persistWin(22, 1, 90); // zero GPUs: not the feat
    expect(achievements.isUnlocked("one_gpu_economist")).toBe(false);
    place("power");
    place("gpu");
    place("gpu");
    c._persistWin(22, 1, 90); // two GPUs: the trap build
    expect(achievements.isUnlocked("one_gpu_economist")).toBe(false);
    STATE.services = STATE.services.filter((s) => s.type !== "gpu");
    recomputePower(); // the test-side filter bypassed deleteObject
    place("gpu");
    c._persistWin(22, 1, 90);
    expect(achievements.isUnlocked("one_gpu_economist")).toBe(true);
  });

  it("small_model_big_heart: level 21 win on a tier-1 GPU only", () => {
    c._persistWin(21, 1, 90); // no GPU at all: no feat
    expect(achievements.isUnlocked("small_model_big_heart")).toBe(false);
    const gpu = place("gpu");
    STATE.money = 100000;
    gpu.upgrade(); // tier 2
    c._persistWin(21, 1, 90);
    expect(achievements.isUnlocked("small_model_big_heart")).toBe(false);
    STATE.services = STATE.services.filter((s) => s.type !== "gpu");
    recomputePower(); // the test-side filter bypassed deleteObject
    place("gpu"); // fresh tier 1
    c._persistWin(21, 1, 90);
    expect(achievements.isUnlocked("small_model_big_heart")).toBe(true);
  });
});

describe("wave 2 — late-game survival benchmarks", () => {
  beforeEach(() => {
    STATE.gameMode = "survival";
    achievements.onSessionStart();
  });

  it("quarter_hour wants 900 LIVE seconds (restored saves earn nothing)", () => {
    STATE.elapsedGameTime = 850;
    achievements.onSessionStart(); // the loadGameState site
    STATE.elapsedGameTime = 1749; // 899 live
    pollOnce();
    expect(achievements.isUnlocked("quarter_hour")).toBe(false);
    STATE.elapsedGameTime = 1751; // 901 live
    pollOnce();
    expect(achievements.isUnlocked("quarter_hour")).toBe(true);
  });

  it("high_score_200k reads the live run score, survival only", () => {
    STATE.score.total = 199999;
    pollOnce();
    expect(achievements.isUnlocked("high_score_200k")).toBe(false);
    STATE.score.total = 200000;
    pollOnce();
    expect(achievements.isUnlocked("high_score_200k")).toBe(true);
  });

  it("neither grants in sandbox", () => {
    STATE.gameMode = "sandbox";
    achievements.onSessionStart();
    STATE.elapsedGameTime = 2000;
    STATE.score.total = 1e6;
    pollOnce();
    expect(achievements.isUnlocked("quarter_hour")).toBe(false);
    expect(achievements.isUnlocked("high_score_200k")).toBe(false);
  });
});
