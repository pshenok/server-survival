// The AI Wave (#87): INFERENCE traffic, the GPU Cluster batch engine, the
// Inference Gateway's sweep-then-dispatch deadline queue, and the power grid.
// Spec: docs/superpowers/specs/2026-07-30-ai-wave-design.md.
//
// Coverage map (spec §1–§4 + the §6 leak battery):
//   - INFERENCE class: config economics, per-request genLength variance;
//   - batching: fill / window / genLength scaling / bounded intake / pause;
//   - model cold start: fresh placement, tier-reload with HELD arrivals,
//     mid-run stall;
//   - quality: per-tier risk, badAnswers, the −0.5 constant, the amber
//     success-side badge (never through the fail path — #156 intact);
//   - gateway: sweep BEFORE dispatch, expiry exactly-once vs the 500ms
//     fail-fade, least-loaded dispatch, warming holds, the 20-cap, pause;
//   - routing: forwardCandidates preference/exclusion, the compute INFERENCE
//     branch, MALICIOUS breach relabel at gpu/infgw, isValidEdge rows;
//   - power: recompute derivation, placement gate BOTH directions (boundary
//     inclusive), the substation deletion gate (anti buy-place-refund);
//   - share: power-first sort with c/i index remap, full round-trip;
//   - survival staging: 0 → 3% → 10% + hype-shift gating at SELECTION time;
//   - the §6 leak battery: mid-batch demolish, region outage over a busy GPU,
//     expiry storm, all-GPU-warming, share-rebuild of a power+gpu build.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { Service } from "../../src/entities/Service.js";
import { CampaignObjectives } from "../../src/campaign/objectives.js";
import { updateFinancesDisplay } from "../../src/core/economy.js";
import { updateInferenceStaging, updateMaliciousSpike, updateTrafficShift, triggerRegionOutage } from "../../src/core/events.js";
import { i18n } from "../../src/i18n.js";
import { SOFT_BADGES, SOFT_REASONS } from "../../src/core/failure-reasons.js";
import { forwardCandidates } from "../../src/sim/handlers/index.js";
import { hasPowerHeadroom, recomputePower } from "../../src/sim/power.js";
import { isRoutable } from "../../src/sim/circuit-breaker.js";
import { clearFailureBadges, getFailureBadges } from "../../src/ui/failure-badges.js";
import { buildShareUrl, decodeArchParam, encodeArch, rebuildSharedArch } from "../../src/ui/share.js";
import { createConnection, createService, deleteObject, isValidEdge } from "../../src/sim/topology.js";
import { STATE, CONFIG, resetWorld, place, connect, step } from "../helpers/sim-world.mjs";

// failRequest defers removeRequest by 500ms (the fail-fade); fake timers
// flush it deterministically. finishRequest removes synchronously.
beforeEach(() => {
    vi.useFakeTimers();
    resetWorld();
    clearFailureBadges(); // badge map is module state; nothing ages it headless
    // The staging / shift tests drive the survival intervention machinery —
    // start every test from a quiet baseline so none of it leaks.
    STATE.maliciousSpikeActive = false;
    STATE.normalTrafficDist = null;
    STATE.intervention.trafficShiftActive = false;
    STATE.intervention.currentShift = null;
    STATE.intervention.originalTrafficDist = null;
    STATE.intervention.trafficShiftTimer = 0;
    STATE.campaign.regionOutage = null;
    STATE.campaign.regionOutageFired = false;
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function flushRemovals() {
    vi.advanceTimersByTime(1000);
}

// One frame that ALSO advances the game clock — the Inference Gateway's
// deadline sweep reads STATE.elapsedGameTime, which game.js advances before
// updating services; sim-world's bare step() does not.
function stepGame(dt = 0.1) {
    STATE.elapsedGameTime += dt;
    step(dt);
}

function runGame(seconds, dt = 0.1) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) stepGame(dt);
}

// Inject a request straight at a specific node (bypasses entry routing).
function flyInto(type, node, genLength = 1) {
    const req = new Request(type);
    if (type === "INFERENCE") req.genLength = genLength;
    STATE.requests.push(req);
    req.flyTo(node);
    return req;
}

// Push INFERENCE requests straight into a node's arrival queue (no flight),
// with a pinned genLength so batch timing is deterministic.
function pushInference(node, n, genLength = 1) {
    const reqs = [];
    for (let i = 0; i < n; i++) {
        const req = new Request("INFERENCE");
        req.genLength = genLength;
        STATE.requests.push(req);
        node.queue.push(req);
        reqs.push(req);
    }
    return reqs;
}

// Seed gateway deadline entries directly, `age` seconds old.
function seedPending(infgw, n, age = 0) {
    if (!infgw.pending) infgw.pending = [];
    const reqs = [];
    for (let i = 0; i < n; i++) {
        const req = new Request("INFERENCE");
        req.genLength = 1;
        STATE.requests.push(req);
        infgw.pending.push({ req, enqueuedAt: STATE.elapsedGameTime - age });
        reqs.push(req);
    }
    return reqs;
}

// A freshly placed GPU cold-starts; most tests want one that is already warm.
function warm(gpu) {
    gpu.modelLoading = false;
    gpu.modelLoadTimer = 0;
    return gpu;
}

function totalFailures() {
    return Object.values(STATE.failures).reduce((a, b) => a + b, 0);
}

// ============================ INFERENCE TRAFFIC ============================
describe("INFERENCE traffic class (#87 §1)", () => {
    it("carries the spec economics: reward $0.50, score 15, not cacheable, destination gpu", () => {
        const t = CONFIG.trafficTypes.INFERENCE;
        expect(t.reward).toBe(0.5);
        expect(t.score).toBe(15);
        expect(t.cacheable).toBe(false);
        expect(t.destination).toBe("gpu");
        expect(t.color).toBe(0xd946ef);
        expect(STATE.failures.INFERENCE).toBe(0); // the counter exists
    });

    it("rolls per-request genLength at spawn: 70% short 0.6–1.0, 30% long 1.8–3.0, mean ≈1.28", () => {
        const lengths = [];
        for (let i = 0; i < 400; i++) {
            const req = new Request("INFERENCE");
            lengths.push(req.genLength);
            req.destroy();
        }
        for (const g of lengths) {
            const short = g >= 0.6 && g <= 1.0;
            const long = g >= 1.8 && g <= 3.0;
            expect(short || long, `genLength ${g} outside both bands`).toBe(true);
        }
        const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        expect(mean).toBeGreaterThan(1.15); // 1.28 ± well over 3σ at n=400
        expect(mean).toBeLessThan(1.42);
        // No other traffic has duration variance.
        const read = new Request("READ");
        expect(read.genLength).toBeUndefined();
        read.destroy();
    });
});

