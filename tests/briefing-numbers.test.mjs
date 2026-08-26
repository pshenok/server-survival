// A campaign briefing is the player's only statement of what a level is
// about, and it quotes the level's own tuning numbers as prose. Levels get
// retuned; the prose does not follow.
//
// Found on levels 5, 6 and 7, in all eleven locales at once:
//
//   L5  "then 20 requests at once"      burstPattern.burstSize   15
//   L6  "Read-heavy API traffic (45% READ)"   READ               60%
//   L7  "A Search Storm hits — 50% SEARCH"    SEARCH             60%
//
// L6 is the one that costs the player something. Its bonus objective is
// "Replica handles >= 50% of READ", so someone sizing a Read Replica against
// the briefing's 45% under-provisions by a third on the very level that
// grades them on it.
//
// This is drift, not house style: levels 3, 11, 21, 22 and 25 quote their
// mixes exactly. Every machine-checkable claim in the game was checked when
// this was written — twelve of them, all three levels, all eleven locales.
import { describe, expect, it } from "vitest";
import { CAMPAIGN_LEVELS } from "../src/campaign/levels.js";
import { LOCALES, loadLocale } from "./helpers/load-globals.mjs";

const TYPES = ["STATIC", "READ", "WRITE", "UPLOAD", "SEARCH", "MALICIOUS", "INFERENCE"];

// Claims a briefing can make that the config can answer. Both orders, because
// the locales put the number on either side of the type name.
function claimsIn(text) {
    const out = [];
    for (const type of TYPES) {
        // Case-insensitive: level 11 writes "70% malicious traffic" in prose
        // while level 6 shouts "60% READ". Both are claims about the same
        // config field, and a case-sensitive sweep quietly checked only half
        // of them — which is how a guard ends up guarding nothing.
        const re = new RegExp(`(?:(\\d+)\\s*%[^.。]{0,24}?${type})|(?:${type}[^.。]{0,24}?(\\d+)\\s*%)`, "gi");
        for (const m of text.matchAll(re)) {
            out.push({ kind: "share", type, claimed: Number(m[1] ?? m[2]) });
        }
    }
    for (const m of text.matchAll(/(\d+)\s*(?:requests?|запит|запрос|Anfragen|requêtes|richieste|requisições|요청|अनुरोध)/gi)) {
        out.push({ kind: "burst", claimed: Number(m[1]) });
    }
    return out;
}

const levelById = (id) => CAMPAIGN_LEVELS.find((l) => l.id === id);

describe("a briefing quotes the level it introduces", () => {
    // Guard on the guard: if a rewording drops every claim out of reach of
    // the patterns above, this file would pass by finding nothing at all.
    it("the sweep still finds claims to check", async () => {
        const en = await loadLocale(LOCALES.find((l) => l.code === "en"));
        let found = 0;
        for (const level of CAMPAIGN_LEVELS) {
            const text = en[`level_${level.id}_scenario`];
            if (text) found += claimsIn(text).length;
        }
        expect(found, "no briefing quotes a number the config can answer").toBeGreaterThan(5);
    });

    for (const locale of LOCALES) {
        it(`${locale.code}: every quoted share and burst matches the config`, async () => {
            const t = await loadLocale(locale);
            for (const level of CAMPAIGN_LEVELS) {
                const text = t[`level_${level.id}_scenario`];
                if (!text) continue;
                for (const claim of claimsIn(text)) {
                    if (claim.kind === "share") {
                        const real = Math.round((level.trafficDistribution?.[claim.type] ?? 0) * 100);
                        expect(
                            claim.claimed,
                            `${locale.code}/L${level.id}: briefing says ${claim.claimed}% ${claim.type}, the level runs ${real}%`
                        ).toBe(real);
                    } else if (level.burstPattern?.enabled) {
                        expect(
                            claim.claimed,
                            `${locale.code}/L${level.id}: briefing says ${claim.claimed} requests at once, the burst is ${level.burstPattern.burstSize}`
                        ).toBe(level.burstPattern.burstSize);
                    }
                }
            }
        });
    }
});
