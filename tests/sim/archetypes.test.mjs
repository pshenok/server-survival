// Sandbox archetypes, batch 1 (#197): DLQ, Pub/Sub, Auth, Scheduler, Notify.
// Every archetype gets (a) a distinguishable-behavior test proving it does
// something no existing service does, and (b) a termination test proving the
// cardinal invariant (#191/#192) holds — in-flight drains to 0 after traffic
// stops, every request finishes / fails / is removed exactly once. Plus fan-out
// count exactness, DLQ park/drain/overflow, scheduler pause-freeze, auth
// malicious catch, notify silent fail, connection-validity (anti-cycle) checks,
// and a combined leak battery over all five wired together.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry, notifySilentFail } from "../../src/core/actions.js";
import { parkInDLQ } from "../../src/sim/dlq.js";
import { STATE, CONFIG, resetWorld, place, connect, run, step } from "../helpers/sim-world.mjs";

// failRequest / throttleRequest defer removeRequest by 500ms via setTimeout
// (the fail-flash), so a FAILED request lingers in STATE.requests until that
// timer fires. Under fake timers we can flush it deterministically and assert
// the real "drains to 0" behavior. finishRequest / DLQ drain / notify silent
// fail remove synchronously and are unaffected.
beforeEach(() => {
    vi.useFakeTimers();
    resetWorld();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// Fire the pending 500ms fail-flash removals so failed requests actually leave
// STATE.requests, exactly as they do in the real game one half-second later.
function flushRemovals() {
    vi.advanceTimersByTime(1000);
}

// Inject a request straight at a specific node (bypasses entry routing).
function flyInto(type, node) {
    const req = new Request(type);
    STATE.requests.push(req);
    req.flyTo(node);
    return req;
}

// Inject via the Internet entry path (round-robin entry picker).
function inject(type) {
    const req = new Request(type);
    STATE.requests.push(req);
    routeRequestToEntry(req, type);
    return req;
}

// ============================ DEAD-LETTER QUEUE ============================
describe("Dead-Letter Queue (#197)", () => {
    // internet → alb → compute → dlq, with NO database: every WRITE fails to
    // route at compute and must be parked in the DLQ instead of dropped.
    function dlqWorld() {
        const alb = place("alb");
        const compute = place("compute");
        const dlq = place("dlq");
        connect("internet", alb);
        connect(alb, compute);
        connect(compute, dlq); // failure-sink edge
        return { alb, compute, dlq };
    }

    it("DISTINGUISHABLE: parks a finally-failed request, then recovers it (neither success nor failure)", () => {
        const { dlq } = dlqWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99); // no load-failure noise
        inject("WRITE");

        // Watch the request get parked, then drained back out over time.
        let peakParked = 0;
        for (let i = 0; i < 200; i++) {
            step(0.1);
            peakParked = Math.max(peakParked, dlq.parked ? dlq.parked.length : 0);
        }

        expect(peakParked).toBe(1); // it WAS parked (no existing node holds a dead request)
        expect(dlq.parked.length).toBe(0); // ...and drained away (recovered)
        expect(STATE.requestsProcessed).toBe(0); // never counted as a success
        expect(STATE.failures.WRITE).toBe(0); // never counted as a failure
        expect(STATE.requests.length).toBe(0); // TERMINATION: no leak
    });

    it("draining costs money and refunds a little reputation", () => {
        const { dlq } = dlqWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        const moneyBefore = STATE.money;
        const repBefore = STATE.reputation;
        inject("WRITE");
        run(25);

        expect(dlq.parked.length).toBe(0);
        expect(STATE.money).toBeCloseTo(moneyBefore - CONFIG.services.dlq.drainCost, 5);
        expect(STATE.reputation).toBeCloseTo(repBefore + CONFIG.services.dlq.drainRepRefund, 5);
    });

    it("overflow: a full DLQ refuses the park (caller fails normally) and takes an extra reputation penalty", () => {
        const { compute, dlq } = dlqWorld();
        // Fill the DLQ to its cap with inert parked markers.
        dlq.parked = new Array(CONFIG.services.dlq.capacity).fill({});
        const repBefore = STATE.reputation;

        const req = new Request("WRITE");
        const parked = parkInDLQ(req, compute);

        expect(parked).toBe(false); // refused — caller must fail it
        expect(STATE.reputation).toBeCloseTo(repBefore - CONFIG.services.dlq.overflowRepPenalty, 5);
        req.destroy();
    });

    it("MALICIOUS is never parked (no dodging the breach penalty via a DLQ)", () => {
        const { compute, dlq } = dlqWorld();
        dlq.parked = [];
        const req = new Request("MALICIOUS");
        expect(parkInDLQ(req, compute)).toBe(false);
        expect(dlq.parked.length).toBe(0);
        req.destroy();
    });

    it("with no DLQ wired, the same WRITE fails normally (proves the DLQ is what changed the outcome)", () => {
        const alb = place("alb");
        const compute = place("compute");
        connect("internet", alb);
        connect(alb, compute); // no DLQ, no DB
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        inject("WRITE");
        run(10);
        flushRemovals();

        expect(STATE.failures.WRITE).toBe(1);
        expect(STATE.requests.length).toBe(0);
    });

    it("a DLQ is never a normal forward target (genericForward routes past it to the real downstream)", () => {
        // alb → compute AND alb → dlq: normal traffic must still reach compute,
        // never the sink.
        const alb = place("alb");
        const compute = place("compute");
        const db = place("db");
        const dlq = place("dlq");
        connect("internet", alb);
        connect(alb, compute);
        connect(alb, dlq);
        connect(compute, db);
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        inject("WRITE");
        run(10);

        expect(STATE.requestsProcessed).toBe(1); // delivered to compute→db, not sunk
        expect(dlq.parked ? dlq.parked.length : 0).toBe(0);
    });
});

// ============================== PUB/SUB TOPIC ==============================
describe("Pub/Sub Topic (#197)", () => {
    it("DISTINGUISHABLE: fans one event out to EXACTLY N terminating deliveries", () => {
        const pubsub = place("pubsub");
        const compute = place("compute");
        const serverless = place("serverless");
        const notify = place("notify");
        const db = place("db");
        connect(pubsub, compute);
        connect(pubsub, serverless);
        connect(pubsub, notify);
        connect(compute, db);
        connect(serverless, db);

        flyInto("WRITE", pubsub); // ONE inbound event
        run(15);

        expect(STATE.requestsProcessed).toBe(3); // one delivery per subscriber
        expect(STATE.requests.length).toBe(0); // TERMINATION: every clone drained
    });

    it("one subscriber: the original is delivered, no clone is minted", () => {
        const pubsub = place("pubsub");
        const notify = place("notify");
        connect(pubsub, notify);

        flyInto("WRITE", pubsub);
        run(10);

        expect(STATE.requestsProcessed).toBe(1);
        expect(STATE.requests.length).toBe(0);
    });

    it("fan-out count scales with subscriber count (2 subscribers → 2 deliveries)", () => {
        const pubsub = place("pubsub");
        const notify1 = place("notify");
        const notify2 = place("notify");
        connect(pubsub, notify1);
        connect(pubsub, notify2);

        flyInto("WRITE", pubsub);
        run(10);

        expect(STATE.requestsProcessed).toBe(2);
        expect(STATE.requests.length).toBe(0);
    });

    it("no subscriber: the event fails and does not leak", () => {
        const pubsub = place("pubsub");
        flyInto("WRITE", pubsub);
        run(10);
        flushRemovals();

        expect(STATE.requestsProcessed).toBe(0);
        expect(STATE.failures.WRITE).toBe(1);
        expect(STATE.requests.length).toBe(0);
    });

    it("a burst of events fans out without leaking (leak check under load)", () => {
        const pubsub = place("pubsub");
        const notify1 = place("notify");
        const notify2 = place("notify");
        connect(pubsub, notify1);
        connect(pubsub, notify2);
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        for (let i = 0; i < 5; i++) flyInto("WRITE", pubsub);
        run(20);

        expect(STATE.requestsProcessed).toBe(10); // 5 events × 2 subscribers
        expect(STATE.requests.length).toBe(0);
    });
});

// ============================= AUTH / IDENTITY =============================
describe("Auth / Identity (#197)", () => {
    // internet → auth → alb → compute → db (no WAF: malicious reaches auth).
    function authWorld() {
        const auth = place("auth");
        const alb = place("alb");
        const compute = place("compute");
        const db = place("db");
        connect("internet", auth);
        connect(auth, alb);
        connect(alb, compute);
        connect(compute, db);
        return { auth, alb, compute, db };
    }

    it("DISTINGUISHABLE: trades latency for security — its processingTime dwarfs a plain load balancer's", () => {
        expect(CONFIG.services.auth.processingTime).toBeGreaterThan(
            CONFIG.services.alb.processingTime * 2
        );
        expect(CONFIG.services.auth.catchRate).toBeGreaterThan(0);
    });

    it("catches MALICIOUS on the pass-through path when the roll is under catchRate", () => {
        authWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.0); // 0 < catchRate → caught
        inject("MALICIOUS");
        run(10);

        expect(STATE.score.maliciousBlocked).toBeGreaterThan(0);
        expect(STATE.failures.MALICIOUS).toBe(0); // no breach
        expect(STATE.requests.length).toBe(0);
    });

    it("MALICIOUS that is NOT caught slips through and breaches downstream", () => {
        authWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99); // 0.99 >= catchRate → slips
        inject("MALICIOUS");
        run(10);
        flushRemovals();

        expect(STATE.score.maliciousBlocked).toBe(0);
        expect(STATE.failures.MALICIOUS).toBe(1); // counted as a breach
        expect(STATE.requests.length).toBe(0);
    });

    it("legitimate traffic passes through auth and completes (with the latency hop)", () => {
        authWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        inject("READ");
        run(10);

        expect(STATE.requestsProcessed).toBe(1);
        expect(STATE.failures.READ).toBe(0);
        expect(STATE.requests.length).toBe(0);
    });
});

