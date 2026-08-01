// Chapter 5 — The AI Wave (#87): lesson invariants for levels 21-25. The
// generic schema checks (ids, mix sums, connection ranges, chapter headings)
// ride tests/levels.test.mjs automatically; these pin the ARITHMETIC each
// level's lesson depends on, so a config drive-by cannot silently invert a
// lesson the way #184 shipped an impossible level. Beatability itself was
// proven by headless playthrough through the real startCampaignLevel path —
// the measured outcomes live in each level's comment block (the Chapter 4
// convention).
import { describe, it, expect, beforeEach } from "vitest";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { CampaignObjectives } from "../../src/campaign/objectives.js";
import { STATE, CONFIG, resetWorld, place } from "../helpers/sim-world.mjs";

const level = (id) => CAMPAIGN_LEVELS.find((l) => l.id === id);
const gpuCfg = () => CONFIG.services.gpu;

// The saturated (pipelined) tier-1 throughput ceiling in req/s at the mean
// genLength 1.28 — the same analytic the ai-wave profit harness pins.
const MEAN_GEN = 1.28;
function tier1Ceiling() {
    const g = gpuCfg();
    const batchMs = (g.batchBaseMs + g.batchPerItemMs * g.batchSize) * MEAN_GEN;
    return (g.batchSize * 1000) / batchMs;
}
function tier3Ceiling() {
    const g = gpuCfg();
    const t3 = g.tiers[2];
    const batchMs = (g.batchBaseMs + g.batchPerItemMs * t3.batchSize) * MEAN_GEN;
    return (t3.batchSize * 1000) / batchMs;
}
// Break-even batch fill from the same constants (reward vs upkeep/min).
function breakEvenFill() {
    const g = gpuCfg();
    let lo = 0.01, hi = 1.0;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        const n = mid * g.batchSize;
        const batchMs = (g.batchBaseMs + g.batchPerItemMs * n) * MEAN_GEN;
        const perMin = (n * CONFIG.trafficTypes.INFERENCE.reward * 60000) / batchMs - g.upkeep;
        if (perMin < 0) lo = mid; else hi = mid;
    }
    return lo;
}

beforeEach(() => resetWorld());

describe("chapter 5 shape", () => {
    it("adds exactly levels 21-25, all in chapter 5, after an untouched 1-20", () => {
        expect(CAMPAIGN_LEVELS).toHaveLength(25);
        for (const id of [21, 22, 23, 24, 25]) expect(level(id).chapter).toBe(5);
        expect(CAMPAIGN_LEVELS.filter((l) => l.chapter === 5)).toHaveLength(5);
    });

    it("every chapter 5 level carries an INFERENCE share and a timeout backstop", () => {
        for (const id of [21, 22, 23, 24, 25]) {
            expect(level(id).trafficDistribution.INFERENCE).toBeGreaterThan(0);
            expect(level(id).failConditions.timeoutSec).toBeGreaterThan(0);
        }
    });
});

describe("CampaignObjectives.totalBadAnswers", () => {
    it("sums badAnswers across the GPU fleet and ignores everything else", () => {
        expect(CampaignObjectives.totalBadAnswers(STATE)).toBe(0);
        const g1 = place("gpu");
        place("power");
        const g2 = place("gpu");
        const waf = place("waf");
        g1.badAnswers = 3;
        g2.badAnswers = 4;
        waf.badAnswers = 99; // never counted — not a GPU
        expect(CampaignObjectives.totalBadAnswers(STATE)).toBe(7);
    });
});

describe("level 21 — Hello, GPU", () => {
    const l = () => level(21);

    it("offers only the GPU, and the budget covers GPU + tier 2 from second 0", () => {
        expect(l().allowedServices).toEqual(["gpu"]);
        const upgradePath = gpuCfg().cost + gpuCfg().tiers[1].cost;
        expect(l().budget).toBeGreaterThanOrEqual(upgradePath);
    });

    it("baseline INFERENCE fits a tier-1 GPU — the reload, not the rate, is the lesson", () => {
        const infRate = l().rps * l().trafficDistribution.INFERENCE;
        expect(infRate).toBeLessThan(tier1Ceiling());
    });

    it("pre-builds TWO computes so the surge chokepoint is the GPU, not the compute tier", () => {
        const computes = l().preBuilt.services.filter((s) => s.type === "compute");
        expect(computes).toHaveLength(2);
        expect(l().burstPattern.enabled).toBe(true);
    });

    it("the tier-2 reload cannot be recovered from if taken at the surge (timeout arithmetic)", () => {
        // The mid-surge ignore-run pays cold start (12s) + reload (20s) of
        // −1 rep per unserved INFERENCE; the timeout must land before that
        // hole refills at the ~+0.25/s recovery rate.
        const infRate = l().rps * l().trafficDistribution.INFERENCE;
        const bothHoles = (gpuCfg().loadTimeSec + gpuCfg().tiers[1].loadTimeSec) * infRate;
        const surgeAt = l().burstPattern.intervalSec;
        const recoverySec = bothHoles / 0.25;
        expect(surgeAt + recoverySec).toBeGreaterThan(l().failConditions.timeoutSec);
    });
});

