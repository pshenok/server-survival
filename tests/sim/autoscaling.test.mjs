// Auto-Scaling Group over the REAL modules (#195): capacity multiplication
// with cold start, the scale-out/scale-in rules (threshold, sustain,
// cooldown, hysteresis, bounds), fleet upkeep, the pause freeze, the
// satellite meshes, and the save/load round-trip.
//
// Utilization is driven by shadowing the totalLoad getter on the instance —
// the engine reads exactly that one number, so this pins the input without
// hand-building queues of half-valid requests. The traffic-driven case at the
// bottom exercises the real path end to end.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  canAutoscale,
  instanceCount,
  toggleAutoscaling,
  updateAutoscaling,
  upkeepInstanceFactor,
  warmingCount,
} from "../../src/sim/autoscaling.js";
import { deleteObject } from "../../src/sim/topology.js";
import { loadGameState, saveGameState } from "../../src/persistence/save-load.js";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import { STATE, CONFIG, resetWorld, place, connect, run } from "../helpers/sim-world.mjs";

const ASG = CONFIG.autoscaling;

beforeEach(() => {
  resetWorld();
  globalThis.localStorage.removeItem("serverSurvivalSave");
  globalThis.alertCalls.length = 0;
});

afterEach(() => {
  if (STATE.animationId) {
    globalThis.cancelAnimationFrame(STATE.animationId);
    STATE.animationId = null;
  }
});

// Pin utilization for the engine under test.
function setUtil(service, util) {
  Object.defineProperty(service, "totalLoad", {
    get: () => util,
    configurable: true,
  });
}

// Feed the engine `seconds` of game time at 100 ms steps.
function tick(service, seconds, dt = 0.1) {
  for (let i = 0; i < Math.round(seconds / dt); i++) updateAutoscaling(service, dt);
}

function asg() {
  const c = place("compute");
  toggleAutoscaling(c);
  return c;
}

describe("defaults and gating", () => {
  it("a fresh Compute has ASG off with a single instance", () => {
    const c = place("compute");
    expect(c.asgEnabled).toBe(false);
    expect(c.instances).toBe(1);
    expect(c.warming).toEqual([]);
    expect(instanceCount(c)).toBe(1);
  });

  it("only Compute can autoscale", () => {
    expect(canAutoscale(place("compute"))).toBe(true);
    expect(canAutoscale(place("db"))).toBe(false);
    expect(canAutoscale(place("serverless"))).toBe(false);
  });

  it("toggling a non-Compute service is refused", () => {
    const db = place("db");
    expect(toggleAutoscaling(db)).toBe(false);
    expect(db.asgEnabled).toBe(false);
  });

  it("a non-ASG Compute never scales, however hot it runs", () => {
    const c = place("compute");
    setUtil(c, 1.5);
    tick(c, 30);
    expect(instanceCount(c)).toBe(1);
  });

  it("toggling off collapses the fleet back to one instance", () => {
    const c = asg();
    setUtil(c, 0.95);
    tick(c, 30);
    expect(instanceCount(c)).toBeGreaterThan(1);

    toggleAutoscaling(c);
    expect(c.asgEnabled).toBe(false);
    expect(c.instances).toBe(1);
    expect(c.warming).toEqual([]);
    expect(c.satellites).toEqual([]);
  });
});

describe("capacity", () => {
  it("is untouched for a service with one instance", () => {
    const c = place("compute");
    expect(c.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity);
  });

  it("multiplies by the number of READY instances", () => {
    const c = asg();
    c.instances = 3;
    expect(c.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity * 3);
  });

  it("gives warming instances no capacity at all (cold start)", () => {
    const c = asg();
    c.warming.push({ remaining: ASG.warmupSec });
    expect(instanceCount(c)).toBe(2);
    expect(c.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity);
  });

  it("applies the fleet multiplier before the health reduction", () => {
    resetWorld({ gameMode: "survival" });
    const c = asg();
    c.instances = 2;
    const critical = CONFIG.survival.degradation.criticalHealth;
    c.health = critical / 2; // => factor 0.3 + 0.7 * 0.5
    const base = CONFIG.services.compute.capacity * 2;
    expect(c.getEffectiveCapacity()).toBe(Math.floor(base * 0.65));
    // ...and the same node with one instance gets exactly half of it.
    c.instances = 1;
    expect(c.getEffectiveCapacity()).toBe(Math.floor((base / 2) * 0.65));
  });

  it("still honours a temporary event capacity reduction", () => {
    const c = asg();
    c.instances = 4;
    c.tempCapacityReduction = 0.5;
    expect(c.getEffectiveCapacity()).toBe((CONFIG.services.compute.capacity * 4) / 2);
  });

  it("is zero for a disabled service no matter how wide the fleet", () => {
    const c = asg();
    c.instances = 5;
    c.isDisabled = true;
    expect(c.getEffectiveCapacity()).toBe(0);
  });

  it("totalLoad is utilization of the ready fleet, not of one box", () => {
    const c = place("compute");
    c.queue = new Array(CONFIG.services.compute.capacity * 2).fill(null); // full
    expect(c.totalLoad).toBe(1);
    c.instances = 2;
    expect(c.totalLoad).toBe(0.5);
  });
});