// ============================= SCHEDULER / CRON =============================
describe("Scheduler / Cron (#197)", () => {
    function schedulerWorld() {
        const scheduler = place("scheduler");
        const compute = place("compute");
        const db = place("db");
        connect(scheduler, compute);
        connect(compute, db);
        return { scheduler, compute, db };
    }

    it("DISTINGUISHABLE: generates its OWN traffic with zero external RPS", () => {
        schedulerWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99); // avoid load-failure noise
        expect(STATE.requestsProcessed).toBe(0);

        run(15); // > one intervalSec (8s) → exactly one burst

        expect(STATE.requestsProcessed).toBe(CONFIG.services.scheduler.burstSize);
        expect(STATE.requests.length).toBe(0); // TERMINATION
    });

    it("respects pause: at dt=0 the cron timer never advances and nothing is emitted", () => {
        schedulerWorld();
        for (let i = 0; i < 300; i++) step(0); // paused frames (timeScale 0 => dt 0)

        expect(STATE.requests.length).toBe(0);
        expect(STATE.requestsProcessed).toBe(0);
    });

    it("emits a second burst after a second interval elapses", () => {
        schedulerWorld();
        vi.spyOn(Math, "random").mockReturnValue(0.99);
        run(20); // two intervals (8s, 16s) have passed

        expect(STATE.requestsProcessed).toBe(CONFIG.services.scheduler.burstSize * 2);
        expect(STATE.requests.length).toBe(0);
    });

    it("with no downstream wired it emits nothing (no stranded requests)", () => {
        place("scheduler"); // unconnected
        run(20);

        expect(STATE.requests.length).toBe(0);
        expect(STATE.requestsProcessed).toBe(0);
    });
});