describe("level 22 — Batch or Bleed", () => {
    const l = () => level(22);

    it("sells the trap: budget affords gateway + TWO GPUs, and the prebuilt substation powers them", () => {
        expect(l().allowedServices.sort()).toEqual(["gpu", "infgw"]);
        expect(l().budget).toBeGreaterThanOrEqual(CONFIG.services.infgw.cost + 2 * gpuCfg().cost);
        expect(l().preBuilt.services.some((s) => s.type === "power")).toBe(true);
        const capKw = CONFIG.power.baseCapKw + CONFIG.power.substationKw;
        expect(2 * CONFIG.power.gpuDrawKw).toBeLessThanOrEqual(capKw);
    });

    it("demand straddles break-even: one GPU runs above it, two half-fed GPUs below it", () => {
        const infRate = l().rps * l().trafficDistribution.INFERENCE;
        const oneFill = infRate / tier1Ceiling();
        const be = breakEvenFill();
        expect(oneFill).toBeGreaterThan(be); // one GPU earns
        expect(oneFill).toBeLessThanOrEqual(1); // ...and can actually serve it
        expect(oneFill / 2).toBeLessThan(be); // least-loaded dispatch halves it into the red
    });

    it("the profit floor reads real finances, so the second GPU's purchase latches the miss", () => {
        STATE.finances.income.total = 100;
        STATE.finances.expenses.services = 670; // infgw + two GPUs
        const floor = l().objectives.primary.find((o) => o.id === "profit_floor");
        expect(floor.check(STATE)).toBe(false);
        STATE.finances.expenses.services = 370; // infgw + one GPU
        expect(floor.check(STATE)).toBe(true);
    });
});

describe("level 23 — The Deadline", () => {
    const l = () => level(23);

    it("pre-builds front door + gateway + one GPU + one substation, with INFERENCE bypassing compute", () => {
        const types = l().preBuilt.services.map((s) => s.type);
        for (const t of ["waf", "alb", "compute", "db", "infgw", "gpu", "power"]) {
            expect(types, t).toContain(t);
        }
        // alb → infgw prebuilt: the bursts land on the deadline queue, not on
        // the compute tier — index 1 is the alb, index 4 the gateway.
        expect(l().preBuilt.connections).toContainEqual([1, 4]);
        expect(l().allowedServices).toEqual(["gpu"]);
    });

    it("average demand sits between one and two tier-1 GPUs — capacity is the fix", () => {
        const avgRps = l().rps + l().burstPattern.burstSize / l().burstPattern.intervalSec;
        const infRate = avgRps * l().trafficDistribution.INFERENCE;
        expect(infRate).toBeGreaterThan(tier1Ceiling());
        expect(infRate).toBeLessThan(2 * tier1Ceiling());
        // ...and the prebuilt substation powers exactly those two GPUs.
        const capKw = CONFIG.power.baseCapKw + CONFIG.power.substationKw;
        expect(Math.floor(capKw / CONFIG.power.gpuDrawKw)).toBe(2);
        expect(l().budget).toBeGreaterThanOrEqual(gpuCfg().cost);
    });

    it("the failure-rate leg exists and kills the delete-the-gateway trade (expiries → NO_ROUTEs)", () => {
        const ids = l().objectives.primary.map((o) => o.id);
        expect(ids).toContain("fail_under_12_pct");
        expect(ids).toContain("few_expiries");
        // Trading every expiry for a hard failure still breaches the rate leg.
        STATE.campaign.completedByType = { INFERENCE: 440 };
        STATE.failures.INFERENCE = 60; // 12% of 500
        STATE.inference.expired = 0;
        const rate = l().objectives.primary.find((o) => o.id === "fail_under_12_pct");
        const exp = l().objectives.primary.find((o) => o.id === "few_expiries");
        expect(rate.check(STATE)).toBe(false);
        expect(exp.check(STATE)).toBe(true); // zero expiries buys nothing
    });
});

