// Campaign objective helpers (#155 PR 10). Pure functions over a plain STATE
// shape — no DOM, no THREE, imported directly (tier 1).
import { describe, it, expect } from "vitest";
import { CampaignObjectives as O } from "../src/campaign/objectives.js";

const svc = (type, extra = {}) => ({ type, config: { upkeep: 0 }, ...extra });

describe("counters (completedByType / failures)", () => {
  it("completedOfType reads the per-type counter", () => {
    const state = { campaign: { completedByType: { READ: 7, WRITE: 2 } } };
    expect(O.completedOfType(state, "READ")).toBe(7);
  });

  it("completedOfType is 0 for a type never completed", () => {
    const state = { campaign: { completedByType: { READ: 7 } } };
    expect(O.completedOfType(state, "SEARCH")).toBe(0);
  });

  it("completedOfType tolerates missing campaign state entirely", () => {
    expect(O.completedOfType({}, "READ")).toBe(0);
  });

  it("totalCompleted sums across all types", () => {
    const state = { campaign: { completedByType: { STATIC: 1, READ: 2, WRITE: 3 } } };
    expect(O.totalCompleted(state)).toBe(6);
  });

  it("totalCompleted is 0 with no campaign counters", () => {
    expect(O.totalCompleted({})).toBe(0);
  });

  it("totalFailures sums the STATE.failures table", () => {
    const state = { failures: { STATIC: 1, READ: 0, MALICIOUS: 4 } };
    expect(O.totalFailures(state)).toBe(5);
  });

  it("totalFailures is 0 when failures is missing", () => {
    expect(O.totalFailures({})).toBe(0);
  });
});

describe("failureRate", () => {
  it("is failed / (completed + failed)", () => {
    const state = {
      campaign: { completedByType: { READ: 9 } },
      failures: { READ: 1 },
    };
    expect(O.failureRate(state)).toBeCloseTo(0.1);
  });

  it("is 0 (not NaN) when nothing completed or failed", () => {
    expect(O.failureRate({ campaign: { completedByType: {} }, failures: {} })).toBe(0);
  });
});

describe("service introspection", () => {
  const state = { services: [svc("waf"), svc("compute"), svc("compute"), svc("db")] };

  it("hasService finds an existing type", () => {
    expect(O.hasService(state, "waf")).toBe(true);
  });

  it("hasService is false for an absent type", () => {
    expect(O.hasService(state, "cache")).toBe(false);
  });

  it("countServices counts duplicates", () => {
    expect(O.countServices(state, "compute")).toBe(2);
  });

  it("usesOnly requires the required type", () => {
    expect(O.usesOnly({ services: [svc("db")] }, "nosql", [])).toBe(false);
  });

  it("usesOnly rejects when a forbidden type is present", () => {
    expect(O.usesOnly(state, "compute", ["db"])).toBe(false);
  });

  it("usesOnly passes with required present and forbidden absent", () => {
    expect(O.usesOnly(state, "compute", ["cache", "sqs"])).toBe(true);
  });
});

describe("load checks", () => {
  it("maxLoadOfType returns the max totalLoad among services of the type", () => {
    const state = {
      services: [
        svc("compute", { totalLoad: 0.2 }),
        svc("compute", { totalLoad: 0.7 }),
        svc("db", { totalLoad: 0.9 }),
      ],
    };
    expect(O.maxLoadOfType(state, "compute")).toBeCloseTo(0.7);
  });

  it("maxLoadOfType is 0 (not -Infinity) when no service of the type exists", () => {
    expect(O.maxLoadOfType({ services: [] }, "compute")).toBe(0);
  });
});

describe("finance", () => {
  it("netProfit = income.total minus every expense bucket", () => {
    const state = {
      finances: {
        income: { total: 100 },
        expenses: { services: 10, upkeep: 20, repairs: 5, autoRepair: 5, mitigation: 3, breach: 7 },
      },
    };
    expect(O.netProfit(state)).toBe(50);
  });

  it("netProfit treats missing buckets as 0", () => {
    expect(O.netProfit({ finances: { income: { total: 10 }, expenses: {} } })).toBe(10);
    expect(O.netProfit({})).toBe(0);
  });

  it("totalUpkeepPerSec is the per-minute upkeep sum divided by 60", () => {
    const state = {
      services: [
        { config: { upkeep: 12 } },
        { config: { upkeep: 24 } },
        { config: {} }, // no upkeep field
      ],
    };
    expect(O.totalUpkeepPerSec(state)).toBeCloseTo(36 / 60);
  });
});

describe("routing-share objectives", () => {
  it("replicaShareOfReads = completedByService.replica / completedByType.READ", () => {
    const state = {
      campaign: { completedByType: { READ: 10 }, completedByService: { replica: 4 } },
    };
    expect(O.replicaShareOfReads(state)).toBeCloseTo(0.4);
  });

  it("replicaShareOfReads is 0 (not NaN) with zero reads", () => {
    expect(O.replicaShareOfReads({ campaign: { completedByType: {}, completedByService: {} } })).toBe(0);
  });

  it("nosqlShareOfWrites = completedByService.nosql / completedByType.WRITE", () => {
    const state = {
      campaign: { completedByType: { WRITE: 8 }, completedByService: { nosql: 6 } },
    };
    expect(O.nosqlShareOfWrites(state)).toBeCloseTo(0.75);
  });

  it("nosqlShareOfWrites is 0 (not NaN) with zero writes", () => {
    expect(O.nosqlShareOfWrites({ campaign: { completedByType: {}, completedByService: {} } })).toBe(0);
  });
});
