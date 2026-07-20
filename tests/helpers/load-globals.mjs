// The game is native ESM (#155 PR 2) — tests load the real modules with
// dynamic import instead of the old vm-eval global-harvesting hack.
export const LOCALES = [
  { code: "en", load: async () => (await import("../../src/locales/en.js")).EN_TRANSLATIONS },
  { code: "zh", load: async () => (await import("../../src/locales/zh.js")).ZH_TRANSLATIONS },
  { code: "pt-BR", load: async () => (await import("../../src/locales/pt-BR.js")).PT_BR_TRANSLATIONS },
  { code: "de", load: async () => (await import("../../src/locales/de.js")).DE_TRANSLATIONS },
  { code: "fr", load: async () => (await import("../../src/locales/fr.js")).FR_TRANSLATIONS },
  { code: "ko", load: async () => (await import("../../src/locales/ko.js")).KO_TRANSLATIONS },
  { code: "ru", load: async () => (await import("../../src/locales/ru.js")).RU_TRANSLATIONS },
  { code: "ne", load: async () => (await import("../../src/locales/nep.js")).NE_TRANSLATIONS },
  { code: "it", load: async () => (await import("../../src/locales/it.js")).IT_TRANSLATIONS },
];

export function loadLocale(locale) {
  return locale.load();
}