describe("level 24 — The Power Wall", () => {
    const l = () => level(24);

    it("demand exceeds even a tier-3 single GPU — only a fleet serves it", () => {
        const infRate = l().rps * l().trafficDistribution.INFERENCE;
        expect(infRate).toBeGreaterThan(tier3Ceiling());
        expect(infRate).toBeLessThan(3 * tier1Ceiling());
    });

    it("three GPUs need base + exactly TWO substations, and the budget buys the lot", () => {
        const p = CONFIG.power;
        expect(3 * p.gpuDrawKw).toBeGreaterThan(p.baseCapKw + p.substationKw); // two GPUs' grid is not enough
        expect(3 * p.gpuDrawKw).toBeLessThanOrEqual(p.baseCapKw + 2 * p.substationKw);
        const fullBuild = 2 * CONFIG.services.power.cost + 3 * gpuCfg().cost + CONFIG.services.infgw.cost;
        expect(l().budget).toBeGreaterThanOrEqual(fullBuild);
        expect(l().allowedServices.sort()).toEqual(["gpu", "infgw", "power"]);
    });

    it("the timeout leaves room for a tier-3 experiment (a 30s reload) before the fleet build", () => {
        expect(l().failConditions.timeoutSec).toBeGreaterThanOrEqual(
            4 * gpuCfg().tiers[2].loadTimeSec
        );
    });

    it("the TWO-GPU cheese provably loses: the deficit's rep drain outruns the success gain", () => {
        // The verification panel caught this at rps 7.5: a 1-substation
        // 2×tier-1 build won 7/10 seeds because +0.1 SUCCESS on ~5.95/s
        // served outweighed −1 on the ~0.4/s deficit — rep-sustainable, and
        // the watts lesson optional. Demand must keep the deficit DECISIVE:
        // deficit × |FAIL_REPUTATION| > 2-GPU serve rate × SUCCESS_REPUTATION
        // condemns every 2-GPU build analytically; the headless cheese run
        // at rps 8.5 confirms it live (0/16 wins, rep floor at t≈33-71).
        const infRate = l().rps * l().trafficDistribution.INFERENCE;
        const twoGpuServe = 2 * tier1Ceiling();
        const deficit = infRate - twoGpuServe;
        expect(deficit).toBeGreaterThan(0);
        const sp = CONFIG.survival.SCORE_POINTS;
        expect(deficit * Math.abs(sp.FAIL_REPUTATION)).toBeGreaterThan(
            twoGpuServe * sp.SUCCESS_REPUTATION
        );
    });
});

describe("level 25 — The AI Wave", () => {
    const l = () => level(25);

    it("runs the survival machinery over a forced 12% INFERENCE base", () => {
        expect(l().enableSurvivalShifts).toBe(true);
        expect(l().trafficDistribution.INFERENCE).toBeCloseTo(0.12, 9);
        expect(l().allowedServices).toEqual([]);
    });

    it("pre-builds the outage-redundant serverless stack (every non-waf tier doubled)", () => {
        // The random SERVICE_OUTAGE event disables one non-waf node for 30s;
        // each doubled tier fails over to its wired twin. Serverless (not
        // Compute) because the ×3 traffic-burst event needs its headroom.
        const count = (t) => l().preBuilt.services.filter((s) => s.type === t).length;
        expect(count("serverless")).toBe(2);
        expect(count("alb")).toBe(2);
        expect(count("db")).toBe(2);
        expect(count("s3")).toBe(2);
        expect(count("compute")).toBe(0);
    });

    it("carries the serve-INFERENCE leg — the shift-proof condemnation of a GPU-less board", () => {
        // Classic survival shifts have no INFERENCE key, so the 12% base
        // bleed pauses during every shift and rep alone cannot condemn a
        // no-GPU run inside the timeout; zero INFERENCE served can.
        for (const shift of CONFIG.survival.trafficShift.shifts) {
            if (shift.name === "AI Hype Wave") continue;
            expect(shift.distribution.INFERENCE).toBeUndefined();
        }
        const ids = l().objectives.primary.map((o) => o.id);
        expect(ids).toContain("serve_150_inference");
        expect(ids).toContain("net_profit");
    });

    it("the budget affords the intended AI layer: GPU + tier-2, with slack", () => {
        expect(l().budget).toBeGreaterThanOrEqual(gpuCfg().cost + gpuCfg().tiers[1].cost);
    });
});
