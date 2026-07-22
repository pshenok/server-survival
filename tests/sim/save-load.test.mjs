// Save/load over the REAL persistence module (#155 PR 10, tier 2):
// old-save migration, the PR-1 dead-fallback fix (spread-of-undefined gave {}
// instead of defaults), and a full services+connections round-trip through
// localStorage.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadGameState, saveGameState } from "../../src/persistence/save-load.js";
import { STATE, CONFIG, resetWorld, place, connect } from "../helpers/sim-world.mjs";

const SAVE_KEY = "serverSurvivalSave";

beforeEach(() => {
  resetWorld();
  globalThis.localStorage.removeItem(SAVE_KEY);
  globalThis.alertCalls.length = 0;
});

afterEach(() => {
  // loadGameState kicks off the animate rAF loop; stop it so frames from one
  // test never tick into the next.
  if (STATE.animationId) {
    globalThis.cancelAnimationFrame(STATE.animationId);
    STATE.animationId = null;
  }
});

function baseSave(extra = {}) {
  return {
    version: "2.0",
    money: 777,
    reputation: 55,
    requestsProcessed: 123,
    isRunning: false,
    services: [],
    connections: [],
    internetConnections: [],
    ...extra,
  };
}

describe("migrateOldSave (via loadGameState on a version-less/1.0 save)", () => {
  it("maps the old WEB/API/FRAUD traffic mix onto the new six types", () => {
    loadGameState(baseSave({
      version: "1.0",
      trafficDistribution: { WEB: 0.5, API: 0.4, FRAUD: 0.1 },
    }));

    expect(STATE.trafficDistribution).toEqual({
      STATIC: 0.5,
      READ: 0.4 * 0.5,
      WRITE: 0.4 * 0.3,
      UPLOAD: 0.05,
      SEARCH: 0.4 * 0.2,
      MALICIOUS: 0.1,
    });
    expect(globalThis.alertCalls).toHaveLength(0); // no load-failure alert
  });

  it("maps the old web/api/fraudBlocked score fields", () => {
    loadGameState(baseSave({
      version: undefined,
      score: { total: 100, web: 30, api: 50, fraudBlocked: 20 },
    }));

    expect(STATE.score).toEqual({
      total: 100,
      storage: 30,
      database: 50,
      maliciousBlocked: 20,
    });
  });

  it("leaves a new-format mix untouched for version 2.0", () => {
    const dist = { STATIC: 0.1, READ: 0.2, WRITE: 0.3, UPLOAD: 0.1, SEARCH: 0.1, MALICIOUS: 0.2 };
    loadGameState(baseSave({ trafficDistribution: { ...dist } }));
    expect(STATE.trafficDistribution).toEqual(dist);
  });
});

describe("fallback defaults (the PR-1 dead-fallback fix)", () => {
  it("a save without score gets zeroed defaults, not {} (no NaN score math)", () => {
    loadGameState(baseSave());
    expect(STATE.score).toEqual({ total: 0, storage: 0, database: 0, maliciousBlocked: 0 });
    expect(Number.isNaN(STATE.score.total)).toBe(false);
  });

  it("a save without trafficDistribution gets the default mix", () => {
    loadGameState(baseSave());
    expect(STATE.trafficDistribution).toEqual({
      STATIC: 0.3, READ: 0.2, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.2,
    });
  });

  it("a save without finances gets zeroed finance tracking (not a reset-to-undefined)", () => {
    loadGameState(baseSave());
    expect(STATE.finances.income.total).toBe(0);
    expect(STATE.finances.expenses.byService.serverless).toBe(0);
  });

  it("saved finances survive the load instead of being wiped", () => {
    loadGameState(baseSave({
      finances: {
        income: { total: 42, requests: 42 },
        expenses: { upkeep: 7 },
      },
    }));
    expect(STATE.finances.income.total).toBe(42);
    expect(STATE.finances.expenses.upkeep).toBe(7);
    // Missing buckets are back-filled from the defaults.
    expect(STATE.finances.expenses.byService.waf).toBe(0);
  });

  it("scalar fields restore with sane defaults for missing values", () => {
    loadGameState(baseSave());
    expect(STATE.money).toBe(777);
    expect(STATE.reputation).toBe(55);
    expect(STATE.requestsProcessed).toBe(123);
    expect(STATE.timeScale).toBe(0); // always starts paused
    expect(STATE.gameMode).toBe("survival");
  });

  it("loading with no stored save alerts and leaves STATE alone", () => {
    STATE.money = 4321;
    loadGameState(); // no arg, empty localStorage
    expect(globalThis.alertCalls.length).toBeGreaterThan(0);
    expect(STATE.money).toBe(4321);
  });
});

describe("save -> load round trip", () => {
  it("restores services (type, id, position, tier) and connections", () => {
    const waf = place("waf");
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", waf);
    connect(waf, alb);
    connect(alb, compute);
    connect(compute, db);
    compute.tier = 2;
    compute.config = { ...compute.config, capacity: CONFIG.services.compute.tiers[1].capacity };

    STATE.money = 999;
    STATE.requestsProcessed = 55;
    saveGameState("browser");
    expect(globalThis.localStorage.getItem(SAVE_KEY)).toBeTruthy();

    const savedIds = { waf: waf.id, alb: alb.id, compute: compute.id, db: db.id };

    // Wreck the live state, then load from storage.
    resetWorld({ money: 0 });
    loadGameState();

    expect(STATE.money).toBe(999);
    expect(STATE.requestsProcessed).toBe(55);
    expect(STATE.services).toHaveLength(4);

    const byId = Object.fromEntries(STATE.services.map((s) => [s.id, s]));
    expect(byId[savedIds.waf].type).toBe("waf");
    expect(byId[savedIds.compute].tier).toBe(2);
    expect(byId[savedIds.compute].config.capacity).toBe(
      CONFIG.services.compute.tiers[1].capacity
    );

    expect(STATE.internetNode.connections).toEqual([savedIds.waf]);
    expect(byId[savedIds.waf].connections).toEqual([savedIds.alb]);
    expect(byId[savedIds.alb].connections).toEqual([savedIds.compute]);
    expect(byId[savedIds.compute].connections).toEqual([savedIds.db]);
    // 4 = internet edge + 3 service edges. The internet edge is stored BOTH in
    // saveData.connections and saveData.internetConnections; createConnection's
    // duplicate check keeps the restore from double-wiring it.
    expect(STATE.connections).toHaveLength(4);
  });

  it("restores service positions through the THREE.Vector3 rebuild", () => {
    const waf = place("waf");
    const savedPos = { x: waf.position.x, z: waf.position.z };
    saveGameState("browser");

    resetWorld();
    loadGameState();

    expect(STATE.services).toHaveLength(1);
    expect(STATE.services[0].position.x).toBe(savedPos.x);
    expect(STATE.services[0].position.z).toBe(savedPos.z);
  });

  it("in-flight requests are never persisted", () => {
    saveGameState("browser");
    const data = JSON.parse(globalThis.localStorage.getItem(SAVE_KEY));
    expect(data.requests).toEqual([]);
  });

  it("a corrupted stored save alerts instead of throwing", () => {
    globalThis.localStorage.setItem(SAVE_KEY, "{corrupt");
    loadGameState();
    expect(globalThis.alertCalls.length).toBeGreaterThan(0);
  });
});
