// Economy math over the REAL modules (#155 PR 10, tier 2): auto-repair
// upkeep, the serverless per-invocation charge, upkeep scaling, and the
// load-based failure curve.
import { describe, it, expect, beforeEach } from "vitest";
import { getAutoRepairUpkeep, processAutoRepair } from "../../src/core/economy.js";
import { chargeServerlessInvocation } from "../../src/sim/handlers/serverless.js";
import {
  calculateFailChanceBasedOnLoad,
  getUpkeepMultiplier,
} from "../../src/core/actions.js";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import { STATE, CONFIG, resetWorld, place, connect, run } from "../helpers/sim-world.mjs";

beforeEach(() => resetWorld());

describe("getAutoRepairUpkeep", () => {
  it("is 0 while auto-repair is off", () => {
    place("db");
    STATE.autoRepairEnabled = false;
    expect(getAutoRepairUpkeep()).toBe(0);
  });

  it("charges autoRepairCostPercent of total service cost per minute", () => {
    place("db"); // 150
    place("waf"); // 40
    STATE.autoRepairEnabled = true;
    const pct = CONFIG.survival.degradation.autoRepairCostPercent; // 0.1
    expect(getAutoRepairUpkeep()).toBeCloseTo(((150 + 40) * pct) / 60, 10);
  });

  it("scales with the number of services", () => {
    STATE.autoRepairEnabled = true;
    place("s3"); // 25
    const one = getAutoRepairUpkeep();
    place("s3");
    expect(getAutoRepairUpkeep()).toBeCloseTo(one * 2, 10);
  });
});

describe("processAutoRepair", () => {
  it("heals damaged services at 5 hp/s in survival mode", () => {
    resetWorld({ gameMode: "survival" });
    const db = place("db");
    db.health = 50;
    STATE.autoRepairEnabled = true;
    processAutoRepair(2);
    expect(db.health).toBeCloseTo(60, 5);
  });

  it("does nothing outside survival mode", () => {
    const db = place("db");
    db.health = 50;
    STATE.autoRepairEnabled = true;
    processAutoRepair(2); // gameMode sandbox
    expect(db.health).toBe(50);
  });
});

describe("serverless per-invocation charge", () => {
  it("chargeServerlessInvocation debits perRequestCost and books it as upkeep", () => {
    const fn = place("serverless");
    const moneyBefore = STATE.money;
    const byServiceBefore = STATE.finances.expenses.byService.serverless; // purchase cost
    chargeServerlessInvocation(fn);
    expect(STATE.money).toBeCloseTo(moneyBefore - CONFIG.services.serverless.perRequestCost, 10);
    expect(STATE.finances.expenses.upkeep).toBeCloseTo(CONFIG.services.serverless.perRequestCost, 10);
    expect(STATE.finances.expenses.byService.serverless).toBeCloseTo(
      byServiceBefore + CONFIG.services.serverless.perRequestCost,
      10
    );
  });

  it("is a no-op for every other service type", () => {
    const compute = place("compute");
    const moneyBefore = STATE.money;
    chargeServerlessInvocation(compute);
    expect(STATE.money).toBe(moneyBefore);
  });

  it("a completed request through serverless nets reward minus the invocation charge", () => {
    const alb = place("alb");
    const fn = place("serverless");
    const db = place("db");
    connect("internet", alb);
    connect(alb, fn);
    connect(fn, db);

    const moneyBefore = STATE.money;
    const req = new Request("WRITE");
    STATE.requests.push(req);
    routeRequestToEntry(req, "WRITE");
    run(12); // serverless processingTime is 900ms

    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.money).toBeCloseTo(
      moneyBefore +
        CONFIG.trafficTypes.WRITE.reward -
        CONFIG.services.serverless.perRequestCost,
      5
    );
  });
});

describe("getUpkeepMultiplier", () => {
  it("is 1.0 outside survival mode", () => {
    STATE.gameMode = "sandbox";
    STATE.elapsedGameTime = 10000;
    expect(getUpkeepMultiplier()).toBe(1.0);
  });

  it("scales linearly from base to max over scaleTime in survival", () => {
    STATE.gameMode = "survival";
    STATE.intervention = null;
    const { baseMultiplier, maxMultiplier, scaleTime } = CONFIG.survival.upkeepScaling;

    STATE.elapsedGameTime = 0;
    expect(getUpkeepMultiplier()).toBeCloseTo(baseMultiplier, 10);

    STATE.elapsedGameTime = scaleTime / 2;
    expect(getUpkeepMultiplier()).toBeCloseTo((baseMultiplier + maxMultiplier) / 2, 10);

    STATE.elapsedGameTime = scaleTime * 3; // clamped at max
    expect(getUpkeepMultiplier()).toBeCloseTo(maxMultiplier, 10);
  });

  it("multiplies in an active intervention cost spike", () => {
    STATE.gameMode = "survival";
    STATE.elapsedGameTime = 0;
    STATE.intervention = { costMultiplier: 3.0 };
    expect(getUpkeepMultiplier()).toBeCloseTo(3.0, 10);
  });
});

describe("calculateFailChanceBasedOnLoad", () => {
  it("is 0 at or below 50% load", () => {
    expect(calculateFailChanceBasedOnLoad(0)).toBe(0);
    expect(calculateFailChanceBasedOnLoad(0.5)).toBe(0);
  });

  it("rises linearly above 50%: 2 * (load - 0.5)", () => {
    expect(calculateFailChanceBasedOnLoad(0.75)).toBeCloseTo(0.5, 10);
    expect(calculateFailChanceBasedOnLoad(1.0)).toBeCloseTo(1.0, 10);
  });
});

describe("per-frame upkeep drain (Service.update)", () => {
  it("deducts config.upkeep/60 per second when upkeep is enabled", () => {
    const db = place("db");
    STATE.upkeepEnabled = true;
    const moneyBefore = STATE.money;
    db.update(1); // one second
    expect(STATE.money).toBeCloseTo(moneyBefore - CONFIG.services.db.upkeep / 60, 5);
    expect(STATE.finances.expenses.upkeep).toBeCloseTo(CONFIG.services.db.upkeep / 60, 5);
  });

  it("charges nothing with upkeep disabled (sandbox toggle)", () => {
    const db = place("db");
    STATE.upkeepEnabled = false;
    const moneyBefore = STATE.money;
    db.update(1);
    expect(STATE.money).toBe(moneyBefore);
  });
});
