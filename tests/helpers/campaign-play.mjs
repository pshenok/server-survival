// Playing a campaign level for real, from a test.
//
// Extracted so proofs stop re-deriving it. The rule these helpers exist to
// keep (the #184 discipline) is that a claim about a level must come from the
// level as shipped: the real `startCampaignLevel` path, player placement
// through `createService` (which is what stamps playerPlaced and charges the
// money), and animate()'s own frame order. Nothing here touches tuning.
import { vi } from "vitest";
import { achievements } from "../../src/achievements/achievements.js";
import { spawnRequest } from "../../src/core/actions.js";
import { createService } from "../../src/sim/topology.js";
import { startCampaignLevel } from "../../src/ui/campaign-ui.js";
import { STATE, resetWorld } from "./sim-world.mjs";

const CAMPAIGN_KEY = "serverSurvivalCampaignProgress";

/** Deterministic PRNG, so a pinned result documents one known line rather than a mood. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const REAL_RANDOM = Math.random;

/**
 * One frame of animate()'s sim-relevant work, in animate()'s order.
 *
 * The timer advance is not decoration. A level's `burstPattern` schedules its
 * spawns on real `setTimeout` (campaign.js stagggers them 20ms apart), so a
 * synchronous loop never sees a single burst: five of the shipped levels
 * declare one and all five played as if they had none. At timeScale 1 the game
 * advances one second of game time per second of wall clock, so advancing fake
 * timers by dt*1000 is exactly what the browser does. Calibrated on L21, whose
 * reference solution wins 3/3 both with timers and without.
 */
export function frame(dt) {
    STATE.elapsedGameTime += dt;
    if (globalThis.window.campaign?.active) globalThis.window.campaign.tick(dt);
    if (vi.isFakeTimers()) vi.advanceTimersByTime(dt * 1000);
    STATE.services.forEach((s) => s.update(dt));
    STATE.requests.slice().forEach((r) => r.update(dt));
    STATE.spawnTimer += dt;
    const rps = STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
    if (rps > 0) {
        const interval = 1 / rps;
        while (STATE.spawnTimer >= interval) {
            STATE.spawnTimer -= interval;
            spawnRequest();
        }
    }
    // animate() clamps every frame, so a proof must too — a raw loop banks
    // reputation above 100 and flatters every run that follows.
    STATE.reputation = Math.min(100, STATE.reputation);
    achievements.tick(dt);
}

/** Player placement through the real path, with the real money checks active. */
export function placeAt(type, x, z) {
    const before = STATE.services.length;
    createService(type, new globalThis.THREE.Vector3(x, 0, z));
    if (STATE.services.length === before) {
        throw new Error(`placement of ${type} failed (money ${Math.round(STATE.money)}?)`);
    }
    return STATE.services[STATE.services.length - 1];
}

export const svc = (type) => STATE.services.find((s) => s.type === type);

/**
 * Starts a level, runs `build`, then plays to the level's own end.
 * Returns what the campaign scored, never a verdict — the caller decides.
 */
export function play(levelId, seed, build, { capSec = 500, dt = 0.1, bursts = true } = {}) {
    resetWorld();
    globalThis.localStorage.setItem(
        CAMPAIGN_KEY,
        JSON.stringify({ version: 1, completed: {}, highestUnlocked: 25 })
    );
    STATE.animationId = 1; // keep resetGame from starting the real rAF loop
    Math.random = mulberry32(seed);
    // Fake timers so the level's own burstPattern actually fires (see frame()).
    if (bursts) vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
        startCampaignLevel(levelId);
        build();
        for (let t = 0; t < capSec && !STATE.campaign.ended; t += dt) frame(dt);
        return {
            level: levelId,
            seed,
            outcome: STATE.campaign.outcome,
            elapsed: STATE.elapsedGameTime,
            stars:
                STATE.campaign.outcome === "win"
                    ? globalThis.window.campaign._calculateStars()
                    : 0,
            bonuses: { ...STATE.campaign.bonusResults },
            failures: Object.values(STATE.failures).reduce((a, b) => a + b, 0),
            reputation: STATE.reputation,
            speedBar: STATE.campaign.level.durationSec * 0.8,
        };
    } finally {
        if (bursts) vi.useRealTimers();
        Math.random = REAL_RANDOM;
    }
}
