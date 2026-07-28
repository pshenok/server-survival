// Multi-region failover (#221) over the REAL modules: the region-subtree
// computation, the forced region outage (trigger / restore / pause-resume
// re-disable), GeoDNS shifting 100% of traffic to the surviving region and
// back, the completedDuringRegionOutage watermark — and the leak battery
// proving THE CARDINAL INVARIANT: a request caught inside the dying region
// terminates (fails or is removed), it never hangs in a dead queue.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeRegionSubtree,
  endRandomEvent,
  triggerRandomEvent,
  triggerRegionOutage,
  updateRegionOutage,
} from "../../src/core/events.js";
import { CampaignController } from "../../src/campaign/campaign.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { CampaignObjectives } from "../../src/campaign/objectives.js";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import { STATE, CONFIG, resetWorld, place, connect, run, step } from "../helpers/sim-world.mjs";

beforeEach(() => {
  resetWorld();
  // Region-outage state lives on STATE.campaign and is normally reset by
  // loadLevel; these tests drive the event directly, so reset it here.
  STATE.campaign.regionOutage = null;
  STATE.campaign.regionOutageFired = false;
  STATE.campaign.completedByType = { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 };
  STATE.campaign.completedByService = {};
  STATE.intervention.activeEvent = null;
  STATE.intervention.outageServiceId = null;
  STATE.intervention.pausedEvent = null;
  const warnings = document.getElementById("intervention-warnings");
  if (warnings) warnings.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The canonical two-region board: one GeoDNS fanning out to two complete
// WAF → ALB → Compute stacks that share a single backend DB.
function buildTwoRegions() {
  const dns = place("dns");
  const wafA = place("waf");
  const albA = place("alb");
  const computeA = place("compute");
  const wafB = place("waf");
  const albB = place("alb");
  const computeB = place("compute");
  const db = place("db");
  connect("internet", dns);
  connect(dns, wafA);
  connect(wafA, albA);
  connect(albA, computeA);
  connect(computeA, db);
  connect(dns, wafB);
  connect(wafB, albB);
  connect(albB, computeB);
  connect(computeB, db);
  return { dns, wafA, albA, computeA, wafB, albB, computeB, db };
}

function ids(services) {
  return services.map((s) => s.id).sort();
}

function inject(type = "READ") {
  const req = new Request(type);
  STATE.requests.push(req);
  routeRequestToEntry(req, type);
  return req;
}

function injectTo(service, type = "READ") {
  const req = new Request(type);
  STATE.requests.push(req);
  req.flyTo(service);
  return req;
}

function inFlight() {
  return STATE.requests.length;
}

function flushFailFades() {
  vi.advanceTimersByTime(2000);
}

// A campaign controller wired for the forced region outage, without touching
// the real level list or the DOM-heavy startCampaignLevel path. The one
// never-true primary objective keeps _checkEndConditions from ending the run.
function campaignWithRegionOutage(atSec = 35, durationSec = 25) {
  const c = new CampaignController();
  c.active = true;
  STATE.campaign.active = true;
  STATE.campaign.ended = false;
  STATE.campaign.level = {
    forceRegionOutageAtSec: atSec,
    regionOutageDurationSec: durationSec,
    objectives: { primary: [{ id: "never", label: "", check: () => false }], bonus: [] },
    failConditions: {},
  };
  return c;
}

// ---------------------------------------------------------------------------
// Region-subtree computation
// ---------------------------------------------------------------------------
describe("computeRegionSubtree", () => {
  it("kills exactly the exclusive stack behind the front door", () => {
    const { wafA, albA, computeA } = buildTwoRegions();
    expect(computeRegionSubtree(wafA.id).sort()).toEqual(ids([wafA, albA, computeA]));
  });

  it("a shared backend reachable from the other region stays up", () => {
    const { wafA, db } = buildTwoRegions();
    expect(computeRegionSubtree(wafA.id)).not.toContain(db.id);
  });

  it("with no second region, the shared DB dies with the only stack", () => {
    const dns = place("dns");
    const wafA = place("waf");
    const albA = place("alb");
    const computeA = place("compute");
    const db = place("db");
    connect("internet", dns);
    connect(dns, wafA);
    connect(wafA, albA);
    connect(albA, computeA);
    connect(computeA, db);
    expect(computeRegionSubtree(wafA.id).sort()).toEqual(ids([wafA, albA, computeA, db]));
  });

  it("a node fed by another Internet entry survives the region", () => {
    const { wafA, albA, computeA } = buildTwoRegions();
    // A second front door wired straight to the Internet AND into region A's
    // balancer: albA (and everything below it) now has a path that does not
    // run through the dying front door, so only wafA itself goes dark.
    const spare = place("waf");
    connect("internet", spare);
    connect(spare, albA);
    const region = computeRegionSubtree(wafA.id);
    expect(region).toEqual([wafA.id]);
    expect(region).not.toContain(albA.id);
    expect(region).not.toContain(computeA.id);
  });

  it("terminates and stays correct when the graph has a cycle", () => {
    const { wafA, albA, computeA } = buildTwoRegions();
    // Hand-crafted upward edge (createConnection would refuse it): the BFS
    // must not loop forever, and the region must not change.
    computeA.connections.push(wafA.id);
    expect(computeRegionSubtree(wafA.id).sort()).toEqual(ids([wafA, albA, computeA]));
    computeA.connections.pop();
  });
});

// ---------------------------------------------------------------------------
// Trigger / restore lifecycle through CampaignController.tick
// ---------------------------------------------------------------------------
describe("forced region outage lifecycle", () => {
  it("does not fire before forceRegionOutageAtSec", () => {
    const { wafA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 34;
    c.tick(0.1);
    expect(STATE.campaign.regionOutageFired).toBe(false);
    expect(wafA.isDisabled).toBeFalsy();
  });

  it("fires at T: the region is disabled, the rest of the board is not", () => {
    const { wafA, albA, computeA, wafB, albB, computeB, db, dns } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    for (const s of [wafA, albA, computeA]) expect(s.isDisabled).toBe(true);
    for (const s of [dns, wafB, albB, computeB, db]) expect(s.isDisabled).toBeFalsy();
  });

  it("uses the ghosted-mesh visual contract of SERVICE_OUTAGE", () => {
    const { wafA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    expect(wafA.mesh.material.opacity).toBe(0.3);
    expect(wafA.mesh.material.transparent).toBe(true);
  });

  it("bumps the resilience outage counter exactly once", () => {
    buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    c.tick(0.1);
    c.tick(0.1);
    expect(STATE.resilience.outages).toBe(1);
    expect(STATE.campaign.regionOutageFired).toBe(true);
  });

  it("fires the intervention warning", () => {
    buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    const warnings = document.getElementById("intervention-warnings");
    expect(warnings.children.length).toBeGreaterThan(0);
  });

  it("restores the same region after regionOutageDurationSec of game time", () => {
    const { wafA, albA, computeA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    STATE.elapsedGameTime = 60;
    c.tick(0.1);
    for (const s of [wafA, albA, computeA]) {
      expect(s.isDisabled).toBe(false);
      expect(s.mesh.material.opacity).toBe(1.0);
      expect(s.mesh.material.transparent).toBe(false);
    }
    expect(STATE.campaign.regionOutage.active).toBe(false);
  });

  it("the restore clock is game time: a paused game never shortens the outage", () => {
    const { wafA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    // Paused: elapsedGameTime is frozen (animate adds dt * timeScale = 0),
    // however many frames pass.
    for (let i = 0; i < 200; i++) c.tick(0);
    expect(wafA.isDisabled).toBe(true);
    expect(STATE.campaign.regionOutage.active).toBe(true);
  });

  it("re-disables the SAME region after a pause clobbers the disable flags", () => {
    const { wafA, albA, computeA, db } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);

    // A random SERVICE_OUTAGE is live on the shared DB when the player
    // pauses: handleGameState ends it, and endRandomEvent's cleanup
    // re-enables EVERY disabled service — the region's included.
    triggerRandomEvent("SERVICE_OUTAGE", 30000, db.id);
    expect(db.isDisabled).toBe(true);
    endRandomEvent();
    expect(wafA.isDisabled).toBe(false); // the clobber this test is about
    expect(db.isDisabled).toBe(false);

    // Resume: the next campaign tick re-darkens the same region — and only it.
    c.tick(0.1);
    for (const s of [wafA, albA, computeA]) expect(s.isDisabled).toBe(true);
    expect(db.isDisabled).toBe(false);
  });

  it("the restore leaves a node alone while a random SERVICE_OUTAGE owns it", () => {
    const { wafA, albA, computeA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    // A random outage independently picks a node inside the dark region.
    triggerRandomEvent("SERVICE_OUTAGE", 60000, computeA.id);
    STATE.elapsedGameTime = 60;
    c.tick(0.1);
    expect(wafA.isDisabled).toBe(false);
    expect(albA.isDisabled).toBe(false);
    expect(computeA.isDisabled).toBe(true); // endRandomEvent owns this restore
  });

  it("survives a service demolished mid-outage", () => {
    const { wafA, albA } = buildTwoRegions();
    const c = campaignWithRegionOutage(35, 25);
    STATE.elapsedGameTime = 35;
    c.tick(0.1);
    // Player demolishes the dead balancer while the region is dark.
    albA.destroy();
    STATE.services = STATE.services.filter((s) => s !== albA);
    STATE.elapsedGameTime = 60;
    expect(() => c.tick(0.1)).not.toThrow();
    expect(wafA.isDisabled).toBe(false);
  });

  it("is inert with no DNS front door on the board", () => {
    const waf = place("waf");
    connect("internet", waf);
    expect(triggerRegionOutage(25)).toBe(false);
    expect(waf.isDisabled).toBeFalsy();
    expect(STATE.resilience.outages).toBe(0);
    expect(STATE.campaign.regionOutage).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// GeoDNS failover: 100% of traffic shifts to the live region, and back
// ---------------------------------------------------------------------------
describe("GeoDNS traffic shift", () => {
  it("during the outage every request completes through region B; region A sees nothing", () => {
    const world = buildTwoRegions();
    triggerRegionOutage(1000);

    // 4 READs, injected through the real entry routing. Kept at 4 so region
    // B's single Compute stays at/below 50% load — the failure roll is 0 and
    // the test is deterministic.
    for (let i = 0; i < 4; i++) inject("READ");
    let regionATouched = 0;
    for (let i = 0; i < 100; i++) {
      step(0.1);
      regionATouched +=
        world.wafA.queue.length + world.wafA.processing.length + world.wafA.incomingCount +
        world.albA.queue.length + world.albA.processing.length + world.albA.incomingCount +
        world.computeA.queue.length + world.computeA.processing.length + world.computeA.incomingCount;
    }

    expect(STATE.requestsProcessed).toBe(4); // all completed — via region B
    expect(regionATouched).toBe(0);
  });

  it("after the restore, round-robin spreads traffic back across BOTH regions", () => {
    const world = buildTwoRegions();
    triggerRegionOutage(5);
    STATE.elapsedGameTime += 5;
    updateRegionOutage();
    expect(world.wafA.isDisabled).toBe(false);

    let regionASaw = 0;
    let regionBSaw = 0;
    for (let i = 0; i < 8; i++) {
      inject("READ");
      for (let f = 0; f < 15; f++) {
        step(0.1);
        regionASaw += world.wafA.queue.length + world.wafA.processing.length + world.wafA.incomingCount;
        regionBSaw += world.wafB.queue.length + world.wafB.processing.length + world.wafB.incomingCount;
      }
    }
    expect(regionASaw).toBeGreaterThan(0);
    expect(regionBSaw).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE CARDINAL INVARIANT: nothing caught in the dead region may hang
// ---------------------------------------------------------------------------
describe("region outage leak battery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function accounted() {
    const failures = Object.values(STATE.failures).reduce((a, b) => a + b, 0);
    const blocked =
      STATE.score.maliciousBlocked / CONFIG.survival.SCORE_POINTS.MALICIOUS_BLOCKED_SCORE;
    return STATE.requestsProcessed + failures + blocked;
  }

  function assertDrained() {
    expect(inFlight()).toBe(0);
    for (const s of STATE.services) {
      expect(s.queue, `${s.type} queue`).toHaveLength(0);
      expect(s.processing, `${s.type} processing`).toHaveLength(0);
      expect(s.incomingCount, `${s.type} incoming`).toBe(0);
    }
  }

  it("requests queued and processing inside the region terminate at lights-out", () => {
    const { wafA } = buildTwoRegions();
    for (let i = 0; i < 10; i++) injectTo(wafA, "READ");
    run(0.5); // exactly the flight time: the batch lands in the WAF's queue
    expect(wafA.queue.length + wafA.processing.length).toBeGreaterThan(0);

    triggerRegionOutage(1000);
    expect(wafA.queue).toHaveLength(0);
    expect(wafA.processing).toHaveLength(0);

    run(5); // stragglers that were already forwarded deeper drain via B or fail
    flushFailFades();
    assertDrained();
    expect(accounted()).toBe(10);
  });

  it("a request mid-air INTO the dying region terminates and frees its slot", () => {
    const { wafA } = buildTwoRegions();
    const req = injectTo(wafA, "READ");
    expect(req.isMoving).toBe(true);
    expect(wafA.incomingCount).toBe(1);

    triggerRegionOutage(1000);
    expect(wafA.incomingCount).toBe(0);
    expect(req.failed).toBe(true);

    run(2);
    flushFailFades();
    assertDrained();
    expect(STATE.failures.READ).toBe(1);
  });

  it("failed region requests carry the REGION_DOWN attribution, not a breach", () => {
    const { wafA } = buildTwoRegions();
    injectTo(wafA, "READ");
    run(0.6);
    const repBefore = STATE.reputation;
    triggerRegionOutage(1000);
    // One plain failure: -1 reputation, no -5 breach, no breach money hit.
    expect(STATE.failures.READ).toBe(1);
    expect(STATE.failures.MALICIOUS).toBe(0);
    expect(STATE.reputation).toBe(repBefore + CONFIG.survival.SCORE_POINTS.FAIL_REPUTATION);
  });

  it("MALICIOUS caught in the dead region is removed silently — no breach, no block", () => {
    const { wafA } = buildTwoRegions();
    // Straight into the queue (skip the flight) so the WAF has not blocked it yet.
    const req = injectTo(wafA, "MALICIOUS");
    req.isMoving = false;
    req.progress = 1;
    wafA.incomingCount = 0;
    wafA.queue.push(req);

    const repBefore = STATE.reputation;
    const moneyBefore = STATE.money;
    triggerRegionOutage(1000);

    expect(inFlight()).toBe(0); // removed immediately, no fade timer
    expect(STATE.failures.MALICIOUS).toBe(0);
    expect(STATE.score.maliciousBlocked).toBe(0);
    expect(STATE.reputation).toBe(repBefore);
    expect(STATE.money).toBe(moneyBefore);
  });

  it("no request ever hangs at a dark node while the outage runs", () => {
    const world = buildTwoRegions();
    for (let i = 0; i < 12; i++) inject("READ");
    run(0.8); // spread across dns/regionA/regionB mid-flight
    triggerRegionOutage(1000);
    run(3);
    for (const s of [world.wafA, world.albA, world.computeA]) {
      expect(s.queue).toHaveLength(0);
      expect(s.processing).toHaveLength(0);
      expect(s.incomingCount).toBe(0);
    }
  });

  it("full battery: live traffic through outage AND restore drains to zero", () => {
    buildTwoRegions();
    let injected = 0;
    const pump = (n) => {
      for (let i = 0; i < n; i++) {
        inject(i % 5 === 0 ? "MALICIOUS" : "READ");
        injected++;
        run(0.3);
      }
    };

    pump(8); // healthy two-region flow
    triggerRegionOutage(6);
    pump(8); // one-region flow
    STATE.elapsedGameTime += 6;
    updateRegionOutage();
    expect(STATE.campaign.regionOutage.active).toBe(false);
    pump(8); // both regions again

    run(25);
    flushFailFades();
    assertDrained();
    expect(accounted()).toBe(injected);
  });
});

// ---------------------------------------------------------------------------
// Objective helpers
// ---------------------------------------------------------------------------
describe("completedDuringRegionOutage", () => {
  it("is 0 before any outage fired", () => {
    expect(CampaignObjectives.completedDuringRegionOutage(STATE)).toBe(0);
  });

  it("grows live while the region is dark and freezes at the restore", () => {
    buildTwoRegions();
    STATE.campaign.completedByType.READ = 40;
    triggerRegionOutage(10);
    expect(CampaignObjectives.completedDuringRegionOutage(STATE)).toBe(0);

    STATE.campaign.completedByType.READ = 95; // 55 completed during the dark
    expect(CampaignObjectives.completedDuringRegionOutage(STATE)).toBe(55);

    STATE.elapsedGameTime += 10;
    updateRegionOutage(); // restore stamps the end watermark
    STATE.campaign.completedByType.READ = 200; // after-restore traffic
    expect(CampaignObjectives.completedDuringRegionOutage(STATE)).toBe(55);
  });

  it("a region outage satisfies survivedNodeFailure", () => {
    buildTwoRegions();
    triggerRegionOutage(10);
    STATE.reputation = 80;
    expect(CampaignObjectives.survivedNodeFailure(STATE, 70)).toBe(true);
    STATE.reputation = 50;
    expect(CampaignObjectives.survivedNodeFailure(STATE, 70)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Level 20 lesson invariants (the generic schema checks ride levels.test.mjs)
// ---------------------------------------------------------------------------
describe("level 20 — Two Regions", () => {
  const level = CAMPAIGN_LEVELS.find((l) => l.id === 20);

  it("exists in chapter 4 with the region outage announced and configured", () => {
    expect(level).toBeTruthy();
    expect(level.chapter).toBe(4);
    expect(level.forceRegionOutageAtSec).toBeGreaterThan(0);
    expect(level.regionOutageDurationSec).toBeGreaterThan(0);
  });

  it("restores within the level so the player sees traffic shift back", () => {
    expect(level.forceRegionOutageAtSec + level.regionOutageDurationSec)
      .toBeLessThan(level.durationSec);
  });

  it("pre-builds DNS + one full region + the shared DB, and sells region B's parts", () => {
    const types = level.preBuilt.services.map((s) => s.type);
    expect(types).toEqual(["dns", "waf", "alb", "compute", "db"]);
    expect(level.allowedServices.sort()).toEqual(["alb", "compute", "waf"]);
    const regionBCost = ["waf", "alb", "compute"]
      .reduce((sum, t) => sum + CONFIG.services[t].cost, 0);
    expect(level.budget).toBeGreaterThanOrEqual(regionBCost);
  });

  it("wins through the resilience counter the region outage bumps", () => {
    STATE.resilience.outages = 1;
    STATE.reputation = 90;
    STATE.campaign.completedByType.READ = 300;
    STATE.campaign.regionOutage = null;
    for (const o of level.objectives.primary) {
      // Both primaries hold on a healthy post-outage board.
      expect(o.check(STATE)).toBe(true);
    }
  });
});
