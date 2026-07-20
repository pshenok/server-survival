// Locale integrity (#155 PR 1). Guards against the drift we kept finding by
// hand: ru was 49 keys behind for weeks (#182), nep sat orphaned, tip_waf and
// load_failed were referenced in code but defined nowhere — every miss shows
// players a raw key string in the UI.
import { describe, expect, it } from "vitest";
import { LOCALES, loadLocale } from "./helpers/load-globals.mjs";

// Preload every dict with top-level await so the sync describe.each callbacks
// below can look them up.
const DICTS = new Map(
  await Promise.all(LOCALES.map(async (l) => [l.code, await loadLocale(l)]))
);

const en = DICTS.get("en");
const enKeys = Object.keys(en).sort();

const PLACEHOLDER = /\{(\w+)\}/g;
function placeholders(str) {
  return [...String(str).matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

describe.each(LOCALES.filter((l) => l.code !== "en"))(
  "locale $code",
  (locale) => {
    const dict = DICTS.get(locale.code);

    it("has every key that en has (missing keys render as raw key strings)", () => {
      const keys = new Set(Object.keys(dict));
      const missing = enKeys.filter((k) => !keys.has(k));
      expect(missing).toEqual([]);
    });

    it("has no extra keys absent from en (dead weight / typos)", () => {
      const extra = Object.keys(dict).filter((k) => !(k in en));
      expect(extra).toEqual([]);
    });

    it("keeps the same {placeholder} tokens as en for every key", () => {
      const mismatched = enKeys
        .filter((k) => k in dict)
        .filter(
          (k) =>
            placeholders(en[k]).join(",") !== placeholders(dict[k]).join(",")
        )
        .map(
          (k) =>
            `${k}: en has [${placeholders(en[k])}], ${locale.code} has [${placeholders(dict[k])}]`
        );
      expect(mismatched).toEqual([]);
    });
  }
);

describe("en locale", () => {
  it("has no empty values", () => {
    const empty = enKeys.filter((k) => String(en[k]).trim() === "");
    expect(empty).toEqual([]);
  });
});