describe("scale-out", () => {
  it("boots an instance after util holds above target for sustainSec", () => {
    const c = asg();
    setUtil(c, ASG.targetUtil + 0.1);
    tick(c, ASG.sustainSec + 0.2);
    expect(warmingCount(c)).toBe(1);
    expect(c.instances).toBe(1); // still cold
  });

  it("does not scale out before the sustain window elapses", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec - 0.5);
    expect(instanceCount(c)).toBe(1);
  });

  it("does not scale out at or below the target utilization", () => {
    const c = asg();
    setUtil(c, ASG.targetUtil);
    tick(c, 30);
    expect(instanceCount(c)).toBe(1);
  });

  it("the new instance becomes ready only after warmupSec", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.instances).toBe(1);

    tick(c, ASG.warmupSec - 0.5);
    expect(c.instances).toBe(1); // still warming
    tick(c, 0.6);
    expect(c.instances).toBe(2);
    expect(warmingCount(c)).toBe(0);
  });

  it("capacity rises only once the instance is ready", () => {
    const c = asg();
    const base = CONFIG.services.compute.capacity;
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.getEffectiveCapacity()).toBe(base);
    tick(c, ASG.warmupSec + 0.2);
    expect(c.getEffectiveCapacity()).toBe(base * 2);
  });

  it("the cooldown gates the next scaling action", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + 0.2);
    expect(instanceCount(c)).toBe(2);
    // Sustain elapses again well inside the cooldown — still no third box.
    tick(c, ASG.sustainSec + 0.2);
    expect(instanceCount(c)).toBe(2);
    tick(c, ASG.cooldownSec);
    expect(instanceCount(c)).toBe(3);
  });

  it("never exceeds maxInstances", () => {
    const c = asg();
    setUtil(c, 2.0);
    tick(c, 300);
    expect(instanceCount(c)).toBe(ASG.maxInstances);
    expect(c.instances).toBe(ASG.maxInstances);
  });
});

describe("scale-in and hysteresis", () => {
  it("retires an instance after util holds below scaleInUtil", () => {
    const c = asg();
    c.instances = 3;
    setUtil(c, ASG.scaleInUtil - 0.1);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.instances).toBe(2);
  });

  it("scale-in is immediate — no warmup on the way down", () => {
    const c = asg();
    c.instances = 3;
    setUtil(c, 0);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity * 2);
  });

  it("does nothing inside the hysteresis band", () => {
    const c = asg();
    c.instances = 3;
    setUtil(c, (ASG.targetUtil + ASG.scaleInUtil) / 2);
    tick(c, 60);
    expect(instanceCount(c)).toBe(3);
  });

  it("a dip into the band resets the scale-out streak (no flapping)", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec - 0.4);
    setUtil(c, 0.5); // inside the band
    tick(c, 1);
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec - 0.4);
    expect(instanceCount(c)).toBe(1); // neither streak ever completed
  });

  it("cancels a warming boot before retiring a ready instance", () => {
    const c = asg();
    c.instances = 2;
    c.warming.push({ remaining: ASG.warmupSec });
    c.asgCooldown = 0;
    setUtil(c, 0);
    tick(c, ASG.sustainSec + 0.2);
    expect(warmingCount(c)).toBe(0);
    expect(c.instances).toBe(2);
  });

  it("never drops below minInstances", () => {
    const c = asg();
    c.instances = 3;
    setUtil(c, 0);
    tick(c, 300);
    expect(c.instances).toBe(ASG.minInstances);
  });
});

describe("pause", () => {
  it("freezes warming and scaling while timeScale is 0", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + 0.2);
    expect(warmingCount(c)).toBe(1);
    const remaining = c.warming[0].remaining;

    STATE.timeScale = 0;
    tick(c, 60);
    expect(c.warming[0].remaining).toBe(remaining);
    expect(instanceCount(c)).toBe(2);

    STATE.timeScale = 1;
    tick(c, ASG.warmupSec + 0.2);
    expect(c.instances).toBe(2);
  });
});

describe("upkeep", () => {
  it("is unchanged for a single-instance service", () => {
    expect(upkeepInstanceFactor(place("compute"))).toBe(1);
    expect(upkeepInstanceFactor(place("db"))).toBe(1);
  });

  it("bills every extra instance at instanceUpkeepFactor", () => {
    const c = asg();
    c.instances = 3;
    expect(upkeepInstanceFactor(c)).toBeCloseTo(1 + 2 * ASG.instanceUpkeepFactor, 10);
  });

  it("bills warming instances too (clouds charge from boot)", () => {
    const c = asg();
    c.warming.push({ remaining: ASG.warmupSec });
    expect(upkeepInstanceFactor(c)).toBeCloseTo(1 + ASG.instanceUpkeepFactor, 10);
  });

  it("Service.update charges the fleet through the byService bucket", () => {
    const c = asg();
    c.instances = 3;
    setUtil(c, 0.5); // inside the band: no scaling noise during the charge
    STATE.upkeepEnabled = true;
    const before = STATE.money;
    const bucketBefore = STATE.finances.expenses.byService.compute; // holds the build cost
    const upkeepBefore = STATE.finances.expenses.upkeep;

    c.update(1);

    const expected = (CONFIG.services.compute.upkeep / 60) * upkeepInstanceFactor(c);
    expect(before - STATE.money).toBeCloseTo(expected, 6);
    expect(STATE.finances.expenses.byService.compute - bucketBefore).toBeCloseTo(expected, 6);
    expect(STATE.finances.expenses.upkeep - upkeepBefore).toBeCloseTo(expected, 6);
  });
});

