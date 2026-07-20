// The game ships as classic global scripts (no modules — see the hard
// constraint in #155: main must stay directly hostable on GitHub Pages).
// To test them in Node we evaluate a file and harvest the globals it
// declares. Replaced by real imports once PR 2 (native ESM) lands.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadScriptGlobals(relPath, context = {}) {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const sandbox = vm.createContext(context);
  // `const X = ...` at script top level is scoped to the vm's evaluation, not
  // attached to the context object — re-declare top-level consts as vars so
  // they land on the sandbox and can be harvested.
  const patched = src.replace(/^const /gm, "var ");
  vm.runInContext(patched, sandbox, { filename: relPath });
  return sandbox;
}

export const LOCALES = [
  { code: "en", file: "src/locales/en.js", global: "EN_TRANSLATIONS" },
  { code: "zh", file: "src/locales/zh.js", global: "ZH_TRANSLATIONS" },
  { code: "pt-BR", file: "src/locales/pt-BR.js", global: "PT_BR_TRANSLATIONS" },
  { code: "de", file: "src/locales/de.js", global: "DE_TRANSLATIONS" },
  { code: "fr", file: "src/locales/fr.js", global: "FR_TRANSLATIONS" },
  { code: "ko", file: "src/locales/ko.js", global: "KO_TRANSLATIONS" },
  { code: "ru", file: "src/locales/ru.js", global: "RU_TRANSLATIONS" },
  { code: "ne", file: "src/locales/nep.js", global: "NE_TRANSLATIONS" },
  { code: "it", file: "src/locales/it.js", global: "IT_TRANSLATIONS" },
];

export function loadLocale({ file, global: g }) {
  return loadScriptGlobals(file)[g];
}