// ============================== GPU BATCHING ==============================
describe("GPU batching (#87 §2a)", () => {
    it("a FULL batch launches immediately and runs as one job of (900+150·n)×meanGenLength ms", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99); // no quality hits
        pushInference(gpu, 8, 1); // == batchSize at tier 1

        stepGame(0.1); // drain → full → launch on the same tick
        expect(gpu.batchState).toBe("running");
        expect(gpu.batch.length).toBe(8);
        expect(gpu.batchRunTimeMs).toBe((900 + 150 * 8) * 1); // 2100ms

        runGame(1.9); // t=2.0 — 2000ms of run < 2100ms
        expect(STATE.requestsProcessed).toBe(0);
        runGame(0.2); // past 2100ms
        expect(STATE.requestsProcessed).toBe(8);
        expect(STATE.requests.length).toBe(0); // TERMINATION
    });

    it("a lonely request waits out the 1.5s window and still pays nearly full price", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(gpu, 1, 1);

        runGame(1.4); // window not yet elapsed
        expect(gpu.batchState).toBe("filling");
        expect(gpu.batch.length).toBe(1);
        stepGame(0.1); // window fires at 1.5s
        expect(gpu.batchState).toBe("running");
        expect(gpu.batchRunTimeMs).toBe((900 + 150) * 1); // 1050ms — 50% of a full batch's for 12.5% of its revenue

        runGame(1.1);
        expect(STATE.requestsProcessed).toBe(1);
    });

    it("a partial batch (window-fired) runs all its members together", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(gpu, 3, 1);

        runGame(1.4);
        expect(STATE.requestsProcessed).toBe(0);
        runGame(0.2); // window fires
        expect(gpu.batchState).toBe("running");
        runGame(1.5); // (900+450)×1 = 1350ms
        expect(STATE.requestsProcessed).toBe(3);
    });

    it("genLength scales the WHOLE batch: long generations slow everyone in it", () => {
        const gpu = warm(place("gpu"));
        pushInference(gpu, 2, 2.0);
        runGame(1.6); // window fires the pair
        expect(gpu.batchState).toBe("running");
        expect(gpu.batchRunTimeMs).toBe((900 + 300) * 2.0); // 2400ms — double the genLength-1 batch
    });

    it("BOUNDED intake: the queue caps at batchSize while a batch runs — overflow takes the QUEUE_FULL path", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(gpu, 8, 1);
        stepGame(0.1); // batch of 8 running for 2100ms

        for (let i = 0; i < 9; i++) flyInto("INFERENCE", gpu); // 9 arrivals vs cap 8
        runGame(1.0); // flights land while the batch still runs

        expect(gpu.queue.length).toBe(8); // the bounded intake, exactly
        expect(STATE.failures.INFERENCE).toBe(1); // the 9th dropped QUEUE_FULL
    });

    it("pause (dt=0) freezes the window and the run — nothing fires, nothing completes", () => {
        const gpu = warm(place("gpu"));
        pushInference(gpu, 2, 1);
        runGame(1.0); // window at 1.0 of 1.5
        const windowBefore = gpu.batchWindowTimer;
        for (let i = 0; i < 50; i++) step(0); // paused frames
        expect(gpu.batchWindowTimer).toBe(windowBefore);
        expect(gpu.batchState).toBe("filling");
        expect(STATE.requestsProcessed).toBe(0);
    });
});

// ============================ GPU MODEL COLD START ============================
describe("GPU model cold start (#87 §2b)", () => {
    it("a fresh GPU is loading (12s at tier 1) and NOT routable — the dedicated flag, never isDisabled", () => {
        const gpu = place("gpu");
        expect(gpu.modelLoading).toBe(true);
        expect(gpu.isDisabled).toBeFalsy();
        expect(isRoutable(gpu)).toBe(false);
        runGame(11.5);
        expect(gpu.modelLoading).toBe(true); // still loading
        runGame(1.0); // past 12s
        expect(gpu.modelLoading).toBe(false);
        expect(isRoutable(gpu)).toBe(true);
    });

    it("HELD arrivals: requests queued during the load age untouched and batch normally after it", () => {
        const gpu = place("gpu"); // loading for 12s
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        for (let i = 0; i < 4; i++) flyInto("INFERENCE", gpu);

        runGame(5); // mid-load: landed, held
        expect(gpu.queue.length).toBe(4);
        expect(totalFailures()).toBe(0); // nothing died waiting — the stall IS the lesson
        expect(STATE.requestsProcessed).toBe(0);

        runGame(8); // load done at t=12; then window + run
        runGame(3);
        expect(STATE.requestsProcessed).toBe(4);
        expect(STATE.requests.length).toBe(0); // TERMINATION post-load
    });

    it("tier upgrade RE-triggers the load at the new duration, holding queued arrivals across it", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        gpu.upgrade(); // tier 2: batch 12, risk 4%, load 20s
        expect(gpu.tier).toBe(2);
        expect(gpu.modelLoading).toBe(true);
        expect(gpu.config.loadTimeSec).toBe(20);
        expect(gpu.config.batchSize).toBe(12);
        expect(gpu.config.maxQueueSize).toBe(12); // bounded intake follows the tier

        pushInference(gpu, 3, 1);
        runGame(19); // still loading
        expect(gpu.queue.length).toBe(3);
        expect(totalFailures()).toBe(0);
        runGame(1.2); // load completes
        runGame(3); // window + run
        expect(STATE.requestsProcessed).toBe(3);
    });

    it("an upgrade DURING a run stalls the batch until the reload completes — then it finishes", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(gpu, 8, 1);
        stepGame(0.1); // running, 2100ms
        runGame(1.0);
        gpu.upgrade(); // self-inflicted outage: 20s reload mid-run
        runGame(19); // whole reload
        expect(STATE.requestsProcessed).toBe(0); // batch held, not lost
        runGame(2.5); // reload done + the remaining ~1s of run
        expect(STATE.requestsProcessed).toBe(8);
        expect(STATE.requests.length).toBe(0);
    });

    it("tiers are model size: batch 8/12/16, risk 10%/4%/1%, load 12/20/30s", () => {
        const tiers = CONFIG.services.gpu.tiers;
        expect(tiers.map((t) => t.batchSize)).toEqual([8, 12, 16]);
        expect(tiers.map((t) => t.qualityRisk)).toEqual([0.1, 0.04, 0.01]);
        expect(tiers.map((t) => t.loadTimeSec)).toEqual([12, 20, 30]);
        expect(tiers[0].cost).toBe(0);
    });

    it("save/load: a restored tier-3 GPU carries its model-size fields and cold-boots at the tier's duration", () => {
        const restored = Service.restore(
            { type: "gpu", id: "svc_test_gpu", tier: 3 },
            new globalThis.THREE.Vector3(0, 0, 0)
        );
        expect(restored.tier).toBe(3);
        expect(restored.config.batchSize).toBe(16);
        expect(restored.config.qualityRisk).toBe(0.01);
        expect(restored.config.maxQueueSize).toBe(16); // bounded intake follows
        expect(restored.config.loadTimeSec).toBe(30);
        expect(restored.modelLoading).toBe(true); // a load is a cold boot
        restored.destroy();
    });
});

