// Every i18n key referenced from code/markup must exist in en (#155 PR 1).
// This is the automated version of the audit that found tip_waf and
// load_failed (#182): i18n.t() returns the raw key when it's missing, so an
// undefined key is a guaranteed visible UI bug.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES, loadLocale } from "./helpers/load-globals.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const en = await loadLocale(LOCALES.find((l) => l.code === "en"));

function collectSources() {
  const files = ["game.js", "index.html", "src/tutorial.js"];
  for (const dir of ["src/campaign", "src/core", "src/entities", "src/input", "src/persistence", "src/services", "src/sim", "src/ui"]) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (f.endsWith(".js")) files.push(`${dir}/${f}`);
    }
  }
  return files.map((f) => ({ file: f, src: readFileSync(join(ROOT, f), "utf8") }));
}

// Literal keys only — dynamic keys (i18n.t(prefix + x)) can't be statically
// checked and are exercised by the locale-parity tests instead.
const CALL_RE = /i18n\.t\(\s*['"]([^'"]+)['"]/g;
const ATTR_RE = /data-i18n(?:-title|-placeholder)?=["']([^"']+)["']/g;

describe("i18n key usage", () => {
  it("every statically-referenced key exists in en", () => {
    const missing = [];
    for (const { file, src } of collectSources()) {
      for (const re of [CALL_RE, ATTR_RE]) {
        for (const m of src.matchAll(re)) {
          const key = m[1];
          // A literal ending in "_" is a dynamic prefix (i18n.t('traffic_' + x));
          // require that at least one en key expands it.
          const ok = key.endsWith("_")
            ? Object.keys(en).some((k) => k.startsWith(key))
            : key in en;
          if (!ok) missing.push(`${file}: ${key}`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