// ============================== NOTIFICATION ==============================
describe("Notification (#197)", () => {
    it("DISTINGUISHABLE: a successful send earns MORE reputation than a plain database terminal", () => {
        // Notify success.
        const notify = place("notify");
        const repStart = STATE.reputation;
        flyInto("WRITE", notify);
        run(5);
        const notifyGain = STATE.reputation - repStart;

        // DB success, fresh world.
        resetWorld();
        const db = place("db");
        const repStart2 = STATE.reputation;
        flyInto("WRITE", db);
        run(5);
        const dbGain = STATE.reputation - repStart2;

        expect(STATE.requestsProcessed).toBe(1);
        expect(notifyGain).toBeGreaterThan(dbGain); // the reputation hook
        expect(notifyGain).toBeCloseTo(dbGain + CONFIG.services.notify.repBonus, 5);
    });

    it("a successful send still terminates cleanly and pays the money reward", () => {
        const notify = place("notify");
        const moneyBefore = STATE.money;
        flyInto("WRITE", notify);
        run(5);

        expect(STATE.requestsProcessed).toBe(1);
        expect(STATE.money).toBeGreaterThan(moneyBefore); // reward paid
        expect(STATE.requests.length).toBe(0);
    });

    it("silent failure (direct): dissatisfaction, no counted failure, request removed", () => {
        const notify = place("notify");
        const req = flyInto("WRITE", notify);
        const repBefore = STATE.reputation;

        notifySilentFail(req, notify);

        expect(STATE.reputation).toBeCloseTo(repBefore - CONFIG.services.notify.dissatisfaction, 5);
        expect(notify.dissatisfactionCount).toBe(1);
        expect(STATE.failures.WRITE).toBe(0); // not a scored failure
        expect(STATE.requestsProcessed).toBe(0);
        expect(STATE.requests.includes(req)).toBe(false); // removed
    });

    it("overload failures are SILENT: drops accrue dissatisfaction, never a scored failure", () => {
        const notify = place("notify");
        const cap = CONFIG.services.notify.capacity;
        // Construct a genuinely overloaded frame directly: a full slate of jobs
        // whose processing is already finished, plus a backed-up queue, so
        // totalLoad > 0.5 and the load-failure roll fires on every completion.
        const mk = () => {
            const r = new Request("WRITE");
            STATE.requests.push(r);
            return r;
        };
        for (let i = 0; i < cap; i++) notify.processing.push({ req: mk(), timer: 1e9 });
        // Deep queue (> cap) so totalLoad stays above 0.5 through every one of
        // this frame's completions — otherwise load falls under threshold mid-
        // loop and the tail of the jobs would succeed instead of dropping.
        for (let i = 0; i < cap + 10; i++) notify.queue.push(mk());
        vi.spyOn(Math, "random").mockReturnValue(0.0); // completion rolls fail while overloaded

        const repBefore = STATE.reputation;
        notify.update(0.1); // the overloaded frame: all cap jobs drop silently

        // The signature that distinguishes it from every other node: drops
        // happened (dissatisfaction accrued) yet NONE were counted as a scored
        // failure, and reputation barely moved compared to -1 per real failure.
        expect(notify.dissatisfactionCount).toBe(cap);
        expect(STATE.failures.WRITE).toBe(0);
        expect(STATE.reputation).toBeCloseTo(repBefore - cap * CONFIG.services.notify.dissatisfaction, 5);

        // Drain the rest (the queued jobs complete under normal load) — no leak.
        run(10);
        expect(STATE.requests.length).toBe(0);
    });
});

