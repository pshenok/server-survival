// Observability layer (#194) over the REAL sim: ring-buffer sampling and
// freeze-on-pause, error/latency attribution through failRequest /
// finishRequest, the hasMonitoring() gate, threshold alerts with cooldown,
// lazy buffer pruning after deleteObject, and resetMetrics.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { failRequest, finishRequest, routeRequestToEntry } from "../../src/core/actions.js";
import {
  METRICS_BUFFER_SIZE,
  getSampleCount,
  getServiceMetrics,
  hasMonitoring,
  metricsTick,
  resetMetrics,
} from "../../src/core/metrics.js";
import { deleteObject, createConnection } from "../../src/sim/topology.js";
import { STATE, CONFIG, resetWorld, place, connect, run } from "../helpers/sim-world.mjs";

beforeEach(() => {
  resetWorld();
  resetMetrics();
  STATE.intervention.warnings = [];
});
afterEach(() => vi.restoreAllMocks());

// Advance the metrics clock by `seconds` without running the sim.
function tick(seconds, dt = 0.1) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) metricsTick(dt);
}

function warningsMatching(fragment) {
  return STATE.intervention.warnings.filter((w) => w.message.includes(fragment));
}

describe("ring buffer sampling", () => {
  it("samples every service at 2 Hz", () => {
    const db = place("db");
    tick(3); // 3 s → 6 samples
    const m = getServiceMetrics(db.id);
    expect(m.util.length).toBe(6);
    expect(m.queueDepth.length).toBe(6);
    expect(m.errorRate.length).toBe(6);
    expect(m.latency.length).toBe(6);
  });

  it("caps each buffer at the 60 s window (120 samples)", () => {
    const db = place("db");
    tick(90); // 180 samples worth
    expect(getServiceMetrics(db.id).util.length).toBe(METRICS_BUFFER_SIZE);
  });

  it("freezes while paused (timeScale 0) so the failure moment stays inspectable", () => {
    const db = place("db");
    tick(2);
    const before = getServiceMetrics(db.id).util.length;
    const countBefore = getSampleCount();
    STATE.timeScale = 0;
    tick(10);
    expect(getServiceMetrics(db.id).util.length).toBe(before);
    expect(getSampleCount()).toBe(countBefore);
  });

  it("util samples reflect the service's current totalLoad", () => {
    const db = place("db"); // capacity 8 → totalLoad = queue/(8*2)
    db.queue = new Array(8).fill({});
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.util[m.util.length - 1]).toBeCloseTo(0.5, 5);
  });

  it("queueDepth samples reflect the queue length", () => {
    const db = place("db");
    db.queue = new Array(5).fill({});
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.queueDepth[m.queueDepth.length - 1]).toBe(5);
  });
});

describe("error and latency attribution", () => {
  it("failRequest attributes the error to req.target's next errorRate sample", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.flyTo(db);
    failRequest(req);
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 1]).toBe(1);
  });

  it("failRequest with no target (entry routing dead-end) does not throw or attribute", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    expect(() => failRequest(req)).not.toThrow();
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 1]).toBe(0);
  });

  it("finishRequest attributes success (errorRate 0) and latency from spawnedAt", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.spawnedAt = performance.now() - 250;
    finishRequest(req, db.type, db);
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 1]).toBe(0);
    const lat = m.latency[m.latency.length - 1];
    expect(lat).toBeGreaterThanOrEqual(240);
    expect(lat).toBeLessThan(1000);
  });

  it("errorRate is windowed: mixed errors and successes within one sample", () => {
    const db = place("db");
    for (let i = 0; i < 3; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      req.flyTo(db);
      failRequest(req);
    }
    const ok = new Request("READ");
    STATE.requests.push(ok);
    finishRequest(ok, db.type, db);
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 1]).toBeCloseTo(0.75, 5);
  });

  it("counters reset per sample: a clean second sample drops errorRate back to 0", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.flyTo(db);
    failRequest(req);
    tick(0.5);
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 2]).toBe(1);
    expect(m.errorRate[m.errorRate.length - 1]).toBe(0);
  });

  it("quiet samples carry the last latency average forward (sparkline continuity)", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.spawnedAt = performance.now() - 300;
    finishRequest(req, db.type, db);
    tick(0.5);
    tick(0.5); // no traffic this window
    const m = getServiceMetrics(db.id);
    expect(m.latency[m.latency.length - 1]).toBe(m.latency[m.latency.length - 2]);
    expect(m.latency[m.latency.length - 1]).toBeGreaterThan(0);
  });

  it("e2e: a completed request through the real pipeline lands a success on the db", () => {
    place("monitor");
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);

    const req = new Request("WRITE");
    STATE.requests.push(req);
    routeRequestToEntry(req, "WRITE");
    run(10);
    tick(0.5);

    expect(STATE.requestsProcessed).toBe(1);
    const m = getServiceMetrics(db.id);
    expect(m.errorRate[m.errorRate.length - 1]).toBe(0);
    expect(m.latency[m.latency.length - 1]).toBeGreaterThan(0);
  });
});

