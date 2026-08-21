// The Operator Manual is the game's own help screen, reached from the main
// menu, and it prices every service by hand.
//
// The toolbar badge two clicks away is GENERATED from CONFIG
// (`CONFIG.services[type].cost` in ui/toolbar.js), so it cannot drift. The
// manual's twenty-two rows are hand-written locale strings, so they can — and
// one had: queue_desc_short still said $35 for a Message Queue that costs $45,
// a config line that carries its own history (`cost: 45, // Increased from
// 35`). The stale figure had been translated into all eleven locales.
//
// A 29% error on a node the level-5 briefing tells you to buy on a $180
// budget, on the surface a player consults precisely BECAUSE they are
// budgeting. Two screens contradicting each other, and the wrong one reads
// like documentation.
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { LOCALES, loadLocale } from "./helpers/load-globals.mjs";

// Which service each manual row is about. Written out rather than inferred:
// three keys do not match their service id (fw/lb/storage are the WAF, the
// ALB and S3), and a guess that silently resolves to null is how a row stops
// being checked without anyone noticing.
const ROW_SERVICE = {
    fw: "waf", queue: "sqs", lb: "alb", compute: "compute", db: "db",
    cache: "cache", storage: "s3", apigw: "apigw", nosql: "nosql",
    search: "search", replica: "replica", serverless: "serverless",
    monitor: "monitor", dlq: "dlq", pubsub: "pubsub", auth: "auth",
    scheduler: "scheduler", notify: "notify", container: "container",
    stream: "stream", dns: "dns", warehouse: "warehouse",
};

const rowsOf = (t) => Object.keys(t).filter((k) => k.endsWith("_desc_short"));

describe("the Operator Manual prices what the game charges", () => {
    it("every row maps to a real service — no row quietly stops being checked", async () => {
        const en = await loadLocale(LOCALES.find((l) => l.code === "en"));
        const rows = rowsOf(en);
        expect(rows.length).toBeGreaterThan(20);
        for (const key of rows) {
            const stem = key.replace("_desc_short", "");
            const service = ROW_SERVICE[stem];
            expect(service, `manual row "${key}" has no entry in ROW_SERVICE`).toBeTruthy();
            expect(CONFIG.services[service], `ROW_SERVICE maps ${stem} to a service that does not exist`)
                .toBeTruthy();
        }
        // ...and the map has nothing stale in it either.
        for (const stem of Object.keys(ROW_SERVICE)) {
            expect(rows, `ROW_SERVICE lists ${stem}, which the manual no longer has`)
                .toContain(`${stem}_desc_short`);
        }
    });

    for (const locale of LOCALES) {
        it(`${locale.code}: every price in the manual is the price in CONFIG`, async () => {
            const t = await loadLocale(locale);
            for (const key of rowsOf(t)) {
                const text = t[key];
                const m = /\$(\d+)/.exec(text);
                expect(m, `${locale.code}/${key} lost its price: "${text}"`).not.toBeNull();
                const service = ROW_SERVICE[key.replace("_desc_short", "")];
                expect(
                    Number(m[1]),
                    `${locale.code}/${key} says $${m[1]}, the game charges $${CONFIG.services[service].cost}`
                ).toBe(CONFIG.services[service].cost);
            }
        });
    }
});
