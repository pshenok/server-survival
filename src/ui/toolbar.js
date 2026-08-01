// Service palette with category tabs
// (docs/superpowers/specs/2026-07-24-toolbar-categories-design.md).
//
// The bottom bar used to carry all 23 service buttons in one flat ~2000px run,
// so half the palette hung off-screen and the player had to scroll sideways to
// reach it. This module owns that half of the bar: five category tabs — the
// cloud-domain map from the Wave 1 epic (#193): front door → compute → data →
// async → ops — of which only the active one's buttons exist in the DOM.
//
// The buttons are generated from the markup index.html used to hold verbatim:
// same classes, same id="tool-<type>", same cost badge (read from CONFIG so it
// can no longer drift), same label span. Campaign gating and the hover
// tooltips look their elements up by id, and locale switching by attribute, so
// none of them needed a change. Two things DO have to be redone after every
// render, because the buttons are new nodes each time:
//
//   1. the labels — re-translated here (paintLabels);
//   2. the toolbar tooltips in input/handlers.js — that module imports THIS
//      one for the 1-5 shortcuts, so it cannot be imported back; instead every
//      render dispatches a "toolbarRendered" event which handlers.js listens
//      for. game.js calls renderToolbar() from its body, i.e. after the whole
//      module graph (including that listener) has evaluated.
//
// Campaign gating is stored here too — see applyToolbarGating.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";

// The five tabs. Adding a service in a later wave means adding its CONFIG
// type to one of these arrays — the completeness test in tests/sim/toolbar.
// test.mjs fails the build if a placeable type is in none of them (it would
// silently become unreachable) or in two.
const SERVICE_CATEGORIES = [
    {
        id: "frontdoor",
        labelKey: "cat_frontdoor",
        types: ["dns", "cdn", "waf", "auth", "apigw", "alb"],
    },
    {
        id: "compute",
        labelKey: "cat_compute",
        types: ["compute", "serverless", "container", "gpu", "infgw"],
    },
    {
        id: "data",
        labelKey: "cat_data",
        types: ["db", "nosql", "cache", "s3", "search", "replica", "warehouse"],
    },
    {
        id: "async",
        labelKey: "cat_async",
        types: ["sqs", "pubsub", "stream", "dlq", "scheduler", "notify"],
    },
    {
        id: "ops",
        labelKey: "cat_ops",
        types: ["monitor", "power"],
    },
];