// =============================== GPU QUALITY ===============================
describe("GPU quality risk (#87 §2c-d)", () => {
    it("the reputation constant is −0.5 and lives in SCORE_POINTS", () => {
        expect(CONFIG.survival.SCORE_POINTS.QUALITY_RISK_REPUTATION).toBe(-0.5);
    });

    it("a bad answer COMPLETES and pays, then costs −0.5 rep and ticks badAnswers — never a counted failure", () => {
        const gpu = warm(place("gpu"));
        pushInference(gpu, 4, 1);
        STATE.reputation = 50;
        const moneyBefore = STATE.money;
        vi.spyOn(Math, "random").mockReturnValue(0.0); // every roll hits (0 < 0.1)

        stepGame(0.1); // window path: 4 < 8
        runGame(1.5); // window fires
        runGame(1.7); // (900+600)×1 = 1500ms run

        expect(STATE.requestsProcessed).toBe(4); // all finished
        expect(gpu.badAnswers).toBe(4);
        expect(totalFailures()).toBe(0); // success-side event — #156 intact
        expect(STATE.money - moneyBefore).toBeCloseTo(4 * 0.5, 5); // paid in full
        // 4 × (+0.1 success) + 4 × (−0.5 quality)
        expect(STATE.reputation).toBeCloseTo(50 + 4 * 0.1 - 4 * 0.5, 5);
    });

    it("legibility: the amber 'Bad answer' soft badge rises over the GPU, aggregated, via the new spawn path", () => {
        const gpu = warm(place("gpu"));
        pushInference(gpu, 3, 1);
        vi.spyOn(Math, "random").mockReturnValue(0.0);
        runGame(4);

        const badge = getFailureBadges().find((b) => b.reason === SOFT_BADGES.BAD_ANSWER);
        expect(badge).toBeDefined();
        expect(badge.count).toBe(3); // aggregated, not three sprites
        expect(SOFT_REASONS.has(SOFT_BADGES.BAD_ANSWER)).toBe(true); // painted amber
    });

    it("tier 3 rolls at 1%: with a roll above it, zero bad answers on a full batch", () => {
        const gpu = warm(place("gpu"));
        gpu.config = { ...gpu.config, qualityRisk: 0.01 };
        pushInference(gpu, 8, 1);
        vi.spyOn(Math, "random").mockReturnValue(0.05); // above 1%, below 10%
        runGame(3);
        expect(STATE.requestsProcessed).toBe(8);
        expect(gpu.badAnswers).toBe(0);
    });
});

// ========================= GPU ECONOMICS HARNESS =========================
describe("GPU profit/min-at-fill harness (#87 §2, the mandated curve)", () => {
    // The saturated (pipelined) regime: batches run back-to-back at fill f,
    // n = f·batchSize requests each, at the mean genLength 1.28. The analytic
    // model pins the CONFIG constants to the intended curve...
    //
    //   fill   n     batchMs   $/min    profit/min
    //   20%   1.6    1459.2    32.89     −27.11
    //   47%   3.74   1899.5    59.06     −0.94   ← analytic break-even 46.8%
    //   60%   4.8    2073.6    69.44     +9.44
    //  100%   8.0    2688.0    89.29     +29.29
    //
    // ...and the SIM measurement below is the authority that the game
    // implements it. The two only agree because the batch window seeds from
    // the head's true FIRST arrival (src/sim/gpu.js): reset the window at
    // drain instead and every partial batch pays a dead 1.5s on top of its
    // run, which drags the live break-even from ~half fill to ~93% — that
    // regression is exactly what the sim leg here would catch.
    const gpu = () => CONFIG.services.gpu;
    const MEAN_GEN = 1.28;
    function profitPerMin(fill) {
        const n = fill * gpu().batchSize;
        const batchMs = (gpu().batchBaseMs + gpu().batchPerItemMs * n) * MEAN_GEN;
        const revenuePerMin = (n * CONFIG.trafficTypes.INFERENCE.reward * 60000) / batchMs;
        return revenuePerMin - gpu().upkeep;
    }

    // Drive the REAL tickGpu with a steady arrival stream and read profit off
    // the actually-served count. Deterministic: a 70/30 short/long genLength
    // pattern at the band means (exact mean 1.28), arrivals metered by rate,
    // spawn-side overflow mirrored on the bounded intake. Returns profit/min
    // and the mean batch fill actually launched.
    function measureGpu(rps, seconds = 240) {
        resetWorld();
        const node = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99); // no quality hits
        const gen = [0.8, 0.8, 2.4, 0.8, 0.8, 0.8, 2.4, 0.8, 0.8, 2.4];
        const dt = 0.05;
        let acc = 0, spawned = 0, batches = 0, filled = 0;
        for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
            acc += rps * dt;
            while (acc >= 1) {
                acc -= 1;
                // The bounded-intake drop (QUEUE_FULL in the live game): an
                // arrival past the cap earns nothing — skip creating it.
                if (node.queue.length < node.config.maxQueueSize) {
                    pushInference(node, 1, gen[spawned % gen.length]);
                }
                spawned++;
            }
            const wasRunning = node.batchState === "running";
            const launchSize = node.batch.length;
            stepGame(dt);
            if (wasRunning && node.batchState === "filling") {
                batches++;
                filled += launchSize;
            }
        }
        const revenuePerMin =
            (STATE.requestsProcessed * CONFIG.trafficTypes.INFERENCE.reward * 60) / seconds;
        return {
            profitPerMin: revenuePerMin - gpu().upkeep,
            fill: batches > 0 ? filled / (batches * gpu().batchSize) : 0,
        };
    }

    it("full-fill saturated profit ≈ +$29/min", () => {
        expect(profitPerMin(1.0)).toBeGreaterThan(27);
        expect(profitPerMin(1.0)).toBeLessThan(31);
    });

    it("20% fill LOSES money, 60% fill makes it — utilization is the whole game", () => {
        expect(profitPerMin(0.2)).toBeLessThan(0);
        expect(profitPerMin(0.6)).toBeGreaterThan(0);
    });

    it("break-even sits mid-curve (40–60% fill), so the second-GPU trap is real", () => {
        let lo = 0.01, hi = 1.0;
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (profitPerMin(mid) < 0) lo = mid;
            else hi = mid;
        }
        expect(lo).toBeGreaterThan(0.4);
        expect(lo).toBeLessThan(0.6);
    });

    it("SIM: the live game matches the analytic curve — red at 1.2 rps, break-even near 2.0, +$29 saturated", () => {
        // 1.2 rps is survival's 10%-share feed at 12 RPS: clearly in the red.
        expect(measureGpu(1.2).profitPerMin).toBeLessThan(-15);
        // 2.0 rps is the analytic break-even arrival (upkeep 60 / ($0.50·60)).
        const be = measureGpu(2.0);
        expect(Math.abs(be.profitPerMin)).toBeLessThan(4);
        // ...and it lands at MID-CURVE fill — the spec's "break-even ≈ 52%".
        expect(be.fill).toBeGreaterThan(0.4);
        expect(be.fill).toBeLessThan(0.65);
        // Saturated: throughput pins to the ceiling, batches run full.
        const sat = measureGpu(4.0);
        expect(sat.profitPerMin).toBeGreaterThan(26);
        expect(sat.profitPerMin).toBeLessThan(32);
        expect(sat.fill).toBeGreaterThan(0.9);
    });

    it("infgw is priced for its scope: $70 with upkeep below the API Gateway's", () => {
        expect(CONFIG.services.infgw.cost).toBe(70);
        expect(CONFIG.services.infgw.upkeep).toBe(5);
        expect(CONFIG.services.infgw.upkeep).toBeLessThan(CONFIG.services.apigw.upkeep);
        expect(CONFIG.services.infgw.deadlineSec).toBe(6);
        expect(CONFIG.services.infgw.maxQueueSize).toBe(20);
    });
});