describe("hasMonitoring gating", () => {
  it("false with no monitor placed", () => {
    place("db");
    expect(hasMonitoring()).toBe(false);
  });

  it("true with a live monitor, false again when it is disabled (outage)", () => {
    const monitor = place("monitor");
    expect(hasMonitoring()).toBe(true);
    monitor.isDisabled = true;
    expect(hasMonitoring()).toBe(false);
  });

  it("monitor accepts no connections in either direction (allowlist rejects unknown pairs)", () => {
    const monitor = place("monitor");
    const db = place("db");
    createConnection(monitor.id, db.id);
    createConnection(db.id, monitor.id);
    createConnection("internet", monitor.id);
    expect(STATE.connections.length).toBe(0);
    expect(monitor.connections).toEqual([]);
    expect(db.connections).toEqual([]);
  });
});

describe("threshold alerts", () => {
  function overload(service) {
    // totalLoad = (processing + queue) / (capacity * 2); push it past 0.85.
    const need = Math.ceil(service.config.capacity * 2 * 0.9);
    service.queue = new Array(need).fill({});
  }

  it("does NOT fire without a monitoring service", () => {
    const db = place("db");
    overload(db);
    tick(5);
    expect(warningsMatching("High load")).toHaveLength(0);
  });

  it("high-load fires only after 6 consecutive samples above 0.85", () => {
    place("monitor");
    const db = place("db");
    overload(db);
    tick(2.5); // 5 samples — not yet
    expect(warningsMatching("High load")).toHaveLength(0);
    tick(0.5); // 6th sample
    expect(warningsMatching("High load")).toHaveLength(1);
  });

  it("a dip below the threshold resets the sustained-load streak", () => {
    place("monitor");
    const db = place("db");
    overload(db);
    tick(2.5); // 5 samples over
    db.queue = []; // dip
    tick(0.5);
    overload(db);
    tick(2.5); // 5 more — streak restarted, still no alert
    expect(warningsMatching("High load")).toHaveLength(0);
  });

  it("respects the 15 s per-service cooldown, then fires again", () => {
    place("monitor");
    const db = place("db");
    overload(db);
    STATE.elapsedGameTime = 0;
    tick(10); // well past 6 samples, still inside cooldown
    expect(warningsMatching("High load")).toHaveLength(1);
    STATE.elapsedGameTime = 16; // cooldown elapsed in game time
    tick(0.5);
    expect(warningsMatching("High load")).toHaveLength(2);
  });

  it("queue alert fires at >= 90% of maxQueueSize", () => {
    place("monitor");
    const sqs = place("sqs"); // maxQueueSize 200
    sqs.queue = new Array(180).fill({});
    tick(0.5);
    expect(warningsMatching("Queue near capacity")).toHaveLength(1);
  });

  it("error-rate alert needs at least 5 events in the window", () => {
    place("monitor");
    const db = place("db");
    for (let i = 0; i < 4; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      req.flyTo(db);
      failRequest(req);
    }
    tick(0.5); // 4 events, 100% errors — below the event floor
    expect(warningsMatching("Error rate critical")).toHaveLength(0);

    for (let i = 0; i < 5; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      req.flyTo(db);
      failRequest(req);
    }
    tick(0.5);
    expect(warningsMatching("Error rate critical")).toHaveLength(1);
  });

  it("error-rate alert stays quiet at low rates even with many events", () => {
    place("monitor");
    const db = place("db");
    const bad = new Request("READ");
    STATE.requests.push(bad);
    bad.flyTo(db);
    failRequest(bad);
    for (let i = 0; i < 9; i++) {
      const req = new Request("READ");
      STATE.requests.push(req);
      finishRequest(req, db.type, db);
    }
    tick(0.5); // 10 events, 10% error rate
    expect(warningsMatching("Error rate critical")).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("prunes buffers for deleted services on the next sample", () => {
    const db = place("db");
    tick(1);
    expect(getServiceMetrics(db.id)).toBeDefined();
    deleteObject(db.id);
    tick(0.5);
    expect(getServiceMetrics(db.id)).toBeUndefined();
  });

  it("resetMetrics clears buffers, counters and the sample clock (resetGame path)", () => {
    const db = place("db");
    const req = new Request("READ");
    STATE.requests.push(req);
    req.flyTo(db);
    failRequest(req);
    tick(3);
    expect(getSampleCount()).toBeGreaterThan(0);

    resetMetrics();
    expect(getSampleCount()).toBe(0);
    expect(getServiceMetrics(db.id)).toBeUndefined();
    // Fresh sampling starts clean — no leftover error counters.
    tick(0.5);
    const m = getServiceMetrics(db.id);
    expect(m.util.length).toBe(1);
    expect(m.errorRate[0]).toBe(0);
  });

  it("monitor is placeable, charges $75 and shows up in STATE.services", () => {
    const moneyBefore = STATE.money;
    const monitor = place("monitor");
    expect(monitor.type).toBe("monitor");
    expect(STATE.money).toBe(moneyBefore - CONFIG.services.monitor.cost);
  });
});
