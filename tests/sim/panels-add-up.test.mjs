// Two panels that printed a number describing something other than what the
// row above it said.
//
// TOTAL SCORE sits directly on top of three rows — Storage, Database, Attacks
// Blocked — and updateScore moved the total on three paths while touching a
// row on only two. The FAILED branch did `score.total -= score/2` with no row
// at all, so adding the rows up gave a different number from the total above
// them, carrying a .5 the integer rows could not explain.
//
// The dead-letter queue's drain cost was booked into expenses.mitigation,
// whose single renderer prints "DDoS Mitigation". A board with a busy DLQ and
// no attack traffic at all grew a DDoS line, and the DLQ's real running cost
// — the thing that makes it a trade rather than a free undo — was invisible.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, CONFIG, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { finishRequest, failRequest } from "../../src/core/actions.js";
import { parkInDLQ, tickDLQ } from "../../src/sim/dlq.js";
import { updateFinancesDisplay } from "../../src/core/economy.js";
import { Request } from "../../src/entities/Request.js";

const rowsSum = () =>
    STATE.score.storage + STATE.score.database + STATE.score.maliciousBlocked
    - (STATE.score.penalties || 0);

describe("the scoreboard adds up", () => {
    beforeEach(() => resetWorld({ gameMode: "survival" }));

    it("THE CONTRADICTION: a failure moved the total and no row", () => {
        const db = place("db");
        for (let i = 0; i < 4; i++) {
            const ok = new Request("READ");
            STATE.requests.push(ok);
            ok.age = 0.1;
            finishRequest(ok, db.type, db);
        }
        expect(rowsSum()).toBe(STATE.score.total);

        for (let i = 0; i < 3; i++) {
            const bad = new Request("READ");
            STATE.requests.push(bad);
            failRequest(bad);
        }
        expect(STATE.score.penalties, "the failures cost something").toBeGreaterThan(0);
        expect(rowsSum(), "the rows no longer add up to the total above them")
            .toBeCloseTo(STATE.score.total, 9);
    });

    it("...and a clean run has nothing to explain", () => {
        const db = place("db");
        const ok = new Request("READ");
        STATE.requests.push(ok);
        ok.age = 0.1;
        finishRequest(ok, db.type, db);
        expect(STATE.score.penalties).toBe(0);
        expect(rowsSum()).toBe(STATE.score.total);
    });
});

describe("the expense panel names what it charged for", () => {
    beforeEach(() => resetWorld({ gameMode: "survival" }));

    it("A DLQ DRAIN IS NOT A DDoS: it bills under its own line", () => {
        const compute = place("compute");
        const dlq = place("dlq");
        connect(compute, dlq);
        for (let i = 0; i < 5; i++) {
            const req = new Request("READ");
            STATE.requests.push(req);
            expect(parkInDLQ(req, compute)).toBe(true);
        }
        for (let t = 0; t < 60 && dlq.parked.length > 0; t++) tickDLQ(dlq, 0.6);
        expect(dlq.parked.length, "the queue really did drain").toBe(0);

        const e = STATE.finances.expenses;
        expect(e.dlq, "the drains cost money").toBeGreaterThan(0);
        expect(e.dlq).toBeCloseTo(5 * CONFIG.services.dlq.drainCost, 6);
        // ...and no attack ever happened on this board.
        expect(e.mitigation || 0, "a DDoS line appeared with no attack traffic").toBe(0);
    });

    it("...and the money still balances: the new line is inside the total", () => {
        // A bucket the expense total forgets is worse than a mislabelled one:
        // net profit would quietly improve every time the DLQ charged.
        const compute = place("compute");
        const dlq = place("dlq");
        connect(compute, dlq);
        const before = STATE.money;
        // Enough drains that the line is worth more than a dollar: the panel
        // floors its total, so a single $0.5 drain would round away and the
        // test would pass with the bucket left out of the sum entirely.
        const drains = Math.ceil(4 / (CONFIG.services.dlq.drainCost || 0.5));
        for (let i = 0; i < drains; i++) {
            const req = new Request("READ");
            STATE.requests.push(req);
            expect(parkInDLQ(req, compute)).toBe(true);
        }
        for (let t = 0; t < 400 && dlq.parked.length > 0; t++) tickDLQ(dlq, 0.6);
        expect(dlq.parked.length).toBe(0);

        const spent = before - STATE.money;
        const e = STATE.finances.expenses;
        expect(e.dlq, "the drain charged something").toBeGreaterThan(0);
        expect(spent).toBeGreaterThan(0);

        // Read the PANEL's own total, not a copy of the sum. Computing it
        // here would pass even if the renderer forgot the new bucket — which
        // is the failure that matters, because net profit is income minus
        // that number, so a forgotten line makes the board look richer every
        // time the DLQ charges.
        updateFinancesDisplay();
        const shown = Number(
            document.getElementById("expense-total").textContent.replace(/[^0-9.]/g, "")
        );
        const withoutDlq = e.services + e.upkeep + e.repairs + (e.autoRepair || 0)
            + (e.mitigation || 0) + (e.breach || 0);
        expect(shown).toBe(Math.floor(withoutDlq + e.dlq));
        expect(shown, "the panel total omits the dead-letter line")
            .toBeGreaterThan(Math.floor(withoutDlq));
    });
});