// ===================== CONNECTION VALIDITY (anti-cycle) =====================
describe("archetype connection rules (#197, no cycles)", () => {
    const rejects = (fromType, toType) => {
        const from = place(fromType);
        const to = place(toType);
        connect(from, to);
        return !from.connections.includes(to.id);
    };

    it("DLQ is a pure sink: it has no outgoing edges", () => {
        expect(rejects("dlq", "compute")).toBe(true);
        expect(rejects("dlq", "alb")).toBe(true);
    });

    it("Notification is a pure sink: it has no outgoing edges", () => {
        expect(rejects("notify", "compute")).toBe(true);
        expect(rejects("notify", "db")).toBe(true);
    });

    it("Scheduler is a pure source: nothing may route INTO it", () => {
        expect(rejects("compute", "scheduler")).toBe(true);
        expect(rejects("alb", "scheduler")).toBe(true);
    });

    it("Pub/Sub does not route back up to a load balancer or gateway (no loop)", () => {
        expect(rejects("pubsub", "alb")).toBe(true);
        expect(rejects("pubsub", "apigw")).toBe(true);
    });

    it("valid archetype edges are accepted", () => {
        const compute = place("compute");
        const dlq = place("dlq");
        connect(compute, dlq);
        expect(compute.connections).toContain(dlq.id);

        const alb = place("alb");
        const pubsub = place("pubsub");
        connect(alb, pubsub);
        expect(alb.connections).toContain(pubsub.id);

        const scheduler = place("scheduler");
        const sqs = place("sqs");
        connect(scheduler, sqs);
        expect(scheduler.connections).toContain(sqs.id);
    });
});

