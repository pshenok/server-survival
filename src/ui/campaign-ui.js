// Campaign UI layer (#155 PR 6): level-select map, briefing/debrief modals,
// level tooltips, toolbar gating, objectives panel, and the level-start /
// navigation handlers index.html reaches via window.*. Code moved verbatim
// from game.js; game.js keeps thin window.x = importedX assignments in its
// ESM-boundary block.

import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { getRunReport } from "../core/metrics.js";
import { CAMPAIGN_LEVELS } from "../campaign/levels.js";
import { renderArchitectureSVG } from "../campaign/diagram.js";
import { Service } from "../entities/Service.js";
import { updateRepairCostTable } from "../core/economy.js";
import { recomputePower } from "../sim/power.js";
import { createConnection } from "../sim/topology.js";
import { applyToolbarGating } from "./toolbar.js";
// Runtime-only cycle (game.js ⇄ campaign-ui.js) — established pattern:
// resetGame is a hoisted function declaration in game.js, only called at
// runtime, long after both modules evaluate.
import { resetGame } from "../../game.js";

// Narrative strings live in the locales, looked up by convention (#238):
// level_<id>_title / _scenario / _learn / _debrief and obj_<levelId>_<objId>.
// levels.js carries no display text; tests/levels.test.mjs proves every key
// exists in en, so a level added without its strings fails CI instead of
// rendering raw keys.
function levelText(levelId, suffix) {
    return i18n.t(`level_${levelId}_${suffix}`);
}

function objLabel(levelId, o) {
    return i18n.t(`obj_${levelId}_${o.id}`);
}

// Code-point-aware preview: .slice() on the string itself can cut a Devanagari
// matra or an emoji surrogate in half at the ellipsis boundary.
function scenarioPreview(scenario) {
    const chars = [...scenario];
    return chars.length > 80 ? chars.slice(0, 80).join("") + "…" : scenario;
}

function openCampaignSelect() {
    document.getElementById("main-menu-modal").classList.add("hidden");
    document.getElementById("campaign-select-modal").classList.remove("hidden");
    renderCampaignLevels();
}

function exitCampaignToMenu() {
    document.getElementById("campaign-select-modal").classList.add("hidden");
    document.getElementById("campaign-briefing-modal").classList.add("hidden");
    document.getElementById("campaign-debrief-modal").classList.add("hidden");
    document.getElementById("main-menu-modal").classList.remove("hidden");
}

function exitCampaignToMap() {
    document.getElementById("campaign-briefing-modal").classList.add("hidden");
    document.getElementById("campaign-debrief-modal").classList.add("hidden");
    document.getElementById("campaign-select-modal").classList.remove("hidden");
    renderCampaignLevels();
    if (window.campaign?.active) window.campaign.exit();
}

function renderCampaignLevels() {
    const list = document.getElementById("campaign-levels-list");
    if (!list) return;
    const progress = window.campaign.loadProgress();
    let html = "";
    let lastChapter = -1;
    for (const lvl of CAMPAIGN_LEVELS) {
        if (lvl.chapter !== lastChapter) {
            if (lastChapter !== -1) html += "</div>";
            // Chapter headings come from the locale rather than a hardcoded
            // 1-3 table, so a new chapter needs a level and a translation and
            // nothing else (#217 added chapter 4).
            html += `<div class="text-yellow-400 text-sm font-bold uppercase tracking-wider mt-4 mb-2">${i18n.t("campaign_chapter_" + lvl.chapter)}</div>`;
            html += `<div class="space-y-2">`;
            lastChapter = lvl.chapter;
        }
        const unlocked = lvl.id <= progress.highestUnlocked;
        const entry = progress.completed[lvl.id];
        const stars = entry?.stars || 0;
        const starStr = unlocked ? ("★".repeat(stars) + "☆".repeat(3 - stars)) : "🔒";
        const time = entry ? ` · ${Math.round(entry.bestTimeSec)}s` : "";
        const clickHandler = unlocked ? `onclick="openCampaignBriefing(${lvl.id})"` : "";
        const cursor = unlocked ? "cursor-pointer hover:bg-gray-800/60" : "opacity-50 cursor-not-allowed";
        // Hover tooltip works for BOTH locked and unlocked levels — players can peek ahead at what's coming.
        const hoverHandlers = `onmousemove="showCampaignLevelTooltip(event, ${lvl.id})" onmouseleave="hideCampaignLevelTooltip()"`;
        html += `
            <div ${clickHandler} ${hoverHandlers}
                class="border border-gray-700 rounded-lg p-3 ${cursor} transition flex items-center gap-3">
                <div class="text-3xl">${lvl.icon}</div>
                <div class="flex-1">
                    <div class="text-white font-bold">${lvl.id}. ${levelText(lvl.id, "title")}</div>
                    <div class="text-gray-400 text-xs">${scenarioPreview(levelText(lvl.id, "scenario"))}</div>
                </div>
                <div class="text-yellow-400 font-mono text-sm">${starStr}${time}</div>
            </div>`;
    }
    html += "</div>";
    list.innerHTML = html;
    updateCampaignProgressLabel();
}

