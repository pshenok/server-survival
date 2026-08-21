// Demand that got no answer is demand that got no answer.
//
// Two termination paths ended a request without ever reaching the goodput
// denominator: throttleRequest (a 429 from the API Gateway) and tickDLQ's
// drain (an event parked in a dead-letter queue and later dropped). Both are
// deliberately NOT failures — a 429 is load shedding working as designed, and
// the DLQ's whole point is that a failure stops being one — so neither
// belongs in the failures panel, and neither is put there here.
//
// But goodput exists to answer one question: what share of recent demand was
// answered while someone still wanted it. Its own header says why failures
// are in the denominator — "a board that drops everything and serves three
// requests quickly would read 100%" — and shedding is the same hole by a
// politer name.
//
// The two nodes involved are precisely the ones the game teaches you to buy:
// an API Gateway for load shedding, a DLQ so failures stop being failures.
// Build both and the board reported itself perfect while a tenth of its
// traffic got nothing.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { finishRequest, throttleRequest } from "../../src/core/actions.js";
import { getRollingGoodput, metricsTick, resetMetrics } from "../../src/core/metrics.js";
import { parkInDLQ, tickDLQ } from "../../src/sim/dlq.js";
import { Request } from "../../src/entities/Request.js";

const failuresTotal = () => Object.values(STATE.failures).reduce((a, n) => a + n, 0);

function serve(db, n, age = 0.1) {
    for (let i = 0; i < n; i++) {
        const req = new Request("READ");
        STATE.requests.push(req);
        req.age = age;
        finishRequest(req, db.type, db);
    }
}

describe("shed traffic is still demand", () => {
    beforeEach(() => {
        resetWorld({ gameMode: "survival" });
        resetMetrics();
    });

    it("A RATE LIMITER CANNOT MAKE THE BOARD LOOK HEALTHY", () => {
        const db = place("db");
        serve(db, 9);
        for (let i = 0; i < 90; i++) {
            const req = new Request("READ");
            STATE.requests.push(req);
            throttleRequest(req);          // 429 — ninety customers, no answer
        }
        metricsTick(0.5);

        // Nine of ninety-nine were served.
        expect(getRollingGoodput()).toBeCloseTo(9 / 99, 6);
        // ...and a 429 is still not a failure. That distinction is the point
        // of the API Gateway and it survives this change untouched.
        expect(failuresTotal()).toBe(0);
    });

    it("...and neither can a dead-letter queue", () => {
        const db = place("db");
        // parkInDLQ takes the UPSTREAM node and finds the DLQ through its
        // connections, and only compute/serverless/alb/apigw may wire to one.
        const compute = place("compute");
        const dlq = place("dlq");
        connect(compute, dlq);
        serve(db, 4);
        for (let i = 0; i < 16; i++) {
            const req = new Request("READ");
            STATE.requests.push(req);
            expect(parkInDLQ(req, compute), "the request must actually park").toBe(true);
        }
        // Drain the whole queue.
        for (let t = 0; t < 200 && dlq.parked.length > 0; t++) tickDLQ(dlq, 0.6);
        expect(dlq.parked.length, "the queue really did drain").toBe(0);
        metricsTick(0.5);

        expect(getRollingGoodput()).toBeCloseTo(4 / 20, 6);
    });

    it("A BOARD THAT ACTUALLY SERVES ITS TRAFFIC STILL READS 100%", () => {
        // The mirror. Counting shed traffic as unanswered is only honest if
        // an honest board is unaffected — otherwise the fix is just a new lie
        // pointing the other way.
        const db = place("db");
        serve(db, 30);
        metricsTick(0.5);
        expect(getRollingGoodput()).toBe(1);
    });

    it("an idle board still reads nothing at all, not 100%", () => {
        // getRollingGoodput returns null for an empty window on purpose, and
        // adding buckets must not turn "nothing happened" into a score.
        metricsTick(0.5);
        expect(getRollingGoodput()).toBeNull();
    });
});
