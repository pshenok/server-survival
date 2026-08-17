// The post-run report (#252).
//
// The campaign debrief printed the SAME static paragraph whether the player
// won by understanding or lost by flailing — src/ui/campaign-ui.js had the
// identical `tipEl.textContent = levelText(level.id, "debrief")` line in both
// branches. The one moment a learner is guaranteed to be reading carried zero
// information about their own board, while metrics.js was already collecting
// utilization, queue depth, error rate and latency and throwing all of it away
// at the level boundary.
//
// This is a SURFACE, not a mechanic, so its proof obligation is FIDELITY, not
// losability: the numbers it reports must equal the run the simulation
// actually produced. There is no "lesson test" here on purpose — inventing one
// would be dressing a readout up as a mechanic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { STATE, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { getRunReport, metricsTick, resetMetrics } from "../../src/core/metrics.js";
import { failRequest } from "../../src/core/actions.js";
import { FAIL_REASONS } from "../../src/core/failure-reasons.js";
import { Request } from "../../src/entities/Request.js";
import { frame } from "../helpers/reference-board.mjs";

beforeEach(() => {
  resetWorld({ gameMode: "survival" });
  resetMetrics();
});
afterEach(() => vi.restoreAllMocks());

describe("peak load is a running watermark, not a buffer scan (#252)", () => {
  it("remembers a spike that happened BEFORE the metrics window", () => {
    // The load-bearing property. The ring buffers hold 120 samples x 0.5s =
    // 60 seconds, and levels 21-25 run 90-300s. A scan of the buffers would
    // silently forget an early spike and report a confident wrong answer.
    const compute = place("compute");
    let load = 0;
    Object.defineProperty(compute, "smoothedLoad", {
      get: () => load,
      configurable: true,
    });

    STATE.elapsedGameTime = 20;
    load = 0.9; // the spike, at t=20 of a long level
    metricsTick(0.5);

    load = 0.05; // quiet for the rest of the run
    for (let t = 21; t <= 140; t += 1) {
      STATE.elapsedGameTime = t;
      metricsTick(0.5);
      metricsTick(0.5);
    }

    const r = getRunReport();
    const peak = r.peaks.find((p) => p.type === "compute");
    expect(peak).toBeDefined();
    expect(peak.util).toBeCloseTo(0.9, 6);
    expect(peak.atSec).toBeCloseTo(20, 1);
  });

  it("keeps the peak of a node that was deleted mid-run", () => {
    // The report is a post-mortem of the RUN, not a snapshot of the surviving
    // board: a node the player demolished after melting it is exactly the one
    // they need told about.
    const compute = place("compute");
    Object.defineProperty(compute, "smoothedLoad", { get: () => 0.8, configurable: true });
    STATE.elapsedGameTime = 10;
    metricsTick(0.5);

    compute.destroy();
    STATE.services = STATE.services.filter((s) => s.id !== compute.id);
    STATE.elapsedGameTime = 30;
    metricsTick(0.5);

    const r = getRunReport();
    expect(r.peaks.some((p) => p.util >= 0.79)).toBe(true);
  });

  it("resets between runs — a new level starts with no history", () => {
    const compute = place("compute");
    Object.defineProperty(compute, "smoothedLoad", { get: () => 0.7, configurable: true });
    metricsTick(0.5);
    expect(getRunReport().peaks.length).toBeGreaterThan(0);

    resetMetrics();
    expect(getRunReport().peaks).toEqual([]);
  });
});

describe("failure causes are tallied by REASON (#252)", () => {
  it("counts each cause separately and ranks them", () => {
    // STATE.failures answers "what died" (by traffic type); this answers
    // "why", which is the half a learner needs to fix anything.
    const mk = (type) => {
      const req = new Request(type);
      STATE.requests.push(req);
      return req;
    };
    for (let i = 0; i < 5; i++) failRequest(mk("READ"), FAIL_REASONS.QUEUE_FULL);
    for (let i = 0; i < 2; i++) failRequest(mk("WRITE"), FAIL_REASONS.NO_ROUTE);
    failRequest(mk("SEARCH"), FAIL_REASONS.OVERLOADED);

    const r = getRunReport();
    expect(r.topReasons[0]).toEqual({ key: FAIL_REASONS.QUEUE_FULL, count: 5 });
    expect(r.topReasons[1]).toEqual({ key: FAIL_REASONS.NO_ROUTE, count: 2 });
    expect(r.topReasons.length).toBe(3);
  });

  it("tallying a reason changes nothing about which requests fail (#156)", () => {
    // The badge-inertness contract: a reason is attribution, never a verdict.
    // Same board, same seeded traffic, reasons passed vs suppressed.
    const runWith = (passReasons) => {
      resetWorld({ gameMode: "survival" });
      const req = new Request("READ");
      STATE.requests.push(req);
      failRequest(req, passReasons ? FAIL_REASONS.QUEUE_FULL : null);
      return {
        failures: { ...STATE.failures },
        processed: STATE.requestsProcessed,
      };
    };
    expect(runWith(true)).toEqual(runWith(false));
  });
});

describe("the report matches the run it describes", () => {
  it("on-time and late completions add up to what was processed", () => {
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);
    STATE.currentRPS = 6;
    STATE.trafficDistribution = { STATIC: 0, READ: 1, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0, INFERENCE: 0 };
    for (let i = 0; i < 60 * 30; i++) frame(1 / 60);

    const r = getRunReport();
    expect(r.processed).toBe(STATE.requestsProcessed);
    expect(r.onTime + r.late).toBe(r.processed);
    expect(r.late).toBe(STATE.lateCompletions || 0);
  });
});

describe("the report stays a POST-MORTEM (#252)", () => {
  it("the live metrics panel does not import it", () => {
    // Structural, not conventional. A mid-run caller would silently refund the
    // $75 Monitoring purchase — level 15's whole lesson is that you cannot see
    // the board until you buy the eyes. Enforced here rather than in review.
    const panel = readFileSync("src/ui/metrics-panel.js", "utf8");
    expect(panel).not.toContain("getRunReport");
  });

  it("only the campaign debrief renders it", () => {
    const ui = readFileSync("src/ui/campaign-ui.js", "utf8");
    const callSites = [...ui.matchAll(/getRunReport\(/g)].length;
    expect(callSites).toBe(1);
    // And that one call site lives inside the debrief render path.
    expect(ui).toContain("function renderRunReport");
  });
});