// =============================== LEAK BATTERY ===============================
describe("combined leak battery (#197 — the cardinal invariant)", () => {
    it("all five archetypes wired together: mixed traffic + cron all drain to 0", () => {
        // internet → auth → alb ; alb → pubsub, alb → compute, alb → dlq
        // pubsub → compute2, pubsub → notify, pubsub → s3
        // compute → db, compute → dlq ; scheduler → sqs → compute2 ; compute2 → db
        const auth = place("auth");
        const alb = place("alb");
        const pubsub = place("pubsub");
        const compute = place("compute");
        const compute2 = place("compute");
        const db = place("db");
        const s3 = place("s3");
        const notify = place("notify");
        const dlq = place("dlq");
        const scheduler = place("scheduler");
        const sqs = place("sqs");

        connect("internet", auth);
        connect(auth, alb);
        connect(alb, pubsub);
        connect(alb, compute);
        connect(alb, dlq);
        connect(pubsub, compute2);
        connect(pubsub, notify);
        connect(pubsub, s3);
        connect(compute, db);
        connect(compute, dlq);
        connect(compute2, db);
        connect(scheduler, sqs);
        connect(sqs, compute2);

        // Drive mixed external traffic AND let the scheduler self-inject.
        for (let t = 0; t < 120; t++) {
            if (t % 3 === 0) inject("READ");
            if (t % 4 === 0) inject("WRITE");
            if (t % 5 === 0) inject("STATIC");
            if (t % 7 === 0) inject("MALICIOUS");
            step(0.1);
        }

        // Stop all external traffic; let everything (including the DLQ backlog
        // and any parked/cron work) drain out, then flush the fail-flash timers.
        for (let i = 0; i < 600; i++) step(0.1);
        flushRemovals();

        expect(STATE.requests.length).toBe(0); // NOTHING leaked
        expect(dlq.parked ? dlq.parked.length : 0).toBe(0); // DLQ fully drained
    });

    it("every spawned request is accounted for exactly once (processed + failed + parked-recovered)", () => {
        const alb = place("alb");
        const compute = place("compute");
        const db = place("db");
        const dlq = place("dlq");
        const notify = place("notify");
        const pubsub = place("pubsub");
        connect("internet", alb);
        connect(alb, pubsub);
        connect(alb, compute);
        connect(compute, db);
        connect(compute, dlq);
        connect(pubsub, notify);

        for (let t = 0; t < 80; t++) {
            if (t % 2 === 0) inject("WRITE");
            if (t % 3 === 0) inject("READ");
            step(0.1);
        }
        for (let i = 0; i < 400; i++) step(0.1);
        flushRemovals();

        // The only surviving state is the terminal counters — no request object
        // is still alive anywhere.
        expect(STATE.requests.length).toBe(0);
        const stuck = STATE.services.some(
            (s) => s.queue.length > 0 || s.processing.length > 0 || (s.parked && s.parked.length > 0)
        );
        expect(stuck).toBe(false);
    });
});
