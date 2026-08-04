// Achievements UI (#158): the unlock toast queue and the Trophies panel.
// Celebration chrome, NOT the intervention-warning chrome — achievements are
// a reward, warnings are an alarm. Reuses the house glass-panel style and a
// vector SVG trophy (no emoji, per the house icon rule).
//
// All timers here are COSMETIC (display pacing only) and therefore use
// setTimeout like the existing warning UI — no unlock decision ever runs
// through this module. The 3s session quiet window is read from the engine
// (msUntilToastsAllowed) and only delays display.

import { i18n } from "../i18n.js";
import { ACHIEVEMENT_DEFS } from "./definitions.js";
// Runtime-only cycle (ui.js ⇄ achievements.js) — established pattern: the
// engine object is only dereferenced when a toast/panel actually renders.
import { achievements } from "./achievements.js";

const TOAST_VISIBLE_MS = 4000;
const TOAST_FADE_MS = 350;

const TIER_COLORS = {
    bronze: "text-amber-600",
    silver: "text-slate-300",
    gold: "text-yellow-400",
};

function trophySVG(extraClass) {
    return `<svg class="w-8 h-8 ${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 21h8" />
        <path d="M12 17v4" />
        <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
        <path d="M7 6H4a1 1 0 0 0-1 1 4 4 0 0 0 4 4" />
        <path d="M17 6h3a1 1 0 0 1 1 1 4 4 0 0 1-4 4" />
    </svg>`;
}

// ---- Toast queue: one at a time, ~4s each ----

const toastQueue = [];
let toastActive = false;

function enqueueToast(id) {
    toastQueue.push(id);
    pumpToasts();
}

function pumpToasts() {
    if (toastActive || toastQueue.length === 0) return;
    // Cosmetic quiet window after a session start (anti-spam on load).
    const wait = achievements.msUntilToastsAllowed();
    if (wait > 0) {
        setTimeout(pumpToasts, wait + 50);
        return;
    }
    const id = toastQueue.shift();
    toastActive = true;

    let host = document.getElementById("achievement-toasts");
    if (!host) {
        host = document.createElement("div");
        host.id = "achievement-toasts";
        host.className = "fixed bottom-6 right-6 z-[70] pointer-events-none flex flex-col items-end gap-2";
        document.body.appendChild(host);
    }

    const def = ACHIEVEMENT_DEFS.find((d) => d.id === id);
    const tierColor = TIER_COLORS[def?.tier] || TIER_COLORS.bronze;
    const el = document.createElement("div");
    el.className = "glass-panel rounded-xl px-4 py-3 flex items-center gap-3 achievement-toast border border-amber-400/40";
    el.innerHTML = `
        ${trophySVG(tierColor)}
        <div class="text-left">
            <div class="text-[10px] uppercase tracking-widest text-amber-300 font-bold">${i18n.t("ach_unlocked")}</div>
            <div class="text-sm text-white font-bold">${i18n.t("ach_" + id + "_name")}</div>
        </div>`;
    host.appendChild(el);

    setTimeout(() => {
        el.classList.add("achievement-toast-out");
        setTimeout(() => {
            el.remove();
            toastActive = false;
            pumpToasts();
        }, TOAST_FADE_MS);
    }, TOAST_VISIBLE_MS);
}

// ---- Trophies panel (main menu entry; pause menu untouched) ----

function refreshTrophiesBadge() {
    const label = document.getElementById("trophies-progress-label");
    if (label) {
        label.textContent = `${achievements.unlockedCount()}/${ACHIEVEMENT_DEFS.length}`;
    }
    // Live-refresh the grid if the panel is open (e.g. after a locale unlock).
    const modal = document.getElementById("trophies-modal");
    if (modal && !modal.classList.contains("hidden")) renderTrophiesPanel();
}

function renderTrophiesPanel() {
    const grid = document.getElementById("trophies-grid");
    if (!grid) return;

    const unlockedMap = achievements.unlockedMap();
    const countEl = document.getElementById("trophies-count");
    if (countEl) {
        countEl.textContent = `${Object.keys(unlockedMap).length}/${ACHIEVEMENT_DEFS.length}`;
    }

    grid.innerHTML = ACHIEVEMENT_DEFS.map((def) => {
        const unlockedAt = unlockedMap[def.id];
        const tierColor = TIER_COLORS[def.tier] || TIER_COLORS.bronze;
        if (unlockedAt) {
            const date = new Date(unlockedAt).toLocaleDateString(i18n.currentLocale);
            return `
                <div class="border border-amber-500/40 bg-amber-900/10 rounded-lg p-3 flex items-start gap-3">
                    ${trophySVG(tierColor + " shrink-0 mt-0.5")}
                    <div class="min-w-0">
                        <div class="text-white font-bold text-sm">${i18n.t("ach_" + def.id + "_name")}</div>
                        <div class="text-gray-400 text-xs">${i18n.t("ach_" + def.id + "_desc")}</div>
                        <div class="text-amber-400/80 text-[10px] font-mono mt-1">${date}</div>
                    </div>
                </div>`;
        }
        // Locked: greyed silhouette.
        return `
            <div class="border border-gray-700/60 rounded-lg p-3 flex items-start gap-3 opacity-60">
                ${trophySVG("text-gray-600 shrink-0 mt-0.5")}
                <div class="min-w-0">
                    <div class="text-gray-400 font-bold text-sm">${i18n.t("ach_" + def.id + "_name")}</div>
                    <div class="text-gray-600 text-xs">${i18n.t("ach_" + def.id + "_desc")}</div>
                </div>
            </div>`;
    }).join("");
}

function showTrophies() {
    document.getElementById("main-menu-modal")?.classList.add("hidden");
    renderTrophiesPanel();
    document.getElementById("trophies-modal")?.classList.remove("hidden");
}

function closeTrophies() {
    document.getElementById("trophies-modal")?.classList.add("hidden");
    document.getElementById("main-menu-modal")?.classList.remove("hidden");
    refreshTrophiesBadge();
}

export {
    closeTrophies,
    enqueueToast,
    refreshTrophiesBadge,
    renderTrophiesPanel,
    showTrophies,
};