describe("satellite meshes", () => {
  it("shows one satellite per extra instance", () => {
    const c = asg();
    expect(c.satellites).toHaveLength(0);
    c.instances = 3;
    setUtil(c, 0.5);
    updateAutoscaling(c, 0.1); // no scaling, but no refresh either
    c.instances = 3;
    toggleAutoscaling(c); // off -> collapses
    toggleAutoscaling(c); // on again
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + ASG.warmupSec + 0.4);
    expect(c.instances).toBe(2);
    expect(c.satellites).toHaveLength(1);
  });

  it("renders a warming instance semi-transparent, then solid", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.satellites).toHaveLength(1);
    expect(c.satellites[0].material.opacity).toBeCloseTo(0.35, 5);

    tick(c, ASG.warmupSec + 0.2);
    expect(c.satellites[0].material.opacity).toBe(1);
  });

  it("removes satellites from the parent mesh on scale-in", () => {
    const c = asg();
    c.instances = 3;
    toggleAutoscaling(c);
    toggleAutoscaling(c);
    c.instances = 3;
    setUtil(c, 0);
    tick(c, ASG.sustainSec + 0.2);
    expect(c.instances).toBe(2);
    expect(c.satellites).toHaveLength(1);
    expect(c.mesh.children).toContain(c.satellites[0]);
  });

  it("disposes satellites when the node is deleted", () => {
    const c = asg();
    setUtil(c, 0.99);
    tick(c, ASG.sustainSec + ASG.warmupSec + 0.4);
    const sat = c.satellites[0];
    expect(sat).toBeDefined();

    deleteObject(c.id);
    expect(c.satellites).toHaveLength(0);
    expect(c.mesh.children).not.toContain(sat);
  });
});

describe("persistence", () => {
  it("round-trips asgEnabled and the ready instance count", () => {
    const alb = place("alb");
    const c = asg();
    c.instances = 4;
    connect(alb, c);
    saveGameState("browser");

    resetWorld();
    loadGameState();

    const restored = STATE.services.find((s) => s.type === "compute");
    expect(restored.asgEnabled).toBe(true);
    expect(restored.instances).toBe(4);
    expect(restored.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity * 4);
    expect(restored.satellites).toHaveLength(3);
  });

  it("drops warming instances — a load is a cold boot", () => {
    const c = asg();
    c.warming.push({ remaining: ASG.warmupSec });
    saveGameState("browser");

    resetWorld();
    loadGameState();

    const restored = STATE.services.find((s) => s.type === "compute");
    expect(warmingCount(restored)).toBe(0);
    expect(restored.instances).toBe(1);
  });

  it("loads a pre-ASG save with the defaults", () => {
    loadGameState({
      version: "2.0",
      money: 500,
      services: [
        { id: "svc_old", type: "compute", position: [0, 0, 0], connections: [], tier: 1 },
      ],
      connections: [],
      internetConnections: [],
    });

    const restored = STATE.services[0];
    expect(restored.asgEnabled).toBe(false);
    expect(restored.instances).toBe(1);
    expect(restored.getEffectiveCapacity()).toBe(CONFIG.services.compute.capacity);
  });

  it("clamps a tampered instance count to maxInstances", () => {
    loadGameState({
      version: "2.0",
      money: 500,
      services: [
        {
          id: "svc_x", type: "compute", position: [0, 0, 0], connections: [],
          tier: 1, asgEnabled: true, instances: 99,
        },
      ],
      connections: [],
      internetConnections: [],
    });

    expect(STATE.services[0].instances).toBe(ASG.maxInstances);
  });
});

describe("under real traffic", () => {
  it("grows the fleet when requests pile up and capacity follows", () => {
    const alb = place("alb");
    const compute = asg();
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);

    for (let i = 0; i < 40; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      routeRequestToEntry(req, "READ");
    }

    // Watch the whole burst: the fleet grows while the backlog drains and
    // shrinks again once the queue empties.
    let peak = 1;
    let peakCapacity = compute.getEffectiveCapacity();
    for (let s = 0; s < 20; s++) {
      run(1);
      peak = Math.max(peak, instanceCount(compute));
      peakCapacity = Math.max(peakCapacity, compute.getEffectiveCapacity());
    }

    expect(peak).toBeGreaterThan(1);
    expect(peakCapacity).toBeGreaterThan(CONFIG.services.compute.capacity);
    expect(instanceCount(compute)).toBe(1); // scaled back in after the burst
  });
});
