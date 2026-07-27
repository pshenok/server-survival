// Educational failure badges (#156) over the REAL sim. Three things are under
// test, in order of importance:
//
//   1. INERTNESS. The `reason` argument threaded through failRequest /
//      failOrPark / throttleRequest is attribution only. The same topology and
//      the same traffic must produce byte-identical failure counts whether the
//      badges are on or off — see "the reason argument is inert". If that test
//      ever fails, the instrumentation grew a side effect and THE CARDINAL
//      INVARIANT (every request ends in exactly one of finishRequest /
//      failRequest / removeRequest) is no longer provable from the old suite.
//   2. ATTRIBUTION. Every entry in the taxonomy is reached by DRIVING the sim
//      (a WRITE really flown at a Read Replica), never by calling failRequest
//      by hand — otherwise the test proves the constant exists, not that the
//      site passes it.
//   3. RESOURCES. Aggregation, the concurrency cap and disposal: no duplicate
//      sprites, no unbounded growth, and every canvas texture + sprite
//      material disposed on expiry, eviction and clear.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry, spawnRequest } from "../../src/core/actions.js";
import { FAIL_REASONS, SOFT_REASONS } from "../../src/core/failure-reasons.js";
import {
    BADGE_LIFETIME,
    MAX_BADGES,
    areFailureBadgesEnabled,
    clearFailureBadges,
    getFailureBadges,
    setFailureBadgesEnabled,
    tickFailureBadges,
} from "../../src/ui/failure-badges.js";
import { clearAllServices } from "../../src/sim/topology.js";
import { badgeGroup } from "../../game.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { STATE, CONFIG, resetWorld, place, connect, run, step } from "../helpers/sim-world.mjs";

beforeEach(() => {
    resetWorld();
    clearFailureBadges();
    setFailureBadgesEnabled(true);
});

afterEach(() => {
    vi.restoreAllMocks();
    clearFailureBadges();
});

// --------------------------------------------------------------- utilities

// Inject straight at a node, skipping entry routing — the request flies there,
// queues, and is processed by that node's real handler.
function injectTo(service, type = "READ") {
    const req = new Request(type);
    STATE.requests.push(req);
    req.flyTo(service);
    return req;
}

// Pin a node's utilization so its failure roll is deterministic:
// calculateFailChanceBasedOnLoad(1) === 1, so every job it finishes fails.
function setLoad(service, load) {
    Object.defineProperty(service, "totalLoad", {
        get: () => load,
        configurable: true,
    });
}

function reasons() {
    return getFailureBadges().map((b) => b.reason);
}

function badgeFor(reason) {
    return getFailureBadges().find((b) => b.reason === reason);
}

// Run the world until a badge with `reason` appears (or give up). Keeps the
// tests free of hard-coded processing/flight timings.
function runUntilReason(reason, limit = 12, dt = 0.1) {
    for (let i = 0; i < Math.round(limit / dt); i++) {
        if (badgeFor(reason)) return true;
        step(dt);
    }
    return !!badgeFor(reason);
}

// Drive one terminal node with one request and return the reason it produced.
function reasonAt(type, trafficType, wire) {
    const node = place(type);
    if (wire) wire(node);
    injectTo(node, trafficType);
    run(8);
    return reasons();
}

// ------------------------------------------------------- taxonomy coverage

