// Campaign UI layer (#155 PR 6): level-select map, briefing/debrief modals,
// level tooltips, toolbar gating, objectives panel, and the level-start /
// navigation handlers index.html reaches via window.*. Code moved verbatim
// from game.js; game.js keeps thin window.x = importedX assignments in its
// ESM-boundary block.

import { STATE } from "../state.js";
import { CAMPAIGN_LEVELS } from "../campaign/levels.js";
import { renderArchitectureSVG } from "../campaign/diagram.js";
import { Service } from "../entities/Service.js";
import { updateRepairCostTable } from "../core/economy.js";
import { createConnection } from "../sim/topology.js";
// Runtime-only cycle (game.js ⇄ campaign-ui.js) — established pattern:
// resetGame is a hoisted function declaration in game.js, only called at
// runtime, long after both modules evaluate.
import { resetGame } from "../../game.js";

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
    const chapters = { 1: "Chapter 1: Basics", 2: "Chapter 2: Optimization", 3: "Chapter 3: Defense & Mastery" };
    let html = "";
    let lastChapter = -1;
    for (const lvl of CAMPAIGN_LEVELS) {
        if (lvl.chapter !== lastChapter) {
            if (lastChapter !== -1) html += "</div>";
            html += `<div class="text-yellow-400 text-sm font-bold uppercase tracking-wider mt-4 mb-2">${chapters[lvl.chapter]}</div>`;
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
                    <div class="text-white font-bold">${lvl.id}. ${lvl.title}</div>
                    <div class="text-gray-400 text-xs">${lvl.scenario.slice(0, 80)}${lvl.scenario.length > 80 ? "…" : ""}</div>
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

    const goalsHtml = level.objectives.primary.map((o) => `<li>• ${o.label}</li>`).join("");
    const bonusHtml = level.objectives.bonus.map((o) => `<li>• ${o.label}</li>`).join("");
    // Shrink the diagram for tooltip use — viewBox stays the same, only displayed height.
    const diagram = renderArchitectureSVG(level.preBuilt, level.diagramHighlights)
        .replace('height="160"', 'height="90"');

    t.innerHTML = `
        <div class="text-base font-bold text-cyan-400 mb-2">${level.icon} ${level.id}. ${level.title}</div>
        <p class="text-xs text-gray-300 mb-2">${level.scenario}</p>
        <div class="bg-blue-900/40 rounded p-2 mb-2 border border-blue-700/30">
            <div class="text-[10px] text-blue-400 uppercase font-bold mb-1">\u{1F4DA} Learn</div>
            <p class="text-xs text-gray-200">${level.learn}</p>
        </div>
        <div class="text-[10px] text-green-400 uppercase font-bold mb-1">\u{1F3AF} Goals</div>
        <ul class="text-xs text-gray-200 mb-2">${goalsHtml}</ul>
        <div class="text-[10px] text-yellow-400 uppercase font-bold mb-1">⭐ Bonus</div>
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
        `Chapter ${level.chapter} · Level ${level.id}`;
    document.getElementById("campaign-briefing-title").textContent = level.title.toUpperCase();
    document.getElementById("campaign-briefing-scenario").textContent = level.scenario;
    document.getElementById("campaign-briefing-learn").textContent = level.learn;

    document.getElementById("campaign-briefing-diagram").innerHTML =
        renderArchitectureSVG(level.preBuilt, level.diagramHighlights);

    document.getElementById("campaign-briefing-goals").innerHTML =
        level.objectives.primary.map((o) => `<li>• ${o.label}</li>`).join("");
    document.getElementById("campaign-briefing-bonus").innerHTML =
        level.objectives.bonus.map((o) => `<li>• ${o.label}</li>`).join("");
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
    updateRepairCostTable();

    // Apply level-specific forced settings
    STATE.trafficDistribution = { ...level.trafficDistribution };
    STATE.currentRPS = level.rps;
    STATE.money = level.budget;

    // Toolbar gating
    applyCampaignToolbarGating(level.allowedServices, level.forbiddenServices);

    // Start PAUSED — like Survival mode. Player surveys the situation
    // (pre-built architecture, allowed services, objectives panel) and
    // presses Play when ready. resetGame already set timeScale=0 and put
    // pulse-green on btn-play, so nothing else to do here.
}

function applyCampaignToolbarGating(allowed, forbidden) {
    // Map service config keys to their toolbar button IDs.
    // (matches the toolbar typeMap in mousedown handler)
    const toolMap = {
        waf: "tool-waf", apigw: "tool-apigw", sqs: "tool-sqs", alb: "tool-alb",
        lambda: "tool-lambda", serverless: "tool-serverless",
        db: "tool-db", nosql: "tool-nosql", cache: "tool-cache",
        cdn: "tool-cdn", s3: "tool-s3", search: "tool-search", replica: "tool-replica",
    };

    // First clear any prior gating
    Object.values(toolMap).forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.remove("opacity-30", "pointer-events-none");
        btn.removeAttribute("data-campaign-blocked");
    });

    const allowSet = allowed && allowed.length ? new Set(allowed) : null;
    const blockSet = new Set(forbidden || []);

    // The "lambda" tool is a button for compute service.
    // Normalize: allowSet uses CONFIG keys, but toolMap key for compute is "lambda".
    // To gate compute, accept both "compute" and "lambda" in allowed/forbidden lists.
    const isAllowed = (toolKey) => {
        if (!allowSet) return !blockSet.has(toolKey) && !blockSet.has(toolKey === "lambda" ? "compute" : toolKey);
        if (allowSet.has(toolKey)) return true;
        if (toolKey === "lambda" && allowSet.has("compute")) return true;
        return false;
    };

    Object.entries(toolMap).forEach(([k, id]) => {
        if (!isAllowed(k)) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.add("opacity-30", "pointer-events-none");
            btn.setAttribute("data-campaign-blocked", "true");
        }
    });
}

function renderCampaignObjectives(level, primaryResults, bonusResults) {
    const panel = document.getElementById("objectivesPanel");
    if (!panel) return;
    panel.classList.remove("hidden");

    const primaryHtml = level.objectives.primary.map((o) => {
        const done = primaryResults[o.id];
        const icon = done ? "☑" : "☐";
        const color = done ? "text-green-400" : "text-gray-400";
        return `<li class="${color}"><span class="font-mono">${icon}</span> ${o.label}</li>`;
    }).join("");

    const bonusHtml = level.objectives.bonus.map((o) => {
        const done = bonusResults[o.id];
        const icon = done ? "⭐" : "☆";
        const color = done ? "text-yellow-300" : "text-gray-500";
        return `<li class="${color}"><span class="font-mono">${icon}</span> ${o.label}</li>`;
    }).join("");

    panel.innerHTML = `
        <div class="flex justify-between items-center mb-2">
            <h3 class="text-xs font-bold text-yellow-400 uppercase tracking-wider">
                Level ${level.id}: ${level.title}
            </h3>
            <span class="text-[10px] bg-yellow-900/50 px-2 py-0.5 rounded text-yellow-400 border border-yellow-800">${Math.round(STATE.elapsedGameTime)}s / ${level.durationSec}s</span>
        </div>
        <ul class="text-xs space-y-1 font-mono mb-2">${primaryHtml}</ul>
        <div class="text-[10px] text-yellow-500 uppercase mt-2 mb-1">Bonus</div>
        <ul class="text-[11px] space-y-1 font-mono">${bonusHtml}</ul>`;
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
        titleEl.textContent = "LEVEL COMPLETE";
        titleEl.className = "text-3xl font-bold mb-2 text-green-400";
        starsEl.textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
        reasonEl.textContent = `Completed in ${Math.round(STATE.elapsedGameTime)}s`;
        tipEl.textContent = level.debriefTip;

        const hasNext = CAMPAIGN_LEVELS.some((l) => l.id === level.id + 1);
        nextBtn.classList.toggle("hidden", !hasNext);
        if (typeof STATE.sound?.playSuccess === "function") STATE.sound.playSuccess();
    } else {
        iconEl.textContent = "❌";
        titleEl.textContent = "LEVEL FAILED";
        titleEl.className = "text-3xl font-bold mb-2 text-red-400";
        starsEl.textContent = "";
        reasonEl.textContent = reason || "Objectives not met";
        tipEl.textContent = level.debriefTip;
        nextBtn.classList.add("hidden");
        if (typeof STATE.sound?.playGameOver === "function") STATE.sound.playGameOver();
    }
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