// Per-service button data, keyed by CONFIG.services type.
//   tool  — the value setTool() gets and the id suffix, when it differs from
//           the config type. Only Compute does: its button has always been
//           id="tool-lambda" / setTool('lambda'), and the typeMap in
//           input/handlers.js plus the toolMap in ui/campaign-ui.js are
//           written in those terms. Renaming it is a separate change.
//   key   — i18n key of the label; text — its untranslated fallback.
//   icon  — the coloured shape, copied from index.html unchanged.
// The cost badge is NOT here: it comes from CONFIG.services[type].cost.
const SERVICE_BUTTONS = {
    waf: {
        key: "fw",
        text: "FW",
        icon: `<div class="w-4 h-4 bg-purple-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(168,85,247,0.6)]"></div>`,
    },
    apigw: {
        key: "apigw_short",
        text: "API GW",
        icon: `<div class="w-4 h-4 bg-fuchsia-400 rounded-sm mb-1 shadow-[0_0_10px_rgba(232,121,249,0.6)]" style="transform: rotate(45deg)"></div>`,
    },
    sqs: {
        key: "queue",
        text: "Queue",
        icon: `<div class="w-5 h-3 bg-orange-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(255,153,0,0.6)]"></div>`,
    },
    alb: {
        key: "lb",
        text: "LB",
        icon: `<div class="w-4 h-4 bg-blue-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(59,130,246,0.6)]"></div>`,
    },
    compute: {
        tool: "lambda",
        key: "compute_short",
        text: "Compute",
        icon: `<div class="w-4 h-4 bg-orange-500 rounded-full mb-1 shadow-[0_0_10px_rgba(249,115,22,0.6)]"></div>`,
    },
    serverless: {
        key: "serverless_short",
        text: "λ Func",
        icon: `<div class="w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-b-[14px] border-b-amber-400 mb-1 shadow-[0_0_10px_rgba(251,191,36,0.6)]"></div>`,
    },
    db: {
        key: "db_short",
        text: "SQL DB",
        icon: `<div class="w-4 h-4 bg-red-600 rounded-sm mb-1 shadow-[0_0_10px_rgba(220,38,38,0.6)] border-b-2 border-red-800"></div>`,
    },
    nosql: {
        key: "nosql_short",
        text: "NoSQL",
        icon: `<div class="w-4 h-4 bg-violet-600 rounded-full mb-1 shadow-[0_0_10px_rgba(124,58,237,0.6)] border-b-2 border-violet-800"></div>`,
    },
    cache: {
        key: "cache_short",
        text: "Cache",
        icon: `<div class="w-4 h-4 bg-red-600 rounded mb-1 shadow-[0_0_10px_rgba(220,56,45,0.6)]"></div>`,
    },
    cdn: {
        key: "cdn_short",
        text: "CDN",
        icon: `<div class="w-4 h-4 bg-green-400 rounded-full mb-1 shadow-[0_0_10px_rgba(74,222,128,0.6)] border border-white"></div>`,
    },
    s3: {
        key: "storage_short",
        text: "Storage",
        icon: `<div class="w-4 h-4 bg-emerald-500 rounded-full mb-1 shadow-[0_0_10px_rgba(16,185,129,0.6)]"></div>`,
    },
    search: {
        key: "search_short",
        text: "Search",
        icon: `<div class="w-4 h-4 bg-cyan-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(6,182,212,0.6)]" style="transform: rotate(22deg)"></div>`,
    },
    replica: {
        key: "replica_short",
        text: "Replica",
        icon: `<div class="w-4 h-4 bg-pink-400 rounded-sm mb-1 shadow-[0_0_10px_rgba(244,114,182,0.6)] border-b-2 border-pink-600"></div>`,
    },
    monitor: {
        key: "monitor_short",
        text: "Monitor",
        icon: `<div class="w-4 h-4 bg-teal-400 rounded-full mb-1 shadow-[0_0_10px_rgba(20,184,166,0.6)] border-2 border-teal-700"></div>`,
    },
    dlq: {
        key: "dlq_short",
        text: "DLQ",
        icon: `<div class="w-4 h-4 bg-stone-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(120,113,108,0.6)] border-b-2 border-stone-700"></div>`,
    },
    pubsub: {
        key: "pubsub_short",
        text: "Pub/Sub",
        icon: `<div class="w-4 h-4 bg-indigo-400 mb-1 shadow-[0_0_10px_rgba(129,140,248,0.6)]" style="clip-path: polygon(50% 0, 100% 100%, 0 100%)"></div>`,
    },
    auth: {
        key: "auth_short",
        text: "Auth",
        icon: `<div class="w-3 h-4 bg-yellow-500 rounded-sm mb-1 shadow-[0_0_10px_rgba(234,179,8,0.6)] border border-yellow-700"></div>`,
    },
    scheduler: {
        key: "scheduler_short",
        text: "Cron",
        icon: `<div class="w-4 h-4 bg-sky-400 rounded-full mb-1 shadow-[0_0_10px_rgba(56,189,248,0.6)] border border-sky-700"></div>`,
    },
    notify: {
        key: "notify_short",
        text: "Notify",
        icon: `<div class="w-4 h-4 bg-rose-400 mb-1 shadow-[0_0_10px_rgba(251,113,133,0.6)]" style="clip-path: polygon(0 100%, 100% 100%, 50% 0)"></div>`,
    },
    container: {
        key: "container_short",
        text: "Cluster",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-blue-400" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="6" width="5" height="4.5" rx="0.5" /><rect x="9.5" y="6" width="5" height="4.5" rx="0.5" /><rect x="5.5" y="1.5" width="5" height="4.5" rx="0.5" /></svg>`,
    },
    stream: {
        key: "stream_short",
        text: "Stream",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-teal-400" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4h13" /><path d="M1.5 8h13" /><path d="M1.5 12h13" /><circle cx="5" cy="4" r="0.4" fill="currentColor" /><circle cx="10" cy="8" r="0.4" fill="currentColor" /><circle cx="7" cy="12" r="0.4" fill="currentColor" /></svg>`,
    },
    dns: {
        key: "dns_short",
        text: "GeoDNS",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-lime-400" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4" /><path d="M8 1.8c2 2 2 10.4 0 12.4-2-2-2-10.4 0-12.4Z" /></svg>`,
    },
    warehouse: {
        key: "warehouse_short",
        text: "Warehouse",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-amber-500" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 6.5 8 2l6.5 4.5" /><path d="M2.5 6.5v7.5h11V6.5" /><path d="M5 14v-4h6v4" /></svg>`,
    },
    // ===== The AI Wave (#87) =====
    gpu: {
        key: "gpu_short",
        text: "GPU",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-fuchsia-400" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="12" height="8" rx="1" /><rect x="5" y="6.5" width="3" height="3" /><path d="M10 6.5v3M12 6.5v3" /><path d="M4 12v2M7 12v2M10 12v2" /></svg>`,
    },
    infgw: {
        key: "infgw_short",
        text: "Inf GW",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-fuchsia-600" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2.5h12L9.5 8v5.5l-3 -1.5V8Z" /><path d="M9.5 10.5h4.5" /><circle cx="14" cy="10.5" r="0.4" fill="currentColor" /></svg>`,
    },
    power: {
        key: "power_short",
        text: "Substation",
        icon: `<svg viewBox="0 0 16 16" class="w-4 h-4 mb-1 text-yellow-400" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5 3.5 9h3L7 14.5 12.5 7h-3Z" /></svg>`,
    },
};