describe("failure taxonomy: every reason is produced by the real sim", () => {
    it("a full queue drops the arrival with 'Queue full'", () => {
        const db = place("db");
        // Park a full backlog on the node. Services are never ticked in this
        // test — only the arriving request is — so the placeholders are never
        // dequeued; all that matters is that queue.length is at the cap.
        const cap = db.config.maxQueueSize || 20;
        while (db.queue.length < cap) db.queue.push({});

        const req = injectTo(db, "READ");
        for (let i = 0; i < 10; i++) req.update(0.1);

        expect(reasons()).toEqual([FAIL_REASONS.QUEUE_FULL]);
        expect(badgeFor(FAIL_REASONS.QUEUE_FULL).key).toBe(
            db.id + "|" + FAIL_REASONS.QUEUE_FULL
        );
    });

    it("the load/health failure roll says 'Overloaded'", () => {
        const compute = place("compute");
        const db = place("db");
        connect(compute, db);
        setLoad(compute, 1); // failChance = 2*(1-0.5) = 1

        injectTo(compute, "READ");
        run(8);

        expect(reasons()).toEqual([FAIL_REASONS.OVERLOADED]);
    });

    it("a backoff whose peer vanished says 'Retry failed'", () => {
        // Two Compute nodes behind one ALB: the shared upstream is what makes
        // the second one a PROVABLE retry peer for the first (see retry.js).
        const alb = place("alb");
        const a = place("compute");
        const b = place("compute");
        connect("internet", alb);
        connect(alb, a);
        connect(alb, b);
        setLoad(a, 1);

        const req = injectTo(a, "READ");
        // Step until the retry is armed, then take the peer away mid-backoff.
        for (let i = 0; i < 100 && !(req.retryDelay > 0); i++) step(0.1);
        expect(req.retryDelay).toBeGreaterThan(0);
        b.isDisabled = true;

        run(3);
        expect(reasons()).toEqual([FAIL_REASONS.RETRY_FAILED]);
        expect(STATE.resilience.retries).toBe(1);
    });

    it("a request that already spent its retry and failed again says 'Retry failed', not 'Overloaded'", () => {
        const alb = place("alb");
        const a = place("compute");
        const b = place("compute");
        connect("internet", alb);
        connect(alb, a);
        connect(alb, b);
        setLoad(a, 1);
        setLoad(b, 1); // the peer is just as sick — the retry lands and dies

        const req = injectTo(a, "READ");
        run(12);

        expect(req.retries).toBe(CONFIG.resilience.maxRetries);
        expect(reasons()).toEqual([FAIL_REASONS.RETRY_FAILED]);
    });

    it("a Compute with nowhere to send its READ says 'No route'", () => {
        expect(reasonAt("compute", "READ")).toEqual([FAIL_REASONS.NO_ROUTE]);
    });

    it("traffic with no entry point at all says 'No route' at the Internet", () => {
        const req = new Request("READ");
        STATE.requests.push(req);
        routeRequestToEntry(req, "READ"); // Internet is wired to nothing

        expect(reasons()).toEqual([FAIL_REASONS.NO_ROUTE]);
        expect(badgeFor(FAIL_REASONS.NO_ROUTE).key).toBe("internet|" + FAIL_REASONS.NO_ROUTE);
    });

    it("a tripped downstream is relabelled 'Circuit open', not 'No route'", () => {
        const compute = place("compute");
        const db = place("db");
        connect(compute, db);
        db.breakerState = "open"; // routing skips it — but the wire IS there

        injectTo(compute, "READ");
        run(8);

        expect(reasons()).toEqual([FAIL_REASONS.CIRCUIT_OPEN]);
    });

    it("a CDN miss with nothing behind it says 'No origin'", () => {
        // UPLOAD is not STATIC, so the cache-hit roll is skipped entirely and
        // the miss path is deterministic.
        expect(reasonAt("cdn", "UPLOAD")).toEqual([FAIL_REASONS.NO_ORIGIN]);
    });

    it("a Pub/Sub topic with no subscriber says 'No subscriber'", () => {
        expect(reasonAt("pubsub", "WRITE")).toEqual([FAIL_REASONS.NO_SUBSCRIBER]);
    });

    it("a Read Replica with no master says 'No master'", () => {
        expect(reasonAt("replica", "READ")).toEqual([FAIL_REASONS.NO_MASTER]);
    });

    it("a WRITE flown at a Read Replica says 'Read-only replica'", () => {
        const db = place("db");
        const replica = place("replica");
        connect(replica, db); // a real master, so this is purely the WRITE rule

        injectTo(replica, "WRITE");
        run(8);

        expect(reasons()).toEqual([FAIL_REASONS.READ_ONLY_REPLICA]);
        expect(EN_TRANSLATIONS[FAIL_REASONS.READ_ONLY_REPLICA]).toBe("Read-only replica");
    });

    it("a READ that reaches the Data Warehouse says it is an analytics store (OLTP vs OLAP)", () => {
        expect(reasonAt("warehouse", "READ")).toEqual([FAIL_REASONS.ANALYTICS_STORE]);
    });

    it("STATIC traffic at the SQL database says 'Wrong store type'", () => {
        expect(reasonAt("db", "STATIC")).toEqual([FAIL_REASONS.WRONG_STORE]);
    });

    it("database traffic at File Storage says 'Wrong store type'", () => {
        expect(reasonAt("s3", "READ")).toEqual([FAIL_REASONS.WRONG_STORE]);
    });

    it("a SEARCH at the NoSQL store says there is no search index", () => {
        expect(reasonAt("nosql", "SEARCH")).toEqual([FAIL_REASONS.NOT_INDEXED]);
    });

    it("a READ at the Search Engine says it serves search only", () => {
        expect(reasonAt("search", "READ")).toEqual([FAIL_REASONS.SEARCH_ONLY]);
    });

    it("MALICIOUS reaching a terminal is a 'Breach!' whatever verdict dropped it", () => {
        // The db handler's own verdict would be WRONG_STORE; failRequest
        // overrides it, matching what updateScore already charges for.
        expect(reasonAt("db", "MALICIOUS")).toEqual([FAIL_REASONS.BREACH]);
        expect(STATE.failures.MALICIOUS).toBe(1);
    });

    it("an over-limit API Gateway says 'Throttled' — a soft, differently coloured fail", () => {
        const gw = place("apigw");
        injectTo(gw, "READ");
        // Hold the node over its rate limit on every frame (and keep its 1 s
        // counter reset from firing) so the throttle branch is deterministic.
        for (let i = 0; i < 60; i++) {
            gw.rateCounter = (gw.config.rateLimit || 20) + 5;
            gw.rateTimer = 0;
            step(0.05);
            if (badgeFor(FAIL_REASONS.THROTTLED)) break;
        }

        expect(reasons()).toEqual([FAIL_REASONS.THROTTLED]);
        expect(SOFT_REASONS.has(FAIL_REASONS.THROTTLED)).toBe(true);
        expect(STATE.failures.READ).toBe(0); // throttling is not a scored failure
    });

    it("a Stream partition head with no consumer says 'Partition stalled' (head-of-line blocking)", () => {
        const stream = place("stream");
        injectTo(stream, "WRITE");
        run(8);

        expect(reasons()).toEqual([FAIL_REASONS.PARTITION_STALLED]);
    });

    it("every taxonomy entry has a real, short English label", () => {
        for (const key of Object.values(FAIL_REASONS)) {
            const label = EN_TRANSLATIONS[key];
            expect(label, `missing en translation for ${key}`).toBeTruthy();
            expect(label).not.toBe(key); // a missing key renders as the key itself
            expect(label.length).toBeLessThanOrEqual(32); // it is a sprite, not a sentence
        }
    });
});

