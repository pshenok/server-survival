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
import { describe, it, expect, beforeEach } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { spawnRequest } from "../../src/core/actions.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { startCampaignLevel } from "../../src/ui/campaign-ui.js";
import { STATE, resetWorld } from "../helpers/sim-world.mjs";

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

function runUntilEnded(capSec, dt = 0.1) {
  for (let t = 0; t < capSec; t += dt) {
    if (STATE.campaign.ended) break;
    frame(dt);
  }
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