// The class strings index.html carried on the service buttons, unchanged.
const BTN_CLASSES =
    "service-btn bg-gray-800 text-gray-200 p-2 rounded-lg w-16 h-16 flex flex-col " +
    "items-center justify-center border border-transparent group relative overflow-hidden";
const COST_CLASSES =
    "absolute top-0 right-0 bg-green-900/80 text-green-400 text-[9px] px-1 rounded-bl font-mono";
const LABEL_CLASSES = "text-[10px] font-bold mt-1";

// The translation attribute, composed rather than written literally: the
// i18n-usage test greps the sources for literal attribute/key pairs, and an
// interpolated key would register there as a bogus, never-defined key. The
// real keys are the ones in SERVICE_BUTTONS and SERVICE_CATEGORIES above, and
// tests/sim/toolbar.test.mjs asserts every one of them resolves in en — a
// stronger check than the grep, since it reads the data instead of the text.
const I18N_ATTR = "data-i18n";

const TAB_BASE =
    "toolbar-tab px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide " +
    "border transition whitespace-nowrap";
const TAB_ACTIVE = "bg-cyan-900/60 text-cyan-200 border-cyan-500/50";
const TAB_IDLE = "bg-gray-800/60 text-gray-400 border-gray-700 hover:text-gray-200";

const STORAGE_KEY = "serverSurvivalToolbarCategory";

// Campaign gating (spec, "Campaign interaction"): the level's allow/forbid
// lists, normalised to CONFIG types. Kept here because the buttons are new DOM
// nodes after every tab switch and would otherwise come back enabled — and
// because that makes the render order irrelevant: a gate applied before the
// first render is remembered and painted by it, a gate applied after paints
// the buttons already on screen.
let gate = null;

let activeCategoryId = restoreCategory();

function restoreCategory() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        stored = null; // private mode / storage disabled — fall back to the first tab
    }
    return SERVICE_CATEGORIES.some((c) => c.id === stored) ? stored : SERVICE_CATEGORIES[0].id;
}

function activeCategory() {
    return SERVICE_CATEGORIES.find((c) => c.id === activeCategoryId) || SERVICE_CATEGORIES[0];
}

// "lambda" is the Compute button's tool name; campaign levels may name the
// service either way, so both mean compute here (matching the normalisation
// the old gating code did).
function normalizeType(type) {
    return type === "lambda" ? "compute" : type;
}

function isTypeAllowed(type) {
    if (!gate) return true;
    if (gate.allowed) return gate.allowed.has(normalizeType(type));
    return !gate.forbidden.has(normalizeType(type));
}

function allowedCount(category) {
    return category.types.filter(isTypeAllowed).length;
}

function buttonHTML(type) {
    const spec = SERVICE_BUTTONS[type];
    const tool = spec.tool || type;
    const cost = CONFIG.services[type].cost;
    return (
        `<button id="tool-${tool}" class="${BTN_CLASSES}" onclick="setTool('${tool}')">` +
        `<div class="${COST_CLASSES}">$${cost}</div>` +
        spec.icon +
        `<span ${I18N_ATTR}="${spec.key}" class="${LABEL_CLASSES}">${spec.text}</span>` +
        `</button>`
    );
}

