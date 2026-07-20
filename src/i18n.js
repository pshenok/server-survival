import { EN_TRANSLATIONS } from "./locales/en.js";
import { ZH_TRANSLATIONS } from "./locales/zh.js";
import { PT_BR_TRANSLATIONS } from "./locales/pt-BR.js";
import { DE_TRANSLATIONS } from "./locales/de.js";
import { FR_TRANSLATIONS } from "./locales/fr.js";
import { KO_TRANSLATIONS } from "./locales/ko.js";
import { RU_TRANSLATIONS } from "./locales/ru.js";
import { IT_TRANSLATIONS } from "./locales/it.js";
import { NE_TRANSLATIONS } from "./locales/nep.js";

/**
 * Simple i18n manager for the game
 */
export class I18nManager {
    constructor() {
        this.currentLocale = localStorage.getItem('game_locale') || 'en';
        this.translations = {
            en: typeof EN_TRANSLATIONS !== 'undefined' ? EN_TRANSLATIONS : {},
            zh: typeof ZH_TRANSLATIONS !== 'undefined' ? ZH_TRANSLATIONS : {},
            'pt-BR': typeof PT_BR_TRANSLATIONS !== 'undefined' ? PT_BR_TRANSLATIONS : {},
            de: typeof DE_TRANSLATIONS !== 'undefined' ? DE_TRANSLATIONS : {},
            fr: typeof FR_TRANSLATIONS !== 'undefined' ? FR_TRANSLATIONS : {},
            ko: typeof KO_TRANSLATIONS !== 'undefined' ? KO_TRANSLATIONS : {},
            ru: typeof RU_TRANSLATIONS !== 'undefined' ? RU_TRANSLATIONS : {},
            it: typeof IT_TRANSLATIONS !== 'undefined' ? IT_TRANSLATIONS : {},
            ne: typeof NE_TRANSLATIONS !== 'undefined' ? NE_TRANSLATIONS : {}
        };
    }

    setLocale(locale) {
        console.log(locale);
        console.log(this.translations);
        if (this.translations[locale]) {
            this.currentLocale = locale;
            localStorage.setItem('game_locale', locale);
            this.applyTranslations();
            // Dispatch event for components that need to update manually
            window.dispatchEvent(new CustomEvent('localeChanged', { detail: locale }));
        }
    }

    t(key, variables = {}) {
        let text = this.translations[this.currentLocale][key] || key;
        
        // Handle variable interpolation
        Object.keys(variables).forEach(varName => {
            text = text.replace(`{${varName}}`, variables[varName]);
        });
        
        return text;
    }

    applyTranslations() {
        // Update all elements with data-i18n attribute
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = this.t(key);
            
            // Handle special cases like placeholder
            if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) {
                el.placeholder = translation;
            } else {
                // For other elements, update innerHTML or textContent
                // If it contains HTML tags (like <b>), use innerHTML
                if (translation.includes('<')) {
                    el.innerHTML = translation;
                } else {
                    el.textContent = translation;
                }
            }
        });

        // Update all elements with data-i18n-title attribute
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const titleKey = el.getAttribute('data-i18n-title');
            el.setAttribute('title', this.t(titleKey));
        });

        // Update document title
        document.title = this.t('title');

        // Update language select if it exists
        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
            langSelect.value = this.currentLocale;
        }
    }
}

// Create a global instance (kept on window: index.html inline handlers call
// i18n.setLocale(...), which resolves via the global scope)
export const i18n = new I18nManager();
window.i18n = i18n;

// Function to easily translate strings in JS
window.t = (key, variables) => window.i18n.t(key, variables);

// Auto-apply on load
document.addEventListener('DOMContentLoaded', () => {
    window.i18n.applyTranslations();
});
