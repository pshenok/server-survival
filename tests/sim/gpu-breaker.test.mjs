// A GPU's circuit breaker hears its successes, not only its overflows.
//
// Breaker successes used to be recorded in one place, Service.update()'s
// per-job dispatch loop. A GPU is a tick-node: processQueue returns early, its
// processing array stays empty, and it completes batches through finishRequest
// in tickGpu. So its breaker window only ever held the 1s from Request.update's
// QUEUE_FULL drop, and two things followed:
//   1. eight overflow drops tripped it, however many requests it had served;
//   2. after a trip, probe successes never reached it, so it sat half-open for
//      good and any single later overflow re-opened it.
// While open, every INFERENCE request failed at the Computes as "Circuit open".
// Measured before the fix with 2 Computes -> 1 GPU at 3.5 INFERENCE/s for 120s:
// 9 trips, never closed, 23 QUEUE_FULL drops turned into 162 CIRCUIT_OPEN.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { createConnection } from "../../src/sim/topology.js";
import { FAIL_REASONS } from "../../src/core/failure-reasons.js";
import { CONFIG, STATE, resetWorld } from "../helpers/sim-world.mjs";
import { REAL_RANDOM, frame, mulberry32, placeAt } from "../helpers/campaign-play.mjs";

beforeEach(() => {
    vi.useFakeTimers();
    resetWorld({ gameMode: "sandbox" });
    STATE.animationId = 1;
    Math.random = mulberry32(7);
});
afterEach(() => {
    Math.random = REAL_RANDOM;
    vi.useRealTimers();
    resetWorld();
});

function runFor(sec, dt = 0.1) {
    for (let t = 0; t < sec - 1e-9; t += dt) frame(dt);
}

function flyInference(gpu, n) {
    for (let i = 0; i < n; i++) {
        const req = new Request("INFERENCE");
        req.genLength = 1; // deterministic batch time
        STATE.requests.push(req);
        req.flyTo(gpu);
    }
}

// A warm tier-1 GPU placed through the real createService path.
function warmGpu() {
    const gpu = placeAt("gpu", 10, 0);
    runFor(CONFIG.services.gpu.loadTimeSec + 0.5);
    expect(gpu.modelLoading, "model load finished").toBe(false);
    return gpu;
}

describe("a GPU circuit breaker hears its successes", () => {
    it("does not trip on 8 overflows after serving 40 requests", () => {
        const gpu = warmGpu();

        // Five full batches, each arriving, filling, running, completing.
        const servedBefore = STATE.requestsProcessed;
        for (let b = 0; b < 5; b++) {
            flyInference(gpu, 8);
            runFor(3);
        }
        const served = STATE.requestsProcessed - servedBefore;
        expect(served, "GPU completed its five batches").toBe(40);
        expect(gpu.breakerState).toBe("closed");

        // One full batch to occupy the GPU, then 16 arrivals at once: 8 fit
        // the bounded intake, 8 overflow as QUEUE_FULL.
        flyInference(gpu, 8);
        runFor(0.6); // arrive + launch (batch full -> running)
        expect(gpu.batchState).toBe("running");
        const qfBefore = STATE.failuresByReason[FAIL_REASONS.QUEUE_FULL] || 0;
        flyInference(gpu, 16);
        runFor(0.6);
        const overflows = (STATE.failuresByReason[FAIL_REASONS.QUEUE_FULL] || 0) - qfBefore;
        expect(overflows, "exactly 8 overflow drops").toBe(8);

        expect(
            gpu.breakerState,
            `GPU served ${served} requests, then ${overflows} overflowed; ` +
                `breakerEvents=${JSON.stringify(gpu.breakerEvents)} ` +
                `(a 40-served / 8-dropped node is not failing >50% of its work)`
        ).toBe("closed");
    });

    it("closes again once half-open probes succeed", () => {
        const gpu = warmGpu();

        // Trip it through the real overflow path: occupy, then overflow 8.
        flyInference(gpu, 8);
        runFor(0.6);
        flyInference(gpu, 16);
        runFor(0.6);
        expect(gpu.breakerState, "8 overflows on a fresh GPU trip it").toBe("open");

        // openSec of game time -> half-open (queue drains meanwhile).
        runFor(CONFIG.resilience.openSec + 4);
        expect(gpu.breakerState).toBe("half-open");
        expect(gpu.queue.length + gpu.batch.length).toBe(0);

        // Three probes, served successfully.
        const servedBefore = STATE.requestsProcessed;
        flyInference(gpu, CONFIG.resilience.probeCount);
        runFor(5);
        const served = STATE.requestsProcessed - servedBefore;
        expect(served, "probes completed at the GPU").toBe(CONFIG.resilience.probeCount);

        expect(
            gpu.breakerState,
            `${served} probe(s) completed successfully but breakerProbes=${gpu.breakerProbes}`
        ).toBe("closed");
    });

    it("Compute -> GPU at 3.5 INFERENCE/s: trips are not driven by a lifetime overflow count", () => {
        const alb = placeAt("alb", -10, 0);
        const c1 = placeAt("compute", 0, 6);
        const c2 = placeAt("compute", 0, -6);
        const gpu = placeAt("gpu", 10, 0);
        createConnection("internet", alb.id);
        createConnection(alb.id, c1.id);
        createConnection(alb.id, c2.id);
        createConnection(c1.id, gpu.id);
        createConnection(c2.id, gpu.id);
        expect(c1.connections).toContain(gpu.id);

        STATE.trafficDistribution = {
            STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0, INFERENCE: 1,
        };
        STATE.currentRPS = 3.5;

        let trips = 0;
        let closedAfterTrip = false;
        let firstTripAt = null;
        let servedAtFirstTrip = null;
        let prev = gpu.breakerState;
        for (let t = 0; t < 120; t += 0.1) {
            frame(0.1);
            const s = gpu.breakerState;
            if (s === "open" && prev !== "open") {
                trips++;
                if (firstTripAt === null) {
                    firstTripAt = STATE.elapsedGameTime;
                    servedAtFirstTrip = STATE.requestsProcessed;
                }
            }
            if (trips > 0 && s === "closed") closedAfterTrip = true;
            prev = s;
        }
        const qf = STATE.failuresByReason[FAIL_REASONS.QUEUE_FULL] || 0;
        const co = STATE.failuresByReason[FAIL_REASONS.CIRCUIT_OPEN] || 0;
        const summary =
            `trips=${trips} firstTripAt=${firstTripAt?.toFixed(1)}s ` +
            `servedAtFirstTrip=${servedAtFirstTrip} totalServed=${STATE.requestsProcessed} ` +
            `QUEUE_FULL=${qf} CIRCUIT_OPEN=${co} closedAfterTrip=${closedAfterTrip} ` +
            `final=${gpu.breakerState} probes=${gpu.breakerProbes}`;

        // After any trip, a GPU serving traffic must be able to close again.
        expect(trips === 0 || closedAfterTrip, summary).toBe(true);
    });
});