// Translate the freshly built nodes. i18n.applyTranslations() would do it too,
// but it walks the whole document and rewrites every panel — this runs on
// every tab switch, so it stays local. Buttons already in the DOM when the
// locale changes are handled by applyTranslations as before.
function paintLabels(root) {
    root.querySelectorAll("[" + I18N_ATTR + "]").forEach((el) => {
        el.textContent = i18n.t(el.getAttribute(I18N_ATTR));
    });
}

function renderTabs() {
    const strip = document.getElementById("service-tabs");
    if (!strip) return;
    strip.innerHTML = "";

    for (const cat of SERVICE_CATEGORIES) {
        const tab = document.createElement("button");
        tab.id = `toolbar-tab-${cat.id}`;
        tab.type = "button";
        tab.className = `${TAB_BASE} ${cat.id === activeCategoryId ? TAB_ACTIVE : TAB_IDLE}`;
        tab.setAttribute("data-toolbar-tab", cat.id);

        const label = document.createElement("span");
        label.setAttribute(I18N_ATTR, cat.labelKey);
        label.textContent = i18n.t(cat.labelKey);
        tab.appendChild(label);

        // Under a campaign gate, show how many of the level's services live
        // behind this tab — otherwise a player on an all-grey tab concludes
        // the game is broken.
        if (gate) {
            const badge = document.createElement("span");
            const n = allowedCount(cat);
            badge.className = `ml-1 font-mono ${n > 0 ? "text-yellow-300" : "text-gray-600"}`;
            badge.setAttribute("data-toolbar-tab-count", String(n));
            badge.textContent = `· ${n}`;
            tab.appendChild(badge);
        }

        tab.addEventListener("click", () => setToolbarCategory(cat.id));
        strip.appendChild(tab);
    }
}

function renderPalette() {
    const palette = document.getElementById("service-palette");
    if (!palette) return;

    palette.innerHTML = activeCategory().types.map(buttonHTML).join("");
    paintLabels(palette);

    // The selected tool keeps its highlight when its tab comes back into view.
    const selected = document.getElementById(`tool-${STATE.activeTool}`);
    if (selected && palette.contains(selected)) selected.classList.add("active");

    paintGating(palette);
}

// Grey out what the level forbids. Same two classes the campaign gating has
// always used, so nothing downstream (CSS, save/load, tests) had to change.
function paintGating(palette) {
    for (const type of activeCategory().types) {
        const spec = SERVICE_BUTTONS[type];
        const btn = palette.querySelector(`#tool-${spec.tool || type}`);
        if (!btn) continue;
        if (isTypeAllowed(type)) {
            btn.classList.remove("opacity-30", "pointer-events-none");
            btn.removeAttribute("data-campaign-blocked");
        } else {
            btn.classList.add("opacity-30", "pointer-events-none");
            btn.setAttribute("data-campaign-blocked", "true");
        }
    }
}

function renderToolbar() {
    renderTabs();
    renderPalette();
    // input/handlers.js re-wires the button tooltips on this (it cannot be
    // imported from here — it imports this module for the 1-5 shortcuts).
    window.dispatchEvent(new CustomEvent("toolbarRendered"));
}

// Switch tabs and redraw. `persist` is false for the automatic switch a
// campaign level triggers, so a level's gating cannot overwrite the tab the
// player last chose for themselves.
function setToolbarCategory(id, { persist = true } = {}) {
    if (!SERVICE_CATEGORIES.some((c) => c.id === id)) return;
    activeCategoryId = id;
    if (persist) {
        try {
            localStorage.setItem(STORAGE_KEY, id);
        } catch {
            // storage disabled — the tab is simply not remembered
        }
    }
    renderToolbar();
}

// Called by ui/campaign-ui.js when a level starts. Stores the gate, then
// lands the player on the first tab that actually holds one of the level's
// services (spec, "Campaign interaction" — mitigation 1) and redraws.
function applyToolbarGating(allowed, forbidden) {
    const allowList = (allowed || []).map(normalizeType);
    const blockList = (forbidden || []).map(normalizeType);
    gate =
        allowList.length || blockList.length
            ? {
                allowed: allowList.length ? new Set(allowList) : null,
                forbidden: new Set(blockList),
            }
            : null;

    const target = SERVICE_CATEGORIES.find((c) => allowedCount(c) > 0);
    if (gate && target) setToolbarCategory(target.id, { persist: false });
    else renderToolbar();
}

export {
    SERVICE_BUTTONS,
    SERVICE_CATEGORIES,
    applyToolbarGating,
    renderToolbar,
    setToolbarCategory,
};
