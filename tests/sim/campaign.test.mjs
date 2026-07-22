// CampaignController persistence + lifecycle (#155 PR 10, tier 2 — the
// controller's import chain reaches game.js, so it runs in the sim env).
// Covers the localStorage schema, unlock/star logic, the #183 NaN-guard in
// _persistWin, and the monotonic _session id.
import { describe, it, expect, beforeEach } from "vitest";
import { CampaignController } from "../../src/campaign/campaign.js";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { STATE, resetWorld } from "../helpers/sim-world.mjs";

const KEY = "serverSurvivalCampaignProgress";
const store = () => globalThis.localStorage;

let c;
beforeEach(() => {
  resetWorld();
  store().removeItem(KEY);
  c = new CampaignController();
});

describe("loadProgress", () => {
  it("returns empty progress when nothing is stored", () => {
    expect(c.loadProgress()).toEqual({ version: 1, completed: {}, highestUnlocked: 1 });
  });

  it("round-trips through saveProgress", () => {
    const p = { version: 1, completed: { 1: { stars: 3, bestTimeSec: 42, lastPlayed: 5 } }, highestUnlocked: 2 };
    c.saveProgress(p);
    expect(c.loadProgress()).toEqual(p);
  });

  it("resets on a schema version mismatch", () => {
    store().setItem(KEY, JSON.stringify({ version: 999, completed: { 1: { stars: 3 } }, highestUnlocked: 9 }));
    expect(c.loadProgress().highestUnlocked).toBe(1);
  });

  it("resets on corrupt JSON instead of throwing", () => {
    store().setItem(KEY, "{not json");
    expect(c.loadProgress()).toEqual({ version: 1, completed: {}, highestUnlocked: 1 });
  });
});

describe("unlocks and stars", () => {
  it("only level 1 is unlocked initially", () => {
    expect(c.isUnlocked(1)).toBe(true);
    expect(c.isUnlocked(2)).toBe(false);
  });

  it("getStarsFor / totalStars / completedCount read the completed table", () => {
    c.saveProgress({
      version: 1,
      completed: { 1: { stars: 2 }, 2: { stars: 3 } },
      highestUnlocked: 3,
    });
    expect(c.getStarsFor(1)).toBe(2);
    expect(c.getStarsFor(5)).toBe(0);
    expect(c.totalStars()).toBe(5);
    expect(c.completedCount()).toBe(2);
  });
});

describe("_persistWin", () => {
  it("stores stars/bestTime and unlocks the next level", () => {
    c._persistWin(1, 2, 90);
    const p = c.loadProgress();
    expect(p.completed[1].stars).toBe(2);
    expect(p.completed[1].bestTimeSec).toBe(90);
    expect(p.highestUnlocked).toBe(2);
  });

  it("keeps the better star count and the better time across wins", () => {
    c._persistWin(1, 3, 120);
    c._persistWin(1, 1, 80); // worse stars, better time
    const p = c.loadProgress();
    expect(p.completed[1].stars).toBe(3);
    expect(p.completed[1].bestTimeSec).toBe(80);
  });

  it("never regresses highestUnlocked when replaying an old level", () => {
    c._persistWin(3, 1, 100);
    c._persistWin(1, 1, 100);
    expect(c.loadProgress().highestUnlocked).toBe(4);
  });

  it("#183 NaN-guard: a hand-edited entry missing bestTimeSec does not poison the best time", () => {
    c.saveProgress({
      version: 1,
      completed: { 1: { stars: 1 } }, // no bestTimeSec
      highestUnlocked: 2,
    });
    c._persistWin(1, 1, 77);
    const p = c.loadProgress();
    expect(p.completed[1].bestTimeSec).toBe(77);
    expect(Number.isFinite(p.completed[1].bestTimeSec)).toBe(true);
  });
});

describe("loadLevel", () => {
  it("rejects an unknown level id", () => {
    expect(c.loadLevel(999)).toBe(false);
    expect(c.active).toBe(false);
  });

  it("rejects a locked level", () => {
    const lastId = CAMPAIGN_LEVELS[CAMPAIGN_LEVELS.length - 1].id;
    if (lastId > 1) {
      expect(c.loadLevel(lastId)).toBe(false);
      expect(c.active).toBe(false);
    }
  });

  it("activates the level and seeds fresh campaign counters", () => {
    expect(c.loadLevel(1)).toBe(true);
    expect(c.active).toBe(true);
    expect(STATE.campaign.currentLevelId).toBe(1);
    expect(STATE.campaign.ended).toBe(false);
    expect(STATE.campaign.completedByType).toEqual({
      STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0,
    });
    expect(STATE.campaign.completedByService).toEqual({});
  });

  it("increments the monotonic _session id on every load (stale-burst guard)", () => {
    c.loadLevel(1);
    const first = c._session;
    c.loadLevel(1);
    expect(c._session).toBe(first + 1);
  });
});

describe("onRequestCompleted", () => {
  it("bumps per-type and per-service counters while active", () => {
    c.loadLevel(1);
    c.onRequestCompleted({ type: "READ" }, "replica");
    c.onRequestCompleted({ type: "READ" }, "db");
    c.onRequestCompleted({ type: "WRITE" }, "nosql");
    expect(STATE.campaign.completedByType.READ).toBe(2);
    expect(STATE.campaign.completedByType.WRITE).toBe(1);
    expect(STATE.campaign.completedByService.replica).toBe(1);
    expect(STATE.campaign.completedByService.nosql).toBe(1);
  });

  it("is inert when the campaign is not active", () => {
    STATE.campaign.completedByType = { READ: 0 };
    c.active = false;
    c.onRequestCompleted({ type: "READ" }, "db");
    expect(STATE.campaign.completedByType.READ).toBe(0);
  });
});

describe("_calculateStars", () => {
  function level(durationSec) {
    return {
      durationSec,
      objectives: { primary: [], bonus: [{ id: "b1" }] },
    };
  }

  it("1 star for a plain completion", () => {
    STATE.campaign.level = level(100);
    STATE.campaign.bonusResults = {};
    STATE.elapsedGameTime = 95;
    expect(c._calculateStars()).toBe(1);
  });

  it("+1 star for a met bonus objective", () => {
    STATE.campaign.level = level(100);
    STATE.campaign.bonusResults = { b1: true };
    STATE.elapsedGameTime = 95;
    expect(c._calculateStars()).toBe(2);
  });

  it("+1 star for finishing under 80% of the duration; capped at 3", () => {
    STATE.campaign.level = level(100);
    STATE.campaign.bonusResults = { b1: true };
    STATE.elapsedGameTime = 79;
    expect(c._calculateStars()).toBe(3);
  });
});
