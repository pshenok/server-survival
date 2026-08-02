// Ukrainian locale (#230): full key parity with EN, enforced — a future
// string added to en.js without a translation turns this suite red instead
// of shipping raw keys to UK players. Placeholder parity guards the
// interpolation contract ({time}, {kw}, …) per key.
import { describe, it, expect } from "vitest";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { UK_TRANSLATIONS } from "../../src/locales/uk.js";

const placeholders = (s) => (s.match(/\{[a-zA-Z_]+\}/g) || []).sort();

describe("uk locale", () => {
    it("carries the exact EN key set", () => {
        expect(Object.keys(UK_TRANSLATIONS).sort()).toEqual(Object.keys(EN_TRANSLATIONS).sort());
    });

    it("keeps every interpolation placeholder verbatim", () => {
        for (const [k, en] of Object.entries(EN_TRANSLATIONS)) {
            expect(placeholders(UK_TRANSLATIONS[k]), k).toEqual(placeholders(en));
        }
    });

    it("has no empty or whitespace-only strings", () => {
        for (const [k, v] of Object.entries(UK_TRANSLATIONS)) {
            expect(v.trim().length, k).toBeGreaterThan(0);
        }
    });
});
