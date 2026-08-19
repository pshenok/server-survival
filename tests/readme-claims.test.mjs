// The README is a spec that nothing enforced.
//
// It states about forty numbers about how this game behaves — what a GPU
// costs to run, when a fleet scales out, what trips a breaker, what a WRITE
// pays. Every one of them is a promise to a player deciding whether to place
// a service, and to a contributor deciding whether a config change is safe.
//
// Nothing checked any of them. A one-character edit to CONFIG could make the
// README false and leave 892 tests green, and the only way anyone would find
// out is by playing the game and being surprised.
//
// The sibling project (datacenter-survival) added the same guard and it
// caught a wrong number within a minute of being written — an incomplete
// README edit made in the same session. That is the value: not that the
// numbers are wrong today (they are all correct, verified when this was
// written), but that the next edit cannot quietly make them wrong.
//
// Each assertion carries the README's own words in its message, so a failure
// tells you which sentence to fix rather than which regex to appease. And a
// sentence that has been REWORDED away fails loudly on the null match rather
// than passing vacuously — the failure mode that makes doc tests worthless.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CONFIG } from "../src/config.js";
import { CAMPAIGN_LEVELS } from "../src/campaign/levels.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const GAME_JS = readFileSync(join(ROOT, "game.js"), "utf8");

// Pull one capture group out of the README, failing with the pattern itself
// when the sentence has moved — never returning undefined into a comparison.
function claim(re, what) {
    const m = README.match(re);
    expect(m, `the README sentence about ${what} moved or lost its numbers`).not.toBeNull();
    return m;
}
const num = (re, what) => Number(claim(re, what)[1]);

