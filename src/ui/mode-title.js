// The heading on the stats panel names the mode being played.
//
// The key moves with the mode: a language switch re-renders every data-i18n
// element, so a fixed key would turn a sandbox run back into SURVIVAL.
import { i18n } from "../i18n.js";
import { STATE } from "../state.js";

const TITLES = {
    survival: { key: "survival", classes: ["text-red-500", "animate-pulse"] },
    campaign: { key: "campaign_select_title", classes: ["text-yellow-400"] },
    sandbox: { key: "sandbox", classes: ["text-purple-400"] },
};

const ALL_CLASSES = Object.values(TITLES).flatMap((t) => t.classes);

function renderModeTitle() {
    const el = document.getElementById("mode-title");
    if (!el) return;
    const { key, classes } = TITLES[STATE.gameMode] || TITLES.survival;
    el.setAttribute("data-i18n", key);
    el.textContent = i18n.t(key);
    el.classList.remove(...ALL_CLASSES);
    el.classList.add(...classes);
}

export { renderModeTitle };