// ------------------------------------------------------------- aggregation

describe("aggregation, cap and lifetime", () => {
    it("the same node failing the same way counts up instead of spawning duplicates", () => {
        const search = place("search");
        for (let i = 0; i < 5; i++) injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);
        run(3);

        const badges = getFailureBadges();
        expect(badges).toHaveLength(1);
        expect(badges[0].count).toBe(5);
        expect(badgeGroup.children).toHaveLength(1); // one sprite, not five
    });

    it("an aggregated hit refreshes the badge's lifetime", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);

        tickFailureBadges(BADGE_LIFETIME * 0.8);
        const aged = badgeFor(FAIL_REASONS.SEARCH_ONLY).life;
        expect(aged).toBeLessThan(BADGE_LIFETIME);

        // A second failure at the same node: it aggregates onto the SAME badge
        // and resets its clock. (tickFailureBadges is not driven by run(), so
        // nothing ages in between.)
        injectTo(search, "READ");
        run(3);
        expect(badgeFor(FAIL_REASONS.SEARCH_ONLY).life).toBe(BADGE_LIFETIME);
        expect(badgeFor(FAIL_REASONS.SEARCH_ONLY).count).toBe(2);
    });

    it("two different reasons at one node get their own badges", () => {
        const nosql = place("nosql");
        injectTo(nosql, "SEARCH"); // NOT_INDEXED
        injectTo(nosql, "STATIC"); // WRONG_STORE
        run(6);

        expect(new Set(reasons())).toEqual(
            new Set([FAIL_REASONS.NOT_INDEXED, FAIL_REASONS.WRONG_STORE])
        );
    });

    it("the same reason at two different nodes gets its own badge each", () => {
        const a = place("search");
        const b = place("search");
        injectTo(a, "READ");
        injectTo(b, "READ");
        run(6);

        const badges = getFailureBadges();
        expect(badges).toHaveLength(2);
        expect(badges.every((x) => x.reason === FAIL_REASONS.SEARCH_ONLY)).toBe(true);
        expect(new Set(badges.map((x) => x.key)).size).toBe(2);
    });

    it("the concurrent badge count is capped, and the evicted oldest is disposed", () => {
        const nodes = [];
        for (let i = 0; i < MAX_BADGES + 3; i++) nodes.push(place("search"));
        for (const n of nodes) injectTo(n, "READ");
        run(6);

        expect(getFailureBadges()).toHaveLength(MAX_BADGES);
        expect(badgeGroup.children).toHaveLength(MAX_BADGES);
        // The survivors are the newest ones — the first nodes were evicted.
        const live = new Set(getFailureBadges().map((b) => b.key.split("|")[0]));
        expect(live.has(nodes[nodes.length - 1].id)).toBe(true);
        expect(live.has(nodes[0].id)).toBe(false);
    });

    it("badges expire after their lifetime and leave the scene graph empty", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);
        expect(badgeGroup.children).toHaveLength(1);

        tickFailureBadges(BADGE_LIFETIME + 0.01);

        expect(getFailureBadges()).toHaveLength(0);
        expect(badgeGroup.children).toHaveLength(0);
    });

    it("expiry disposes the canvas texture and the sprite material (no THREE leak)", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);

        const badge = badgeFor(FAIL_REASONS.SEARCH_ONLY);
        expect(badge.texture.disposed).toBe(false);
        expect(badge.material.disposed).toBe(false);

        tickFailureBadges(BADGE_LIFETIME + 0.01);

        expect(badge.texture.disposed).toBe(true);
        expect(badge.material.disposed).toBe(true);
        expect(badge.sprite.parent).toBe(null);
    });

    it("a heavy cascade never grows the badge collection or the scene group", () => {
        const nodes = [];
        for (let i = 0; i < 6; i++) nodes.push(place("search"));
        for (let wave = 0; wave < 8; wave++) {
            for (const n of nodes) injectTo(n, "READ");
            run(1.5);
            expect(getFailureBadges().length).toBeLessThanOrEqual(MAX_BADGES);
            expect(badgeGroup.children.length).toBe(getFailureBadges().length);
        }

        // Let everything age out: back to a clean scene graph.
        for (let i = 0; i < 40; i++) tickFailureBadges(0.1);
        expect(getFailureBadges()).toHaveLength(0);
        expect(badgeGroup.children).toHaveLength(0);
    });

    it("clearAllServices wipes the badges with the board", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);
        const badge = badgeFor(FAIL_REASONS.SEARCH_ONLY);

        clearAllServices();

        expect(getFailureBadges()).toHaveLength(0);
        expect(badgeGroup.children).toHaveLength(0);
        expect(badge.material.disposed).toBe(true);
        expect(badge.texture.disposed).toBe(true);
    });
});

