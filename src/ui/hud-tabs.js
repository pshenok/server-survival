// Phone HUD tabs (#12).
//
// On a phone-sized screen (under 768px wide, or 500px tall or less — a phone
// held sideways) the HUD panels cannot share the screen, so style.css hides
// every one that lacks .m-open and this module hands that class to one tab's
// panels at a time. On anything larger the strip is display:none and .m-open
// styles nothing, so none of this is observable on a desktop.
//
// "goals" maps to two panels because the game shows exactly one of them per
// mode (objectives in survival and campaign, the sandbox controls in sandbox)
// by toggling .hidden. Marking both open leaves that choice with the game: an
// open panel that the mode has hidden stays hidden.
export const HUD_TABS = {
    stats: ["statsPanel"],
    goals: ["objectivesPanel", "sandboxPanel"],
    score: ["detailsPanel"],
    health: ["healthPanel"],
    metrics: ["metricsPanel"],
    finances: ["financesPanel"],
};

let openTab = null;

export function getOpenHudTab() {
    return openTab;
}

/** Opens `name`'s panels and closes every other tab's; the open tab closes. */
export function toggleHudTab(name) {
    openTab = openTab === name ? null : name;
    for (const [tab, ids] of Object.entries(HUD_TABS)) {
        for (const id of ids) {
            document.getElementById(id)?.classList.toggle("m-open", tab === openTab);
        }
    }
    document.querySelectorAll("[data-hud-tab]").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.dataset.hudTab === openTab));
    });
}

export function initHudTabs({ onResetView, onToggleView } = {}) {
    document.querySelectorAll("[data-hud-tab]").forEach((btn) => {
        btn.addEventListener("click", () => toggleHudTab(btn.dataset.hudTab));
    });
    if (onResetView) {
        document.getElementById("btn-reset-view")?.addEventListener("click", onResetView);
    }
    if (onToggleView) {
        document.getElementById("btn-toggle-view")?.addEventListener("click", onToggleView);
    }
}
