// Config sanity (#155 PR 1): the invariants that past bugs violated.
import { describe, expect, it } from "vitest";
import { CONFIG, TRAFFIC_TYPES } from "../src/config.js";

describe("traffic types", () => {
  it("every traffic type has a destination and a reward", () => {
    for (const name of Object.keys(TRAFFIC_TYPES)) {
      const t = CONFIG.trafficTypes[name];
      expect(t, `trafficTypes.${name}`).toBeDefined();
      expect(typeof t.destination, `${name}.destination`).toBe("string");
      expect(typeof t.reward, `${name}.reward`).toBe("number");
    }
  });
});

describe("services", () => {
  const services = Object.entries(CONFIG.services);

  it("every service has a positive cost and capacity", () => {
    for (const [name, s] of services) {
      expect(s.cost, `${name}.cost`).toBeGreaterThan(0);
      const capacity = s.capacity ?? s.tiers?.[0]?.capacity;
      expect(capacity, `${name} capacity`).toBeGreaterThan(0);
    }
  });

  it("tiered services have strictly increasing capacity and level 1 free", () => {
    for (const [name, s] of services) {
      if (!s.tiers) continue;
      expect(s.tiers[0].cost, `${name} tier1 cost`).toBe(0);
      for (let i = 1; i < s.tiers.length; i++) {
        expect(
          s.tiers[i].capacity,
          `${name} tier${i + 1} capacity`
        ).toBeGreaterThan(s.tiers[i - 1].capacity);
      }
    }
  });

  it("survival traffic distribution sums to 1", () => {
    const sum = Object.values(CONFIG.survival.trafficDistribution).reduce(
      (a, b) => a + b,
      0
    );
    expect(sum).toBeCloseTo(1, 5);
  });
});