// -------------------------------------------------------- pause and toggle

describe("freeze on pause", () => {
    it("badges do not age while the game is paused", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);
        const before = badgeFor(FAIL_REASONS.SEARCH_ONLY).life;

        STATE.timeScale = 0;
        for (let i = 0; i < 30; i++) tickFailureBadges(0.1);

        expect(getFailureBadges()).toHaveLength(1);
        expect(badgeFor(FAIL_REASONS.SEARCH_ONLY).life).toBe(before);
    });

    it("they resume ageing — and expire — once the game runs again", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);

        STATE.timeScale = 0;
        tickFailureBadges(5);
        expect(getFailureBadges()).toHaveLength(1);

        STATE.timeScale = 1;
        tickFailureBadges(BADGE_LIFETIME + 0.01);
        expect(getFailureBadges()).toHaveLength(0);
    });
});

describe("the toggle", () => {
    it("is on by default", () => {
        expect(areFailureBadgesEnabled()).toBe(true);
    });

    it("suppresses spawning entirely when off", () => {
        setFailureBadgesEnabled(false);

        const search = place("search");
        for (let i = 0; i < 4; i++) injectTo(search, "READ");
        run(6);

        expect(getFailureBadges()).toHaveLength(0);
        expect(badgeGroup.children).toHaveLength(0);
        expect(STATE.failures.READ).toBe(4); // the failures still happened
    });

    it("clears and disposes the badges already on screen when switched off", () => {
        const search = place("search");
        injectTo(search, "READ");
        runUntilReason(FAIL_REASONS.SEARCH_ONLY);
        const badge = badgeFor(FAIL_REASONS.SEARCH_ONLY);

        setFailureBadgesEnabled(false);

        expect(getFailureBadges()).toHaveLength(0);
        expect(badge.material.disposed).toBe(true);
        expect(badgeGroup.children).toHaveLength(0);
    });

    it("persists the preference like the sound prefs do", () => {
        setFailureBadgesEnabled(false);
        expect(localStorage.getItem("serverSurvivalFailureBadges")).toBe("off");
        setFailureBadgesEnabled(true);
        expect(localStorage.getItem("serverSurvivalFailureBadges")).toBe("on");
    });
});

