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

  it("busiestLoad is the max across every type, not one type", () => {
    const state = {
      services: [
        svc("compute", { totalLoad: 0.2 }),
        svc("db", { totalLoad: 0.9 }),
        svc("waf", { totalLoad: 0.1 }),
      ],
    };
    expect(O.busiestLoad(state)).toBeCloseTo(0.9);
  });

  it("busiestLoad is 0 (not -Infinity) on an empty board", () => {
    expect(O.busiestLoad({ services: [] })).toBe(0);
    expect(O.busiestLoad({})).toBe(0);
  });
});

describe("auto-scaling objectives", () => {
  it("fleetScaledOut is false for an ASG that is on but has never scaled", () => {
    const state = { services: [svc("compute", { asgEnabled: true, instances: 1, lastScaleAt: 0 })] };
    expect(O.fleetScaledOut(state, "compute")).toBe(false);
  });

  it("fleetScaledOut is true while the fleet is larger than one", () => {
    const state = { services: [svc("compute", { asgEnabled: true, instances: 3, lastScaleAt: 0 })] };
    expect(O.fleetScaledOut(state, "compute")).toBe(true);
  });

  it("stays true after the fleet scales back in (latched via lastScaleAt)", () => {
    const state = { services: [svc("compute", { asgEnabled: true, instances: 1, lastScaleAt: 12.5 })] };
    expect(O.fleetScaledOut(state, "compute")).toBe(true);
  });

  it("ignores a scaled node of a different type, and a node with ASG off", () => {
    const state = {
      services: [
        svc("container", { asgEnabled: true, instances: 4, lastScaleAt: 8 }),
        svc("compute", { asgEnabled: false, instances: 3, lastScaleAt: 9 }),
      ],
    };
    expect(O.fleetScaledOut(state, "compute")).toBe(false);
    expect(O.fleetScaledOut(state, "container")).toBe(true);
  });

  it("is false with no services at all", () => {
    expect(O.fleetScaledOut({ services: [] }, "compute")).toBe(false);
    expect(O.fleetScaledOut({}, "compute")).toBe(false);
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

describe("per-service completion counts", () => {
  it("completedByService reads the per-service counter", () => {
    const state = { campaign: { completedByService: { notify: 42, db: 7 } } };
    expect(O.completedByService(state, "notify")).toBe(42);
  });

  it("completedByService is 0 for a service that finished nothing", () => {
    expect(O.completedByService({ campaign: { completedByService: {} } }, "notify")).toBe(0);
    expect(O.completedByService({}, "notify")).toBe(0);
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