describe("the README's numbers are the game's numbers", () => {
    it("counts the campaign it ships", () => {
        const m = claim(/(\d+) hand-crafted levels across (\d+) chapters/, "the campaign size");
        expect(Number(m[1])).toBe(CAMPAIGN_LEVELS.length);
        expect(Number(m[2])).toBe(new Set(CAMPAIGN_LEVELS.map((l) => l.chapter)).size);
    });

    it("counts the services it offers — in both places it says so", () => {
        const real = Object.keys(CONFIG.services).length;
        const claims = [...README.matchAll(/all (\d+) services/g)].map((m) => Number(m[1]));
        expect(claims.length, "the README stopped naming a service count").toBeGreaterThan(0);
        for (const c of claims) expect(c).toBe(real);
    });

    it("describes autoscaling's two thresholds", () => {
        const m = claim(/scale out at (\d+)% utilization and back in at (\d+)%/, "autoscaling");
        expect(Number(m[1]) / 100).toBeCloseTo(CONFIG.autoscaling.targetUtil, 10);
        expect(Number(m[2]) / 100).toBeCloseTo(CONFIG.autoscaling.scaleInUtil, 10);
    });

    it("describes what trips a circuit breaker", () => {
        const pct = num(/breaker \((\d+)% error rate/, "the circuit breaker");
        expect(pct / 100).toBeCloseTo(CONFIG.resilience.tripErrorRate, 10);
    });

    it("describes the power ceiling, which is the AI chapter's whole constraint", () => {
        const m = claim(
            /the grid carries (\d+) kW, every GPU draws (\d+), and a Substation adds (\d+)/,
            "the power budget"
        );
        expect(Number(m[1])).toBe(CONFIG.power.baseCapKw);
        expect(Number(m[2])).toBe(CONFIG.power.gpuDrawKw);
        expect(Number(m[3])).toBe(CONFIG.power.substationKw);
    });

    it("describes the GPU tier by tier — batch, cold start, and answer quality", () => {
        const tiers = CONFIG.services.gpu.tiers;

        const batch = claim(/up to (\d+)\/(\d+)\/(\d+) by tier/, "GPU batch sizes");
        expect(tiers.map((t) => t.batchSize)).toEqual([1, 2, 3].map((i) => Number(batch[i])));

        const load = claim(/loads its model for (\d+)\/(\d+)\/(\d+)s/, "GPU cold starts");
        expect(tiers.map((t) => t.loadTimeSec)).toEqual([1, 2, 3].map((i) => Number(load[i])));

        const risk = claim(/\((\d+)% . (\d+)% . (\d+)% bad-answer risk/, "GPU answer quality");
        expect(tiers.map((t) => t.qualityRisk)).toEqual(
            [1, 2, 3].map((i) => Number(risk[i]) / 100)
        );

        expect(num(/bleeds its \$(\d+)\/min upkeep/, "the GPU's upkeep")).toBe(
            CONFIG.services.gpu.upkeep
        );
        expect(num(/−([\d.]+) reputation per bad answer/, "the bad-answer penalty")).toBe(
            -CONFIG.survival.SCORE_POINTS.QUALITY_RISK_REPUTATION
        );
    });

    it("states the two ways a run ends — including a threshold that lives only in game.js", () => {
        const m = claim(
            /Game Over\*\* if Reputation hits (\d+)% or you go bankrupt \(\$-(\d+)\)/,
            "game over"
        );
        // Neither number is in CONFIG: the loss condition is a literal in the
        // animate loop, so this reads the source. That is the point — a
        // magic number nobody can grep for from CONFIG is exactly the kind
        // the README outlives.
        const cond = GAME_JS.match(/STATE\.reputation <= (\d+) \|\| STATE\.money <= -(\d+)/);
        expect(cond, "the game-over condition in game.js moved or was rewritten").not.toBeNull();
        expect(Number(m[1])).toBe(Number(cond[1]));
        expect(Number(m[2])).toBe(Number(cond[2]));
    });

    it("prices every traffic type exactly as the simulation pays for it", () => {
        // The table is what a player reads before deciding which traffic to
        // chase, so a stale row here is a wrong strategy, not a typo.
        const ROWS = [
            ["Static Request", "STATIC"],
            ["DB Read", "READ"],
            ["DB Write", "WRITE"],
            ["File Upload", "UPLOAD"],
            ["Search Query", "SEARCH"],
            ["Inference", "INFERENCE"],
        ];
        for (const [label, key] of ROWS) {
            const m = claim(
                new RegExp(`\\| ${label}\\s*\\| \\+\\$([\\d.]+)\\s*\\| \\+(\\d+)\\s*\\| \\+([\\d.]+)`),
                `the ${label} row`
            );
            expect(Number(m[1]), `${label} reward`).toBeCloseTo(CONFIG.trafficTypes[key].reward, 10);
            expect(Number(m[2]), `${label} score`).toBe(CONFIG.trafficTypes[key].score);
            expect(Number(m[3]), `${label} reputation`).toBeCloseTo(
                CONFIG.survival.SCORE_POINTS.SUCCESS_REPUTATION,
                10
            );
        }
    });

    it("prices the outcomes that are not a plain success", () => {
        const P = CONFIG.survival.SCORE_POINTS;
        expect(num(/\| Cache Hit\s*\| \+(\d+)% reward/, "the cache bonus") / 100)
            .toBeCloseTo(P.CACHE_HIT_BONUS, 10);
        const blocked = claim(/\| Attack Blocked\s*\| -\$(\d+) \(mitigation\)\s*\| \+(\d+)/, "a blocked attack");
        expect(Number(blocked[1])).toBe(P.MALICIOUS_MITIGATION_COST);
        expect(Number(blocked[2])).toBe(P.MALICIOUS_BLOCKED_SCORE);
        expect(num(/\| Request Failed\s*\|[^|]*\|[^|]*\| -(\d+)/, "a failed request"))
            .toBe(-P.FAIL_REPUTATION);
        expect(num(/\| Req\. Throttled\s*\|[^|]*\|[^|]*\| -([\d.]+)/, "a throttled request"))
            .toBe(-P.THROTTLED_REPUTATION);
        const leaked = claim(/\| Attack Leaked\s*\| -\$(\d+) \(breach\)\s*\|[^|]*\| -(\d+)/, "a leaked attack");
        expect(Number(leaked[1])).toBe(P.MALICIOUS_BREACH_PENALTY);
        expect(Number(leaked[2])).toBe(-P.MALICIOUS_PASSED_REPUTATION);
    });

    it("counts its own test suite — the number that was already stale", () => {
        // This one was wrong when the file was written: the README said 870
        // while main ran 892. Nothing had ever checked it, which is the
        // whole argument for this file.
        //
        // The FILE count is pinned exactly, because it is derivable. The test
        // count is not: 19 `it()` calls in this suite are generated inside
        // loops (per-locale parity checks and the like), so a static count
        // reads 736 for a suite that runs 900-odd. It is asserted as a floor
        // instead — it can never claim FEWER tests than are visibly written —
        // and adding a test file, which is what happens when the suite grows
        // in any real way, forces this sentence to be edited anyway.
        const m = claim(
            /the full Vitest suite \((\d+) test files, (\d+) tests\)/,
            "the size of the test suite"
        );
        const files = readdirSync(join(ROOT, "tests"), { recursive: true })
            .filter((f) => String(f).endsWith(".test.mjs"));
        expect(Number(m[1])).toBe(files.length);

        const staticIts = files
            .map((f) => readFileSync(join(ROOT, "tests", String(f)), "utf8"))
            .join("\n")
            .match(/(^|[^.\w])(it|test)\s*\(/gm) || [];
        expect(Number(m[2]), "the README claims fewer tests than are written")
            .toBeGreaterThanOrEqual(staticIts.length);
    });

    it("describes the two survival cost curves", () => {
        const up = claim(/Costs increase (\d+)x to (\d+)x over (\d+) minutes/, "upkeep scaling");
        const s = CONFIG.survival.upkeepScaling;
        expect(Number(up[1])).toBe(s.baseMultiplier);
        expect(Number(up[2])).toBe(s.maxMultiplier);
        expect(Number(up[3]) * 60).toBe(s.scaleTime);

        expect(num(/Repair Costs:\*\* (\d+)% of service cost/, "manual repair") / 100)
            .toBeCloseTo(CONFIG.survival.degradation.repairCostPercent, 10);
    });
});