// ============================= FINANCE PANEL =============================
describe("finance panel itemizes the AI economy (#87)", () => {
    it("INFERENCE income renders as its own row — the panel the batch lesson tells the player to read", () => {
        const node = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(node, 8, 1);
        runGame(3); // full batch launches and completes
        expect(STATE.finances.income.byType.INFERENCE).toBeCloseTo(8 * 0.5, 5);
        expect(STATE.finances.income.countByType.INFERENCE).toBe(8);

        updateFinancesDisplay();
        const html = document.getElementById("income-details").innerHTML;
        expect(html).toContain(i18n.t("income_inference"));
        expect(html).not.toContain(i18n.t("no_income")); // itemization matches the total again
        expect(html).toContain("$0.50"); // the per-request rate column
    });

    it("gpu / infgw / power expenses render as rows, not silence", () => {
        STATE.finances.expenses.byService.gpu = 60;
        STATE.finances.expenses.byService.infgw = 5;
        STATE.finances.expenses.byService.power = 8;
        updateFinancesDisplay();
        const html = document.getElementById("expense-details").innerHTML;
        expect(html).toContain(i18n.t("gpu"));
        expect(html).toContain(i18n.t("infgw"));
        expect(html).toContain(i18n.t("power"));
    });
});

// ============================ INFERENCE GATEWAY ============================
describe("Inference Gateway deadline queue (#87 §3)", () => {
    it("SWEEPS before dispatching: an entry past the deadline is expired, never sent to a GPU", () => {
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        connect(infgw, gpu);
        STATE.elapsedGameTime = 100;
        seedPending(infgw, 2, 7); // older than deadlineSec 6
        const fresh = seedPending(infgw, 1, 0);

        infgw.update(0.1);

        expect(STATE.inference.expired).toBe(2);
        expect(infgw.expiredCount).toBe(2);
        expect(STATE.failures.INFERENCE).toBe(2); // failRequest(SLO_TIMEOUT), explicit — never failOrPark
        // Only the fresh entry was dispatched; the expired ones never flew.
        expect(fresh[0].target).toBe(gpu);
        expect(infgw.pending.length).toBe(0);
    });

    it("expiry is exactly-once even across the 500ms fail-fade window (splice-before-fail)", () => {
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        connect(infgw, gpu);
        STATE.elapsedGameTime = 100;
        seedPending(infgw, 3, 7);

        infgw.update(0.1);
        expect(STATE.inference.expired).toBe(3);
        // The failed requests are still fading in STATE.requests — tick more:
        // they are out of the array, so nothing double-expires or dispatches.
        expect(STATE.requests.length).toBe(3);
        for (let i = 0; i < 5; i++) infgw.update(0.1);
        expect(STATE.inference.expired).toBe(3);
        expect(gpu.queue.length).toBe(0);
        flushRemovals();
        expect(STATE.requests.length).toBe(0);
    });

    it("dispatches heads to the LEAST-loaded routable GPU (queue + batch + in-flight)", () => {
        const infgw = place("infgw");
        place("power"); // grid headroom for the second GPU
        const busy = warm(place("gpu"));
        const idle = warm(place("gpu"));
        connect(infgw, busy);
        connect(infgw, idle);
        pushInference(busy, 5, 1); // busy carries a backlog

        const reqs = seedPending(infgw, 2, 0);
        infgw.update(0.1);

        expect(reqs[0].target).toBe(idle);
        expect(reqs[1].target).toBe(idle); // still lighter with 1 in flight vs 5 queued
    });

    it("holds entries while every GPU is warming, then dispatches the moment a load completes", () => {
        const infgw = place("infgw");
        const gpu = place("gpu"); // loading (12s)
        connect(infgw, gpu);
        gpu.modelLoadTimer = 11.8; // almost done
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        seedPending(infgw, 3, 0);

        infgw.update(0.1); // warming → nothing moves
        expect(infgw.pending.length).toBe(3);
        expect(gpu.queue.length).toBe(0);

        runGame(0.5); // load completes; next gateway tick dispatches
        expect(infgw.pending.length).toBe(0);
        runGame(4); // batch and finish
        expect(STATE.requestsProcessed).toBe(3);
        expect(STATE.requests.length).toBe(0);
    });

    it("WARMUP GRACE: entries do not age while every connected GPU is loading — and serve after, not expire", () => {
        const infgw = place("infgw");
        const gpu = place("gpu"); // loading for 12s — twice the 6s deadline
        connect(infgw, gpu);
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        STATE.elapsedGameTime = 50;
        seedPending(infgw, 3, 5.5); // 0.5s of deadline left — doomed without the grace

        runGame(8, 0.1); // the whole fleet is warming: the clock waits
        expect(STATE.inference.expired).toBe(0);
        expect(infgw.pending.length).toBe(3);

        runGame(8, 0.1); // load done at 12s; the clock resumes at 5.5s — dispatched, not swept
        expect(STATE.inference.expired).toBe(0);
        expect(infgw.pending.length).toBe(0);
        runGame(4);
        expect(STATE.requestsProcessed).toBe(3); // reputation SAVED during the warmup window
        expect(STATE.requests.length).toBe(0);
    });

    it("no grace without a fleet: a gateway with zero connected GPUs still expires honestly", () => {
        const infgw = place("infgw");
        STATE.elapsedGameTime = 50;
        seedPending(infgw, 3, 5.5);
        runGame(2, 0.1); // nothing connected — the deadline is the only exit
        expect(STATE.inference.expired).toBe(3);
        flushRemovals();
        expect(STATE.requests.length).toBe(0);
    });

    it("no grace while ONE connected GPU is live: entries age toward the deadline as usual", () => {
        const infgw = place("infgw");
        place("power"); // headroom for the second GPU
        const warmGpu = warm(place("gpu"));
        const coldGpu = place("gpu"); // loading — but its warm peer keeps the clock honest
        connect(infgw, warmGpu);
        connect(infgw, coldGpu);
        // The warm GPU is FULL, so entries cannot dispatch and must age.
        pushInference(warmGpu, warmGpu.config.maxQueueSize + warmGpu.config.batchSize, 1);
        STATE.elapsedGameTime = 50;
        seedPending(infgw, 3, 5.5);
        runGame(1, 0.1); // past the 6s deadline — no freeze, they expire
        expect(STATE.inference.expired).toBe(3);
    });

    it("the held backlog is bounded at 20: an arrival past the cap takes the QUEUE_FULL drop", () => {
        const infgw = place("infgw");
        seedPending(infgw, 20, 0); // at capacity, no GPU to drain into
        const overflow = flyInto("INFERENCE", infgw);
        runGame(0.6); // land + admission tick

        expect(infgw.pending.length).toBe(20);
        expect(STATE.failures.INFERENCE).toBe(1);
        expect(overflow.failed).toBe(true);
    });

    it("PAUSE freezes the deadline clock: entries at the brink do not expire while time stands still", () => {
        const infgw = place("infgw");
        STATE.elapsedGameTime = 50;
        seedPending(infgw, 4, 5.9); // 0.1s from the deadline

        for (let i = 0; i < 30; i++) infgw.update(0); // paused frames — elapsedGameTime untouched
        expect(STATE.inference.expired).toBe(0);
        expect(infgw.pending.length).toBe(4);

        STATE.elapsedGameTime += 0.2; // resume past the deadline
        infgw.update(0.1);
        expect(STATE.inference.expired).toBe(4);
    });

    it("CampaignObjectives.expiredRequests reads the session counter", () => {
        expect(CampaignObjectives.expiredRequests(STATE)).toBe(0);
        STATE.inference.expired = 7;
        expect(CampaignObjectives.expiredRequests(STATE)).toBe(7);
    });
});

