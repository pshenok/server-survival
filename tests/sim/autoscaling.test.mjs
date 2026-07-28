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
  upstreamQueuePressure,
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

// Queue-depth scaling (#220): the second scale-out signal. An SQS-fed fleet
// PULLS, capping its own intake at capacity, so its utilization never crosses
// targetUtil however deep the backlog gets — the engine must scale on the
// upstream queue's fill ratio instead.
describe("queue-depth scaling (#220)", () => {
  const THRESHOLD = CONFIG.autoscaling.queuePressureThreshold;

  // A compute fed by an SQS. Depth is pinned by stuffing the REAL arrays the
  // signal reads (same trick as the totalLoad test above) — updateAutoscaling
  // alone never drains them, so the fill stays put.
  function sqsFed() {
    const sqs = place("sqs");
    const c = asg();
    connect(sqs, c);
    return { sqs, c };
  }

  function fillTo(sqs, fraction) {
    const max = sqs.config.maxQueueSize || 20;
    sqs.queue = new Array(Math.round(max * fraction)).fill(null);
    sqs.processing = [];
  }

  describe("discovery", () => {
    it("reads 0 for an ALB-push fleet (no upstream SQS)", () => {
      const alb = place("alb");
      const c = asg();
      connect(alb, c);
      expect(upstreamQueuePressure(c)).toBe(0);
    });

    it("is the fill ratio over queue + parked jobs", () => {
      const { sqs, c } = sqsFed();
      const max = sqs.config.maxQueueSize || 20;
      sqs.queue = new Array(30).fill(null);
      sqs.processing = new Array(50).fill(null); // "requeue-next" parked jobs
      expect(upstreamQueuePressure(c)).toBeCloseTo(80 / max, 10);
    });

    it("takes the MAX across several upstream queues", () => {
      const { sqs, c } = sqsFed();
      const sqs2 = place("sqs");
      connect(sqs2, c);
      fillTo(sqs, 0.1);
      fillTo(sqs2, 0.6);
      expect(upstreamQueuePressure(c)).toBeCloseTo(0.6, 10);
    });

    it("ignores an SQS that is not connected to this fleet", () => {
      const c = asg();
      const other = place("compute");
      const sqs = place("sqs");
      connect(sqs, other); // wired to a DIFFERENT compute
      fillTo(sqs, 1);
      expect(upstreamQueuePressure(c)).toBe(0);
    });

    it("ignores a disabled SQS — a frozen backlog no fleet can drain", () => {
      const { sqs, c } = sqsFed();
      fillTo(sqs, 1);
      sqs.isDisabled = true;
      expect(upstreamQueuePressure(c)).toBe(0);
    });

    it("still sees a queue whose breaker is open (the #220 repro state)", () => {
      // A saturated SQS trips its own breaker; the backlog is real anyway.
      const { sqs, c } = sqsFed();
      fillTo(sqs, 0.5);
      sqs.breakerState = "open";
      expect(upstreamQueuePressure(c)).toBeCloseTo(0.5, 10);
    });
  });

  describe("scale-out on pressure", () => {
    it("boots an instance while util reads 0", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD + 0.1);
      tick(c, ASG.sustainSec + 0.2);
      expect(warmingCount(c)).toBe(1);
    });

    it("does not fire at exactly the threshold (strict >)", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD);
      tick(c, 30);
      expect(instanceCount(c)).toBe(1);
    });

    it("respects the sustain window like the util signal", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD + 0.1);
      tick(c, ASG.sustainSec - 0.5);
      expect(instanceCount(c)).toBe(1);
      tick(c, 0.7);
      expect(instanceCount(c)).toBe(2);
    });

    it("feeds the SAME accumulator as utilization — the streaks add up", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, ASG.targetUtil + 0.2); // hot CPU for half the window...
      tick(c, ASG.sustainSec - 0.5);
      expect(instanceCount(c)).toBe(1);
      setUtil(c, 0); // ...then idle CPU but a deep queue for the rest
      fillTo(sqs, THRESHOLD + 0.1);
      tick(c, 0.7);
      expect(instanceCount(c)).toBe(2);
    });

    it("goes through the same cooldown gate", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD + 0.1);
      tick(c, ASG.sustainSec + 0.2);
      expect(instanceCount(c)).toBe(2);
      tick(c, ASG.sustainSec + 0.2); // inside the cooldown — no third box
      expect(instanceCount(c)).toBe(2);
      tick(c, ASG.cooldownSec);
      expect(instanceCount(c)).toBe(3);
    });

    it("freezes on pause exactly like the util signal", () => {
      const { sqs, c } = sqsFed();
      setUtil(c, 0);
      fillTo(sqs, 1);
      STATE.timeScale = 0;
      tick(c, 60);
      expect(instanceCount(c)).toBe(1);
      expect(c.asgAbove).toBe(0);
    });
  });

  describe("scale-in guard (no flapping)", () => {
    it("holds the fleet while pressure sits between half-threshold and threshold", () => {
      // The flap this prevents: scale out on pressure, drain a little, util
      // still reads 0 — without the guard the fleet would retire the very
      // instance it just booted.
      const { sqs, c } = sqsFed();
      c.instances = 3;
      setUtil(c, 0);
      fillTo(sqs, (THRESHOLD + THRESHOLD / 2) / 2);
      tick(c, 60);
      expect(c.instances).toBe(3);
    });

    it("does not scale in at exactly half the threshold (strict <)", () => {
      const { sqs, c } = sqsFed();
      c.instances = 3;
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD / 2);
      tick(c, 30);
      expect(c.instances).toBe(3);
    });

    it("scales in once the queue drains below half the threshold", () => {
      const { sqs, c } = sqsFed();
      c.instances = 3;
      setUtil(c, 0);
      fillTo(sqs, THRESHOLD / 2 - 0.02);
      tick(c, ASG.sustainSec + 0.2);
      expect(c.instances).toBe(2);
    });

    it("changes nothing for an ALB-push fleet: pressure 0 never blocks scale-in", () => {
      const alb = place("alb");
      const c = asg();
      connect(alb, c);
      c.instances = 3;
      setUtil(c, ASG.scaleInUtil - 0.1);
      tick(c, ASG.sustainSec + 0.2);
      expect(c.instances).toBe(2);
    });
  });

  describe("the #220 repro, end to end", () => {
    // waf -> sqs -> compute(AUTO) -> db, arrivals far past one instance's
    // throughput. Spawns requests at `rps` through the real entry router.
    function repro() {
      const waf = place("waf");
      const sqs = place("sqs");
      const c = asg();
      const db = place("db");
      connect("internet", waf);
      connect(waf, sqs);
      connect(sqs, c);
      connect(c, db);
      return { sqs, c };
    }

    function drive(seconds, rps, dt = 1 / 60) {
      let acc = 0;
      for (let t = 0; t < seconds; t += dt) {
        acc += rps * dt;
        while (acc >= 1) {
          acc -= 1;
          const req = new Request("READ");
          STATE.requests.push(req);
          routeRequestToEntry(req, "READ");
        }
        STATE.services.forEach((s) => s.update(dt));
        STATE.requests.slice().forEach((r) => r.update(dt));
      }
    }

    it("without the queue signal the fleet is stuck at 1 (the filed bug)", () => {
      const saved = CONFIG.autoscaling.queuePressureThreshold;
      CONFIG.autoscaling.queuePressureThreshold = 999; // signal off
      try {
        const { c } = repro();
        drive(30, 20);
        expect(instanceCount(c)).toBe(1);
      } finally {
        CONFIG.autoscaling.queuePressureThreshold = saved;
      }
    });

    it("scales out under queue pressure while util never sustains past target", () => {
      const { sqs, c } = repro();
      let sustainedHotUtil = 0;
      let hotStreak = 0;
      let peak = 1;
      const dt = 1 / 60;
      for (let t = 0; t < 30; t += 1) {
        drive(1, 20, dt);
        peak = Math.max(peak, instanceCount(c));
        // Track whether the OLD signal alone could ever have fired.
        hotStreak = c.totalLoad > ASG.targetUtil ? hotStreak + 1 : 0;
        sustainedHotUtil = Math.max(sustainedHotUtil, hotStreak);
      }
      expect(peak).toBeGreaterThan(1); // the fleet grew...
      expect(instanceCount(c)).toBeGreaterThan(1);
      expect(upstreamQueuePressure(c)).toBeGreaterThan(0); // ...on a real backlog
      expect(sqs.queue.length + sqs.processing.length).toBeGreaterThan(0);
    });

    it("drains the queue and returns to 1 instance after the traffic stops", () => {
      const { sqs, c } = repro();
      drive(30, 20);
      expect(instanceCount(c)).toBeGreaterThan(1);
      drive(60, 0); // silence: backlog drains, fleet retires
      expect(sqs.queue.length + sqs.processing.length).toBe(0);
      expect(instanceCount(c)).toBe(1);
    });
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