// ---------------------------------------------------------------- inertness

// A tiny deterministic PRNG so the two runs below see the identical stream of
// rolls (service ids, traffic mix, cache hits and failure rolls all draw from
// Math.random).
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// One fixed, deliberately half-broken session: a Compute with no data store,
// a Search Engine fed the wrong traffic and MALICIOUS in the mix, so every
// branch of the taxonomy fires. Returns everything the game scores.
function playFixedSession(badgesOn) {
    setFailureBadgesEnabled(badgesOn);
    vi.spyOn(Math, "random").mockImplementation(mulberry32(0x5eed));
    resetWorld();

    const alb = place("alb");
    const compute = place("compute");
    const search = place("search");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, search);

    STATE.trafficDistribution = {
        STATIC: 0.2, READ: 0.3, WRITE: 0.2, UPLOAD: 0.1, SEARCH: 0.1, MALICIOUS: 0.1,
    };
    for (let i = 0; i < 120; i++) {
        spawnRequest();
        run(0.2);
    }
    run(10);

    return {
        failures: { ...STATE.failures },
        processed: STATE.requestsProcessed,
        score: STATE.score.total,
        reputation: Math.round(STATE.reputation * 1e6) / 1e6,
        inFlight: STATE.requests.length,
    };
}

describe("the reason argument is inert (regression guard for #156)", () => {
    it("the same session scores identically with badges on and off", () => {
        const withBadges = playFixedSession(true);
        const withoutBadges = playFixedSession(false);

        expect(withBadges).toEqual(withoutBadges);
    });

    it("that session really did exercise the failure paths it is guarding", () => {
        const result = playFixedSession(true);
        const totalFailures = Object.values(result.failures).reduce((a, b) => a + b, 0);

        expect(totalFailures).toBeGreaterThan(0);
        expect(result.failures.MALICIOUS).toBeGreaterThan(0);
        // More than one distinct lesson was taught during the run.
        expect(getFailureBadges().length).toBeGreaterThan(0);
    });

    it("every request still terminates exactly once (THE CARDINAL INVARIANT)", () => {
        playFixedSession(true);
        // failRequest schedules removeRequest on a 500 ms timer, so the only
        // requests left are the ones waiting on it — none are still in flight
        // or sitting in a queue.
        for (const req of STATE.requests) {
            expect(req.failed || req.throttled || req.parked).toBeTruthy();
        }
        expect(STATE.requests.every((r) => !r.isMoving || r.failed)).toBe(true);
    });
});
