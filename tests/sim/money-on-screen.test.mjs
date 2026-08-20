// Two places where the money on screen was not the money that moved.
//
// The finances panel is a double-entry ledger: every dollar in or out books
// itself, and net profit is income.total minus the expense lines. Placement,
// repair, upgrade, upkeep and the serverless per-invocation charge all book.
// The sell refund did not — the one dollar movement outside it — so the money
// counter and the Net Profit line drifted apart by half the purchase price of
// every node ever sold, permanently, while the expense breakdown kept listing
// hardware the player no longer owned.
//
// The other one runs the other way: sandbox ships with upkeep OFF and
// Service.update() charges only inside `if (STATE.upkeepEnabled)`, but the
// HUD line never asked. Every sandbox session showed a running cost in red
// that the simulation does not apply.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, CONFIG, resetWorld, place } from "../helpers/sim-world.mjs";
import { deleteObject } from "../../src/sim/topology.js";

const expenses = () => STATE.finances.expenses;
const totalExpenses = () => {
    const e = expenses();
    return e.services + e.upkeep + e.repairs + (e.autoRepair || 0)
        + (e.mitigation || 0) + (e.breach || 0);
};

describe("the ledger sees every dollar that moves", () => {
    beforeEach(() => resetWorld({ gameMode: "survival" }));

    it("SELLING A NODE books its refund, or Net Profit is wrong forever", () => {
        const before = { money: STATE.money, spent: expenses().services };
        const db = place("db");
        const cost = CONFIG.services.db.cost;
        expect(expenses().services).toBe(before.spent + cost);

        deleteObject(db.id);
        const refund = Math.floor(cost / 2);

        // The money went up by the refund...
        expect(STATE.money).toBe(before.money - cost + refund);
        // ...and the ledger came down by exactly the same amount, so the two
        // numbers on screen still agree.
        expect(expenses().services).toBe(before.spent + cost - refund);
    });

    it("...and the per-service breakdown stops listing hardware you sold", () => {
        const db = place("db");
        expect(expenses().countByService.db).toBe(1);
        deleteObject(db.id);
        expect(expenses().countByService.db).toBe(0);
        expect(expenses().byService.db).toBe(CONFIG.services.db.cost - Math.floor(CONFIG.services.db.cost / 2));
    });

    it("a FREE node sold does not drive the ledger negative", () => {
        // Campaign preBuilt services are placed without the charge, so their
        // refund has no purchase to come off.
        const db = place("db");
        deleteObject(db.id);
        expenses().services = 0;
        expenses().byService.db = 0;
        const db2 = place("db");
        expenses().services = 0;                 // pretend it was free
        expenses().byService.db = 0;
        expenses().countByService.db = 0;
        deleteObject(db2.id);
        expect(expenses().services).toBe(0);
        expect(expenses().byService.db).toBe(0);
        expect(expenses().countByService.db).toBe(0);
        expect(totalExpenses()).toBeGreaterThanOrEqual(0);
    });
});