// ================================= ROUTING =================================
describe("routing: type-aware forwarding + the compute branch (#87 §1)", () => {
    it("forwardCandidates prefers infgw, then gpu, then the generic set for INFERENCE", () => {
        const alb = place("alb");
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        const compute = place("compute");
        // Hand-wire (unit level) so all three are simultaneous candidates.
        alb.connections = [infgw.id, gpu.id, compute.id];
        const req = { type: "INFERENCE" };

        expect(forwardCandidates(alb, req)).toEqual([infgw]);
        alb.connections = [gpu.id, compute.id];
        expect(forwardCandidates(alb, req)).toEqual([gpu]);
        alb.connections = [compute.id];
        expect(forwardCandidates(alb, req)).toEqual([compute]); // generic fallback still knows the way
    });

    it("forwardCandidates EXCLUDES infgw/gpu for everything else — they join the dlq exclusion", () => {
        const alb = place("alb");
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        const compute = place("compute");
        const dlq = place("dlq");
        alb.connections = [infgw.id, gpu.id, compute.id, dlq.id];

        expect(forwardCandidates(alb, { type: "READ" })).toEqual([compute]);
        expect(forwardCandidates(alb, { type: "MALICIOUS" })).toEqual([compute]);
    });

    it("integration: an ALB sends INFERENCE to its gateway and READ to its compute, never crossed", () => {
        const alb = place("alb");
        const infgw = place("infgw");
        const compute = place("compute");
        connect(alb, infgw);
        connect(alb, compute);
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        for (let i = 0; i < 4; i++) flyInto("INFERENCE", alb);
        for (let i = 0; i < 3; i++) flyInto("READ", alb);
        runGame(2);

        // All 4 INFERENCE are held at the (gpu-less) gateway...
        expect(infgw.pending.length + infgw.queue.length).toBe(4);
        // ...and all 3 READs went to compute (and died there: no DB wired).
        expect(STATE.failures.READ).toBe(3);
        expect(STATE.failures.INFERENCE).toBe(0);
    });

    it("the API Gateway's forward carries the same preference/exclusion (shared filter)", () => {
        const apigw = place("apigw");
        const infgw = place("infgw");
        const alb = place("alb");
        connect(apigw, infgw);
        connect(apigw, alb);
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        const inf = flyInto("INFERENCE", apigw);
        const read = flyInto("READ", apigw);
        runGame(1);

        expect(inf.target).toBe(infgw);
        expect(read.target === infgw).toBe(false);
    });

    it("compute's explicit INFERENCE branch: infgw first, direct gpu second, else NO_ROUTE", () => {
        // NOTE: Math.random is mocked only AFTER services are placed in each
        // part — Service ids are drawn from Math.random, and a constant mock
        // would mint colliding ids that break the connection graph.
        // 1) infgw preferred over a direct gpu.
        let compute = place("compute");
        const infgw = place("infgw");
        let gpu = warm(place("gpu"));
        connect(compute, infgw);
        connect(compute, gpu);
        let spy = vi.spyOn(Math, "random").mockReturnValue(0.99);
        const viaGw = flyInto("INFERENCE", compute);
        runGame(1.5);
        expect(viaGw.target).toBe(infgw);
        spy.mockRestore();

        // 2) direct gpu when no gateway.
        resetWorld();
        compute = place("compute");
        gpu = warm(place("gpu"));
        connect(compute, gpu);
        spy = vi.spyOn(Math, "random").mockReturnValue(0.99);
        const direct = flyInto("INFERENCE", compute);
        runGame(1.5);
        expect(direct.target).toBe(gpu);
        spy.mockRestore();

        // 3) neither → NO_ROUTE, counted under STATE.failures.INFERENCE.
        resetWorld();
        compute = place("compute");
        connect(compute, place("db"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        flyInto("INFERENCE", compute);
        runGame(1.5);
        flushRemovals();
        expect(STATE.failures.INFERENCE).toBe(1);
        expect(STATE.requests.length).toBe(0);
    });

    it("a MALICIOUS request reaching a GPU is the breach it is — the existing failRequest relabel", () => {
        const gpu = warm(place("gpu"));
        const moneyBefore = STATE.money;
        flyInto("MALICIOUS", gpu);
        runGame(1);
        flushRemovals();

        expect(STATE.failures.MALICIOUS).toBe(1);
        expect(moneyBefore - STATE.money).toBeCloseTo(50, 5); // MALICIOUS_BREACH_PENALTY
        expect(STATE.reputation).toBeCloseTo(95, 5); // −5
        expect(STATE.requests.length).toBe(0);
    });

    it("a MALICIOUS request reaching the gateway relabels identically", () => {
        const infgw = place("infgw");
        const moneyBefore = STATE.money;
        flyInto("MALICIOUS", infgw);
        runGame(1);
        flushRemovals();
        expect(STATE.failures.MALICIOUS).toBe(1);
        expect(moneyBefore - STATE.money).toBeCloseTo(50, 5);
    });

    it("non-INFERENCE at a GPU fails fast with the gpu-only lesson (fail_gpu_only)", () => {
        const gpu = warm(place("gpu"));
        flyInto("READ", gpu);
        runGame(1);
        flushRemovals();
        expect(STATE.failures.READ).toBe(1);
        expect(STATE.requestsProcessed).toBe(0);
        expect(getFailureBadges().some((b) => b.reason === "fail_gpu_only")).toBe(true);
    });
});

// =========================== CONNECTION VALIDITY ===========================
describe("isValidEdge rows (#87 §1) — and power is unwireable", () => {
    it("accepts exactly the spec'd feeds into infgw, infgw→gpu, and the compute-tier→gpu edges", () => {
        for (const from of ["alb", "apigw", "compute", "serverless", "container"]) {
            expect(isValidEdge(from, "infgw"), `${from} → infgw`).toBe(true);
        }
        expect(isValidEdge("infgw", "gpu")).toBe(true);
        for (const from of ["compute", "serverless", "container"]) {
            expect(isValidEdge(from, "gpu"), `${from} → gpu`).toBe(true);
        }
    });

    it("rejects everything else around gpu/infgw — no entry edges, no loops back up", () => {
        expect(isValidEdge("internet", "gpu")).toBe(false);
        expect(isValidEdge("internet", "infgw")).toBe(false);
        expect(isValidEdge("waf", "gpu")).toBe(false);
        expect(isValidEdge("waf", "infgw")).toBe(false);
        expect(isValidEdge("sqs", "infgw")).toBe(false);
        expect(isValidEdge("gpu", "db")).toBe(false); // gpu is a pure terminal
        expect(isValidEdge("gpu", "infgw")).toBe(false);
        expect(isValidEdge("infgw", "alb")).toBe(false);
    });

    it("power has NO edges in either direction — unwireable like monitor, so never in a region subtree", () => {
        for (const other of ["internet", "waf", "alb", "compute", "gpu", "infgw", "sqs"]) {
            expect(isValidEdge(other, "power"), `${other} → power`).toBe(false);
            expect(isValidEdge("power", other), `power → ${other}`).toBe(false);
        }
    });
});

// ================================ POWER GRID ================================
describe("power grid (#87 §4)", () => {
    it("recomputePower derives {usedKw, capKw} from live services", () => {
        expect(STATE.power).toEqual({ usedKw: 0, capKw: 8 });
        place("gpu");
        expect(STATE.power).toEqual({ usedKw: 6, capKw: 8 });
        place("power");
        expect(STATE.power).toEqual({ usedKw: 6, capKw: 14 });
        place("gpu");
        expect(STATE.power).toEqual({ usedKw: 12, capKw: 14 });
    });

    it("placement gate BOTH directions: the 2nd GPU is refused on the base cap, allowed after a substation", () => {
        place("gpu"); // 6 of 8 — fine
        const before = STATE.services.length;
        const moneyBefore = STATE.money;
        createService("gpu", new globalThis.THREE.Vector3(60, 0, 60));
        expect(STATE.services.length).toBe(before); // refused
        expect(STATE.money).toBe(moneyBefore); // and nothing was charged

        place("power"); // cap 14
        createService("gpu", new globalThis.THREE.Vector3(60, 0, 60));
        expect(STATE.services.length).toBe(before + 2); // allowed now
    });

    it("the gate is boundary INCLUSIVE: a draw landing exactly on the cap is legal", () => {
        // Pin the <= (not <) directly on the predicate.
        STATE.power = { usedKw: 8, capKw: 14 };
        expect(hasPowerHeadroom()).toBe(true); // 8 + 6 == 14 — exactly on it
        STATE.power = { usedKw: 9, capKw: 14 };
        expect(hasPowerHeadroom()).toBe(false); // one watt over
        recomputePower();
    });

    it("level-24 shape: 3 GPUs (18 kW) fit on base 8 + TWO substations (20 kW); a 4th is refused", () => {
        place("power");
        place("power");
        place("gpu");
        place("gpu");
        place("gpu");
        expect(STATE.power).toEqual({ usedKw: 18, capKw: 20 });
        const before = STATE.services.length;
        createService("gpu", new globalThis.THREE.Vector3(70, 0, 70));
        expect(STATE.services.length).toBe(before);
    });

    it("deletion gate (anti-cheese): a substation whose loss strands powered GPUs refuses demolition", () => {
        const sub = place("power");
        place("gpu");
        const gpu2 = place("gpu"); // 12 kW on cap 14
        const moneyBefore = STATE.money;

        deleteObject(sub.id); // buy-place-refund attempt
        expect(STATE.services.some((s) => s.id === sub.id)).toBe(true); // refused
        expect(STATE.money).toBe(moneyBefore); // no refund cheese

        deleteObject(gpu2.id); // GPU deletion stays free
        expect(STATE.services.some((s) => s.id === gpu2.id)).toBe(false);
        expect(STATE.power.usedKw).toBe(6);

        deleteObject(sub.id); // now the cap can shrink safely
        expect(STATE.services.some((s) => s.id === sub.id)).toBe(false);
        expect(STATE.power).toEqual({ usedKw: 6, capKw: 8 });
    });
});

// ============================ SHARE (POWER-FIRST) ============================
describe("share links: power-first sort with index remap (#87 §4)", () => {
    // Explicit grid positions (the shared place() helper marches x outward
    // past the share format's position bound).
    function placeAt(type, x, z) {
        const before = STATE.services.length;
        createService(type, new globalThis.THREE.Vector3(x, 0, z));
        expect(STATE.services.length).toBe(before + 1);
        return STATE.services[STATE.services.length - 1];
    }

    // alb(0), gpu(1), power(2), gpu(3), infgw(4) in PLACEMENT order — legal to
    // build live (the substation lands before the second GPU needs it), but a
    // naive placement-order payload would rebuild gpu #2 before the substation
    // and lose it to the gate.
    function buildPoweredArch() {
        const alb = placeAt("alb", -16, 0);
        const gpu1 = placeAt("gpu", -8, 0);
        placeAt("power", 0, 0);
        const gpu2 = placeAt("gpu", 8, 0);
        const infgw = placeAt("infgw", 16, 0);
        createConnection("internet", alb.id);
        createConnection(alb.id, infgw.id);
        createConnection(infgw.id, gpu1.id);
        createConnection(infgw.id, gpu2.id);
    }

    it("encodeArch sorts power first and remaps every c/i index through the permutation, p in lockstep", () => {
        buildPoweredArch();
        const arch = encodeArch();

        expect(arch.t).toEqual(["power", "alb", "gpu", "gpu", "infgw"]);
        // Positions followed their services through the permutation.
        expect(arch.p).toEqual([0, 0, -16, 0, -8, 0, 8, 0, 16, 0]);
        // internet → alb is now index 1; alb→infgw, infgw→gpu1, infgw→gpu2 remapped.
        expect(arch.i).toEqual([1]);
        expect(arch.c).toEqual([1, 4, 4, 2, 4, 3]);
    });

    it("a power+gpu build round-trips to an IDENTICAL service set through the real decoder + rebuild", () => {
        STATE.sandboxBudget = 2000;
        buildPoweredArch();
        const snapshot = STATE.services
            .map((s) => `${s.type}@${s.position.x},${s.position.z}`)
            .sort();
        const url = buildShareUrl();
        expect(url).not.toBeNull();
        const arch = decodeArchParam(url.split("?arch=")[1]);
        expect(arch).not.toBeNull();

        resetWorld({ money: 0 });
        rebuildSharedArch(arch);

        // Identical multiset of services — the second GPU survived because the
        // substation was rebuilt before it reached the placement gate.
        const rebuilt = STATE.services
            .map((s) => `${s.type}@${s.position.x},${s.position.z}`)
            .sort();
        expect(rebuilt).toEqual(snapshot);
        expect(STATE.services.filter((s) => s.type === "gpu")).toHaveLength(2);
        expect(STATE.connections).toHaveLength(4); // internet edge + 3 service edges
        expect(STATE.power).toEqual({ usedKw: 12, capKw: 14 });
    });
});

// ============================ SURVIVAL STAGING ============================
describe("survival staging: 0 → 3% → 10% + hype gating (#87 §1)", () => {
    beforeEach(() => {
        resetWorld({ gameMode: "survival" });
        STATE.trafficDistribution = { ...CONFIG.survival.trafficDistribution };
    });

    const sumOf = (dist) => Object.values(dist).reduce((a, b) => a + b, 0);

    it("before 300s the base INFERENCE share stays 0", () => {
        STATE.elapsedGameTime = 299;
        updateInferenceStaging();
        expect(STATE.trafficDistribution.INFERENCE).toBe(0);
    });

    it("after 300s the base moves to 3%, taken proportionally, summing to 1", () => {
        STATE.elapsedGameTime = 301;
        updateInferenceStaging();
        const d = STATE.trafficDistribution;
        expect(d.INFERENCE).toBeCloseTo(0.03, 9);
        expect(sumOf(d)).toBeCloseTo(1, 9);
        // Proportional: STATIC/READ keep their 0.3/0.2 ratio.
        expect(d.STATIC / d.READ).toBeCloseTo(1.5, 9);
    });

    it("once a GPU exists the base rebalances to 10% — steady food between hypes", () => {
        STATE.elapsedGameTime = 100; // ownership wins even before 300s (no dead GPU)
        place("gpu");
        updateInferenceStaging();
        expect(STATE.trafficDistribution.INFERENCE).toBeCloseTo(0.1, 9);
        expect(sumOf(STATE.trafficDistribution)).toBeCloseTo(1, 9);
    });

    it("mid-shift, staging adjusts the BASE the shift will restore — not the live shifted mix", () => {
        STATE.elapsedGameTime = 400;
        STATE.intervention.trafficShiftActive = true;
        STATE.intervention.originalTrafficDist = { ...CONFIG.survival.trafficDistribution };
        STATE.trafficDistribution = { STATIC: 0.1, READ: 0.35, WRITE: 0.25, UPLOAD: 0.05, SEARCH: 0.15, MALICIOUS: 0.1 };

        updateInferenceStaging();

        expect(STATE.intervention.originalTrafficDist.INFERENCE).toBeCloseTo(0.03, 9);
        expect(STATE.trafficDistribution.INFERENCE || 0).toBe(0); // live shift untouched
    });

    it("during a malicious spike, staging targets the saved normal mix the spike will restore", () => {
        STATE.elapsedGameTime = 400;
        STATE.maliciousSpikeActive = true;
        STATE.normalTrafficDist = { ...CONFIG.survival.trafficDistribution };
        updateInferenceStaging();
        expect(STATE.normalTrafficDist.INFERENCE).toBeCloseTo(0.03, 9);
    });

    it("a malicious spike scales the INFERENCE share down like every classic share — not to zero", () => {
        STATE.trafficDistribution = {
            STATIC: 0.25, READ: 0.2, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.05,
            MALICIOUS: 0.2, INFERENCE: 0.1,
        };
        // Drive the spike start through the real timer path.
        STATE.maliciousSpikeTimer = CONFIG.survival.maliciousSpike.interval - 0.05;
        updateMaliciousSpike(0.1);
        expect(STATE.maliciousSpikeActive).toBe(true);
        // 0.1 of the 0.8 non-malicious mass, rescaled to the 0.5 remainder.
        expect(STATE.trafficDistribution.INFERENCE).toBeCloseTo((0.1 / 0.8) * 0.5, 9);
        expect(STATE.trafficDistribution.MALICIOUS).toBeCloseTo(0.5, 9);
        // Cleanup: restore the quiet baseline for the tests that follow.
        STATE.maliciousSpikeActive = false;
        STATE.normalTrafficDist = null;
        STATE.maliciousSpikeTimer = 0;
        document.getElementById("malicious-spike-indicator")?.remove();
    });

    it("the AI Hype Wave is written out in CONFIG: INFERENCE 25%, classic shares ×0.75, sums to 1", () => {
        const hype = CONFIG.survival.trafficShift.shifts.find((s) => s.name === "AI Hype Wave");
        expect(hype).toBeDefined();
        expect(hype.requiresService).toBe("gpu");
        expect(hype.distribution.INFERENCE).toBeCloseTo(0.25, 9);
        expect(hype.distribution.STATIC).toBeCloseTo(0.3 * 0.75, 9);
        expect(sumOf(hype.distribution)).toBeCloseTo(1, 9);
    });

    it("hype gating at SELECTION time: never picked without a GPU, pickable with one", () => {
        // Math.random 0.99 always selects the LAST shift of the eligible list;
        // the hype wave sits last in CONFIG, so it wins iff it is eligible.
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        STATE.intervention.trafficShiftTimer = 41; // past the 40s interval
        updateTrafficShift(0.1);
        expect(STATE.intervention.trafficShiftActive).toBe(true);
        expect(STATE.intervention.currentShift.name).not.toBe("AI Hype Wave");

        // Reset and re-select with a GPU on the board.
        STATE.intervention.trafficShiftActive = false;
        STATE.intervention.currentShift = null;
        STATE.intervention.originalTrafficDist = null;
        STATE.trafficDistribution = { ...CONFIG.survival.trafficDistribution };
        place("gpu");
        STATE.intervention.trafficShiftTimer = 41;
        updateTrafficShift(0.1);
        expect(STATE.intervention.currentShift.name).toBe("AI Hype Wave");
        expect(STATE.trafficDistribution.INFERENCE).toBeCloseTo(0.25, 9);
    });

    it("losing the last GPU mid-shift does NOT cancel a running hype wave", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        const gpu = place("gpu");
        STATE.intervention.trafficShiftTimer = 41;
        updateTrafficShift(0.1);
        expect(STATE.intervention.currentShift.name).toBe("AI Hype Wave");

        deleteObject(gpu.id); // the ownership gate was selection-time only
        STATE.intervention.trafficShiftTimer = 5;
        updateTrafficShift(0.1);
        expect(STATE.intervention.trafficShiftActive).toBe(true);
        expect(STATE.intervention.currentShift.name).toBe("AI Hype Wave");

        STATE.intervention.trafficShiftTimer = CONFIG.survival.trafficShift.duration;
        updateTrafficShift(0.1); // runs out its natural duration
        expect(STATE.intervention.trafficShiftActive).toBe(false);
    });
});

// =============================== LEAK BATTERY ===============================
describe("the §6 leak battery — the cardinal invariant (#191/#192)", () => {
    it("MID-BATCH DEMOLISH: deleting a GPU re-homes its live batch, queue and in-flight arrivals", () => {
        const gpu = warm(place("gpu"));
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        pushInference(gpu, 8, 1);
        stepGame(0.1); // batch running
        pushInference(gpu, 3, 1); // next-batch queue
        flyInto("INFERENCE", gpu); // mid-air arrival
        expect(STATE.requests.length).toBe(12);

        deleteObject(gpu.id);
        expect(STATE.requests.length).toBe(0); // NOTHING stranded
        expect(STATE.services).toHaveLength(0);
    });

    it("REGION OUTAGE over a busy GPU: batch + gateway entries die with their region, exactly once", () => {
        const dns = place("dns");
        const alb = place("alb");
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        connect("internet", dns);
        connect(dns, alb);
        connect(alb, infgw);
        connect(infgw, gpu);

        // A busy region: a running batch of 3 and 2 gateway entries.
        pushInference(gpu, 3, 1);
        gpu.update(0.1); // window starts; force-launch for determinism:
        gpu.batchState = "running";
        gpu.batchRunTimeMs = 5000;
        gpu.batchRunTimer = 0;
        seedPending(infgw, 2, 0);
        expect(STATE.requests.length).toBe(5);

        expect(triggerRegionOutage(10)).toBe(true);

        expect(gpu.batch.length).toBe(0); // swept, not left to finish in the dark
        expect(infgw.pending.length).toBe(0);
        expect(gpu.isDisabled).toBe(true);
        expect(STATE.failures.INFERENCE).toBe(5); // failed as REGION_DOWN, counted once each
        flushRemovals();
        expect(STATE.requests.length).toBe(0);
    });

    it("EXPIRY STORM: a full gateway with no routable GPU drains entirely through the deadline, once each", () => {
        const infgw = place("infgw");
        STATE.elapsedGameTime = 10;
        seedPending(infgw, 20, 0);

        runGame(8, 0.5); // well past the 6s deadline
        expect(STATE.inference.expired).toBe(20); // exactly once each
        expect(infgw.pending.length).toBe(0);
        flushRemovals();
        expect(STATE.requests.length).toBe(0);
    });

    it("ALL-GPU-WARMING: with every GPU loading, held traffic waits under the grace and terminates post-load", () => {
        const infgw = place("infgw");
        place("power"); // grid headroom for the second GPU
        const g1 = place("gpu"); // both loading for 12s — longer than the 6s deadline
        const g2 = place("gpu");
        connect(infgw, g1);
        connect(infgw, g2);
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        seedPending(infgw, 10, 0);

        runGame(8, 0.5);
        expect(g1.queue.length + g2.queue.length).toBe(0); // never dispatched into the dark
        expect(STATE.inference.expired).toBe(0); // the warmup grace: the clock waited
        expect(infgw.pending.length).toBe(10);

        runGame(12, 0.1); // loads complete at 12s; dispatch, batch, finish
        flushRemovals();
        expect(STATE.inference.expired).toBe(0);
        expect(STATE.requestsProcessed).toBe(10); // TERMINATION — served, not leaked
        expect(STATE.requests.length).toBe(0);
    });

    it("END-TO-END drain: waf → alb → infgw → gpu serves a burst to zero in-flight", () => {
        const waf = place("waf");
        const alb = place("alb");
        const infgw = place("infgw");
        const gpu = warm(place("gpu"));
        connect("internet", waf);
        connect(waf, alb);
        connect(alb, infgw);
        connect(infgw, gpu);
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        for (let t = 0; t < 24; t++) {
            const req = new Request("INFERENCE");
            req.genLength = 1;
            STATE.requests.push(req);
            req.flyTo(waf);
            stepGame(0.1);
        }
        runGame(40);
        flushRemovals();

        expect(STATE.requestsProcessed).toBeGreaterThan(0);
        expect(STATE.requests.length).toBe(0); // NOTHING leaked
        const held = STATE.services.some(
            (s) =>
                s.queue.length > 0 || s.processing.length > 0 ||
                (s.batch && s.batch.length > 0) ||
                (s.pending && s.pending.length > 0)
        );
        expect(held).toBe(false);
    });
});
