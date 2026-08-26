// A headless proof drives frame() directly, never through the browser's
// animate() loop that scales dt by STATE.timeScale — so nothing here ever
// naturally sets timeScale to what a real "Play" press would. Most of the
// sim never notices: every mechanic here only ever reads the dt it is
// handed, and frame() always hands it a real one.
//
// Five places do NOT work that way — they read STATE.timeScale directly as
// an independent pause signal, because a real paused run needs its clocks to
// stop even though nothing scales their dt for them: circuit-breaker
// recovery, autoscaling, metrics, hints and failure-badges. Any of them
// would freeze forever under a harness that starts a campaign level (which
// runs resetGame(), parking timeScale at 0) and then drives frames without
// ever pressing Play.
//
// Found chasing #276 (L9): every trace showed a tripped circuit breaker
// staying open for the rest of a 60s run with openSince frozen at 0.00,
// which read as "the breaker cannot recover in time" — a plausible-looking
// but WRONG explanation, because the breaker was never actually being asked
// to recover; STATE.timeScale sat at 0 the whole time. Re-measured with this
// fixed, L9's verdict does not change (see #276) — but it could have, and a
// future level's could.
import { describe, it, expect, afterEach } from "vitest";
import { STATE, resetWorld } from "../helpers/sim-world.mjs";
import { recordBreakerFailure } from "../../src/sim/circuit-breaker.js";
import { REAL_RANDOM, frame, placeAt } from "../helpers/campaign-play.mjs";

afterEach(() => {
    Math.random = REAL_RANDOM;
    resetWorld();
});

describe("frame() keeps STATE.timeScale unpaused, so a tripped breaker can recover", () => {
    it("reaches half-open within its own openSec cooldown, from a cold (paused) start", () => {
        resetWorld({ gameMode: "survival" });
        STATE.animationId = 1;
        // The exact state startCampaignLevel's resetGame() leaves behind —
        // simulated directly here so this test does not depend on any one
        // level's tuning to reach a tripped breaker.
        STATE.timeScale = 0;
        const compute = placeAt("compute", 0, 0);

        for (let i = 0; i < 10; i++) recordBreakerFailure(compute);
        expect(compute.breakerState, "tripping itself is event-driven, not time-gated")
            .toBe("open");

        // CONFIG.resilience.openSec is 5; give it a comfortable margin.
        for (let t = 0; t < 8 && compute.breakerState === "open"; t += 0.1) frame(0.1);

        expect(compute.breakerState).toBe("half-open");
    });
});