function updateCampaignProgressLabel() {
    const el = document.getElementById("campaign-progress-label");
    if (!el) return;
    const c = window.campaign;
    el.textContent = `${c.completedCount()}/${CAMPAIGN_LEVELS.length} ★${c.totalStars()}`;
}

// Mini-briefing tooltip shown when hovering a level card in Level Select.
// Reuses the existing global #tooltip element (z-index 100 beats the modal's z-50).
function showCampaignLevelTooltip(event, levelId) {
    const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
    if (!level) return;
    const t = document.getElementById("tooltip");
    if (!t) return;

    const goalsHtml = level.objectives.primary.map((o) => `<li>• ${objLabel(level.id, o)}</li>`).join("");
    const bonusHtml = level.objectives.bonus.map((o) => `<li>• ${objLabel(level.id, o)}</li>`).join("");
    // Shrink the diagram for tooltip use — viewBox stays the same, only displayed height.
    const diagram = renderArchitectureSVG(level.preBuilt, level.diagramHighlights)
        .replace('height="160"', 'height="90"');

    t.innerHTML = `
        <div class="text-base font-bold text-cyan-400 mb-2">${level.icon} ${level.id}. ${levelText(level.id, "title")}</div>
        <p class="text-xs text-gray-300 mb-2">${levelText(level.id, "scenario")}</p>
        <div class="bg-blue-900/40 rounded p-2 mb-2 border border-blue-700/30">
            <div class="text-[10px] text-blue-400 uppercase font-bold mb-1">\u{1F4DA} ${i18n.t("campaign_learn")}</div>
            <p class="text-xs text-gray-200">${levelText(level.id, "learn")}</p>
        </div>
        <div class="text-[10px] text-green-400 uppercase font-bold mb-1">\u{1F3AF} ${i18n.t("campaign_goals")}</div>
        <ul class="text-xs text-gray-200 mb-2">${goalsHtml}</ul>
        <div class="text-[10px] text-yellow-400 uppercase font-bold mb-1">⭐ ${i18n.t("campaign_bonus")}</div>
        <ul class="text-xs text-gray-200 mb-2">${bonusHtml}</ul>
        <div class="mt-2 pt-2 border-t border-gray-700">${diagram}</div>
    `;

    t.style.display = "block";
    t.style.maxWidth = "440px";
    t.style.whiteSpace = "normal";

    // Position: prefer right-of-cursor, but clamp to viewport so it never spills off-screen.
    const margin = 16;
    const rect = t.getBoundingClientRect();
    let left = event.clientX + 20;
    let top = event.clientY + 12;
    if (left + rect.width + margin > window.innerWidth) {
        left = event.clientX - rect.width - 20;
    }
    if (top + rect.height + margin > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    t.style.left = `${Math.max(margin, left)}px`;
    t.style.top = `${Math.max(margin, top)}px`;
}

function hideCampaignLevelTooltip() {
    const t = document.getElementById("tooltip");
    if (!t) return;
    t.style.display = "none";
    // Reset overrides so the canvas-hover tooltips work normally afterwards.
    t.style.maxWidth = "";
    t.style.whiteSpace = "";
}

let _pendingCampaignLevelId = null;

function openCampaignBriefing(levelId) {
    const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
    if (!level) return;
    _pendingCampaignLevelId = levelId;

    document.getElementById("campaign-select-modal").classList.add("hidden");
    document.getElementById("campaign-briefing-modal").classList.remove("hidden");

    document.getElementById("campaign-briefing-icon").textContent = level.icon;
    document.getElementById("campaign-briefing-chapter").textContent =
        i18n.t("campaign_chapter_level", { chapter: level.chapter, level: level.id });
    document.getElementById("campaign-briefing-title").textContent =
        levelText(level.id, "title").toUpperCase();
    document.getElementById("campaign-briefing-scenario").textContent = levelText(level.id, "scenario");
    document.getElementById("campaign-briefing-learn").textContent = levelText(level.id, "learn");

    document.getElementById("campaign-briefing-diagram").innerHTML =
        renderArchitectureSVG(level.preBuilt, level.diagramHighlights);

    document.getElementById("campaign-briefing-goals").innerHTML =
        level.objectives.primary.map((o) => `<li>• ${objLabel(level.id, o)}</li>`).join("");
    document.getElementById("campaign-briefing-bonus").innerHTML =
        level.objectives.bonus.map((o) => `<li>• ${objLabel(level.id, o)}</li>`).join("");
}

function campaignStartCurrentLevel() {
    const id = _pendingCampaignLevelId;
    if (!id) return;
    document.getElementById("campaign-briefing-modal").classList.add("hidden");
    window.startCampaignLevel(id);
}

function startCampaignLevel(levelId) {
    const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
    if (!level) return;

    if (!window.campaign.loadLevel(levelId)) return;

    resetGame("campaign");

    // Pre-place services using survival's existing creation path (bypasses cost check)
    const placed = [];
    for (const s of level.preBuilt.services) {
        const pos = new THREE.Vector3(s.x, 0, s.z);
        const svc = new Service(s.type, pos);
        STATE.services.push(svc);
        placed.push(svc);
        if (STATE.finances) {
            STATE.finances.expenses.countByService[s.type] =
                (STATE.finances.expenses.countByService[s.type] || 0) + 1;
        }
    }
    for (const [from, to] of level.preBuilt.connections) {
        const fromId = from === "internet" ? "internet" : placed[from].id;
        const toId = placed[to].id;
        createConnection(fromId, toId);
    }
    // Power grid (#87): the prebuild loop constructs via `new Service`
    // directly (bypassing createService), so the derivation must be re-run
    // here — a call-site-driven recompute would go stale exactly at this spot.
    recomputePower();
    updateRepairCostTable();

    // Apply level-specific forced settings
    STATE.trafficDistribution = { ...level.trafficDistribution };
    STATE.currentRPS = level.rps;
    STATE.money = level.budget;

    // Toolbar gating
    applyCampaignToolbarGating(level.allowedServices, level.forbiddenServices);

    // Teach a first-timer who entered through the EDUCATION mode (#263).
    // The tutorial had exactly one call site — survival's start button — so a
    // player who clicked Campaign, the mode whose whole purpose is teaching,
    // was taught neither the controls nor anything else. Level 1 is the only
    // level with an empty board, which is precisely what the walkthrough
    // assumes; steps whose service this level does not offer are skipped by
    // the tutorial itself, so its CDN steps drop out cleanly here.
    if (levelId === 1 && window.tutorial && !window.tutorial.isCompleted()) {
        setTimeout(() => window.tutorial.start(), 500);
    }

    // Start PAUSED — like Survival mode. Player surveys the situation
    // (pre-built architecture, allowed services, objectives panel) and
    // presses Play when ready. resetGame already set timeScale=0 and put
    // pulse-green on btn-play, so nothing else to do here.
}

// Grey out the services a level does not offer. The buttons themselves moved
// into the service palette (toolbar categories, 2026-07-24), which re-creates
// them on every tab switch, so the gate has to OUTLIVE a single DOM pass —
// src/ui/toolbar.js stores it and re-paints on each render, and also switches
// the player to a tab that actually holds one of this level's services. That
// makes the order irrelevant: a gate set before the toolbar's first render is
// remembered and painted by it, one set after paints the buttons on screen.
function applyCampaignToolbarGating(allowed, forbidden) {
    applyToolbarGating(allowed, forbidden);
}

function renderCampaignObjectives(level, primaryResults, bonusResults) {
    const panel = document.getElementById("objectivesPanel");
    if (!panel) return;
    panel.classList.remove("hidden");

    const primaryHtml = level.objectives.primary.map((o) => {
        const done = primaryResults[o.id];
        const icon = done ? "☑" : "☐";
        const color = done ? "text-green-400" : "text-gray-400";
        return `<li class="${color}"><span class="font-mono">${icon}</span> ${objLabel(level.id, o)}</li>`;
    }).join("");

    const bonusHtml = level.objectives.bonus.map((o) => {
        const done = bonusResults[o.id];
        const icon = done ? "⭐" : "☆";
        const color = done ? "text-yellow-300" : "text-gray-500";
        return `<li class="${color}"><span class="font-mono">${icon}</span> ${objLabel(level.id, o)}</li>`;
    }).join("");

    panel.innerHTML = `
        <div class="flex justify-between items-center mb-2">
            <h3 class="text-xs font-bold text-yellow-400 uppercase tracking-wider">
                ${i18n.t("campaign_hud_level", { id: level.id, title: levelText(level.id, "title") })}
            </h3>
            <span class="text-[10px] bg-yellow-900/50 px-2 py-0.5 rounded text-yellow-400 border border-yellow-800">${Math.round(STATE.elapsedGameTime)}s / ${level.durationSec}s</span>
        </div>
        <ul class="text-xs space-y-1 font-mono mb-2">${primaryHtml}</ul>
        <div class="text-[10px] text-yellow-500 uppercase mt-2 mb-1">${i18n.t("campaign_bonus")}</div>
        <ul class="text-[11px] space-y-1 font-mono">${bonusHtml}</ul>`;
}

// The run report (#252): the debrief used to print the same static paragraph
// whether the player won by understanding or lost by flailing — the one moment
// a learner is guaranteed to be reading carried nothing about their own board.
//
// GATING, decided explicitly rather than by habit: shown on every win, but on
// a loss only from the SECOND attempt onward. Level 15's busiestLoad objective
// is type-blind on purpose (campaign/objectives.js) so the player cannot name
// the hottest node without buying the Monitoring dashboard; naming it in the
// first loss would hand over the answer to the buy-the-eyes lesson. After one
// honest failed attempt, telling them what happened is teaching, not spoiling.
function renderRunReport(outcome, attempt) {
    const el = document.getElementById("campaign-debrief-report");
    if (!el) return;

    const show = outcome === "win" || attempt > 1;
    if (!show) {
        el.classList.add("hidden");
        el.innerHTML = "";
        return;
    }

    const r = getRunReport();
    // Nothing happened worth reporting (an instant restart, a board that never
    // served traffic) — say nothing rather than print a table of zeroes.
    if (!r.processed && !r.failures && !r.peaks.length) {
        el.classList.add("hidden");
        el.innerHTML = "";
        return;
    }

    const pct = (u) => Math.round(u * 200); // smoothedLoad 0.5 = 100% of capacity
    const peaks = r.peaks
        .filter((p) => p.util > 0)
        .slice(0, 3)
        .map(
            (p) =>
                `<li class="flex justify-between gap-3"><span>${i18n.t(p.type)}</span>` +
                `<span class="font-mono text-gray-400">${pct(p.util)}% @ ${Math.round(p.atSec)}s</span></li>`
        )
        .join("");

    const reasons = r.topReasons
        .map(
            (x) =>
                `<li class="flex justify-between gap-3"><span>${i18n.t(x.key)}</span>` +
                `<span class="font-mono text-gray-400">${x.count}</span></li>`
        )
        .join("");

    const onTimePct = r.processed ? Math.round((r.onTime / r.processed) * 100) : 0;

    el.innerHTML =
        `<div class="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2">${i18n.t("report_title")}</div>` +
        `<div class="grid grid-cols-2 gap-4 text-xs text-gray-200">` +
        `<div><div class="text-gray-500 uppercase mb-1">${i18n.t("report_peak_load")}</div>` +
        `<ul class="space-y-0.5">${peaks || `<li class="text-gray-500">${i18n.t("report_none")}</li>`}</ul></div>` +
        `<div><div class="text-gray-500 uppercase mb-1">${i18n.t("report_top_failures")}</div>` +
        `<ul class="space-y-0.5">${reasons || `<li class="text-gray-500">${i18n.t("report_none")}</li>`}</ul></div>` +
        `</div>` +
        `<div class="mt-2 pt-2 border-t border-gray-700 text-xs text-gray-300">` +
        `${i18n.t("report_served", { onTime: r.onTime, total: r.processed, pct: onTimePct })}` +
        (r.late ? ` · <span class="text-yellow-400">${i18n.t("report_late", { n: r.late })}</span>` : "") +
        `</div>`;
    el.classList.remove("hidden");
}

function showCampaignDebrief(outcome, reason, level) {
    document.getElementById("campaign-debrief-modal").classList.remove("hidden");

    const titleEl = document.getElementById("campaign-debrief-title");
    const iconEl = document.getElementById("campaign-debrief-icon");
    const starsEl = document.getElementById("campaign-debrief-stars");
    const reasonEl = document.getElementById("campaign-debrief-reason");
    const tipEl = document.getElementById("campaign-debrief-tip");
    const nextBtn = document.getElementById("campaign-debrief-next-btn");

    if (outcome === "win") {
        const stars = window.campaign._calculateStars();
        iconEl.textContent = "🎉";
        titleEl.textContent = i18n.t("campaign_level_complete");
        titleEl.className = "text-3xl font-bold mb-2 text-green-400";
        starsEl.textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
        reasonEl.textContent = i18n.t("campaign_completed_in", { sec: Math.round(STATE.elapsedGameTime) });
        tipEl.textContent = levelText(level.id, "debrief");

        const hasNext = CAMPAIGN_LEVELS.some((l) => l.id === level.id + 1);
        nextBtn.classList.toggle("hidden", !hasNext);
        if (typeof STATE.sound?.playSuccess === "function") STATE.sound.playSuccess();
    } else {
        iconEl.textContent = "❌";
        titleEl.textContent = i18n.t("campaign_level_failed");
        titleEl.className = "text-3xl font-bold mb-2 text-red-400";
        starsEl.textContent = "";
        // The sim layer reports WHY as { key, vars } (campaign.js knows no
        // display text); the boundary translates at render time so a locale
        // switch between death and debrief still shows the right language.
        reasonEl.textContent = reason
            ? i18n.t(reason.key, reason.vars)
            : i18n.t("campaign_objectives_not_met");
        tipEl.textContent = levelText(level.id, "debrief");
        nextBtn.classList.add("hidden");
        if (typeof STATE.sound?.playGameOver === "function") STATE.sound.playGameOver();
    }
    renderRunReport(outcome, STATE.campaign?.attempt || 1);
    updateCampaignProgressLabel();
}

function campaignRetryLevel() {
    const id = STATE.campaign.currentLevelId;
    document.getElementById("campaign-debrief-modal").classList.add("hidden");
    if (id) window.startCampaignLevel(id);
}

function campaignNextLevel() {
    const id = STATE.campaign.currentLevelId;
    document.getElementById("campaign-debrief-modal").classList.add("hidden");
    if (id) {
        const next = CAMPAIGN_LEVELS.find((l) => l.id === id + 1);
        if (next) window.openCampaignBriefing(next.id);
        else window.exitCampaignToMap();
    }
}

export {
    applyCampaignToolbarGating,
    renderRunReport,
    campaignNextLevel,
    campaignRetryLevel,
    campaignStartCurrentLevel,
    exitCampaignToMap,
    exitCampaignToMenu,
    hideCampaignLevelTooltip,
    openCampaignBriefing,
    openCampaignSelect,
    renderCampaignLevels,
    renderCampaignObjectives,
    showCampaignDebrief,
    showCampaignLevelTooltip,
    startCampaignLevel,
    updateCampaignProgressLabel,
};
