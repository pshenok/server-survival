// Save/load system (#155 PR 6): save modal, serialization to localStorage or
// downloaded file, old-save migration, and full state restore (services,
// connections, finances, UI sync). Code moved verbatim from game.js; game.js
// keeps thin window.x = importedX assignments in its ESM-boundary block.

import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { updateScoreUI } from "../core/actions.js";
import { updateRepairCostTable } from "../core/economy.js";
import { createConnection, restoreService } from "../sim/topology.js";
// Runtime-only cycle (game.js ⇄ save-load.js) — established pattern: these
// are hoisted function declarations / top-level consts in game.js, only
// dereferenced at runtime, long after both modules evaluate.
import {
    animate,
    connectionGroup,
    requestGroup,
    serviceGroup,
    syncInput,
} from "../../game.js";

// Function to show save modal (triggered from UI)
function showSaveModal() {
    const modal = document.getElementById("save-modal");
    if (modal) {
        modal.classList.remove("hidden");
    }
}

// Function to close save modal (triggered from UI)
function closeSaveModal() {
    const modal = document.getElementById("save-modal");
    if (modal) {
        modal.classList.add("hidden");
    }
}

// Function to save game state to localStorage or download as file (triggered from UI inside save modal)
function saveGameState(saveAs = "browser") {
    try {
        const saveData = {
            timestamp: Date.now(),
            version: "2.0",
            ...STATE,
            score: { ...STATE.score },
            trafficDistribution: { ...STATE.trafficDistribution },
            services: STATE.services.map((service) => ({
                id: service.id,
                type: service.type,
                position: [service.position.x, service.position.y, service.position.z],
                connections: [...service.connections],
                tier: service.tier,
                cacheHitRate: service.config.cacheHitRate || null,
            })),
            connections: STATE.connections.map((conn) => ({
                from: conn.from,
                to: conn.to,
            })),
            requests: [],
            internetConnections: [...STATE.internetNode.connections],
        };

        if(saveAs === "file")
            downloadSaveFile(saveData);
        else
            localStorage.setItem("serverSurvivalSave", JSON.stringify(saveData));

        const saveBtn = document.getElementById("btn-save");
        const originalColor = saveBtn.classList.contains("hover:border-green-500")
            ? ""
            : saveBtn.style.borderColor;
        saveBtn.style.borderColor = "#10b981"; // green-500
        saveBtn.style.color = "#10b981";
        setTimeout(() => {
            saveBtn.style.borderColor = originalColor;
            saveBtn.style.color = "";
        }, 1000);

        STATE.sound.playPlace(); // Use place sound as feedback
        window.closeSaveModal();
    } catch (error) {
        console.error("Failed to save game:", error);
        alert(i18n.t('save_failed'));
    }
}

// Function to download save data as a file
function downloadSaveFile(saveData) {

    const blob = new Blob([JSON.stringify(saveData)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replace(',', '');
    a.download = `ServerSurvival-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

}

function onSaveGameFileUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        alert(i18n.t('no_file_selected'));
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            let saveData = JSON.parse(e.target.result);
            loadGameState(saveData);

            STATE.sound.playPlace(); // Use place sound as feedback
        } catch (error) {
            console.error("Failed to load game:", error);
            alert(i18n.t('load_failed_corrupted'));
        }
    };
    reader.readAsText(file);
    // Reset the input value to allow uploading the same file again if needed
    event.target.value = "";
}

function migrateOldSave(saveData) {
    if (saveData.trafficDistribution) {
        const oldDist = saveData.trafficDistribution;
        if ("WEB" in oldDist || "API" in oldDist || "FRAUD" in oldDist) {
            saveData.trafficDistribution = {
                STATIC: oldDist.WEB || 0,
                READ: (oldDist.API || 0) * 0.5,
                WRITE: (oldDist.API || 0) * 0.3,
                UPLOAD: 0.05,
                SEARCH: (oldDist.API || 0) * 0.2,
                MALICIOUS: oldDist.FRAUD || 0,
            };
        }
    }

    if (saveData.score) {
        const oldScore = saveData.score;
        if ("web" in oldScore || "api" in oldScore || "fraudBlocked" in oldScore) {
            saveData.score = {
                total: oldScore.total || 0,
                storage: oldScore.web || 0,
                database: oldScore.api || 0,
                maliciousBlocked: oldScore.fraudBlocked || 0,
            };
        }
    }

    if ("fraudSpikeTimer" in saveData) {
        saveData.maliciousSpikeTimer = saveData.fraudSpikeTimer;
        delete saveData.fraudSpikeTimer;
    }
    if ("fraudSpikeActive" in saveData) {
        saveData.maliciousSpikeActive = saveData.fraudSpikeActive;
        delete saveData.fraudSpikeActive;
    }

    return saveData;
}

// Function to load game state from localStorage (triggered from UI) or provided save data (provided from uploaded file)
function onClickContinueGame() {
    loadGameState();
}

function loadGameState(saveData = null) {
    try {
        // If saveData is not provided, attempt to load from localStorage
        if(!saveData){
            const saveDataStr = localStorage.getItem("serverSurvivalSave");
            if (!saveDataStr) {
                alert(i18n.t('no_save_found_msg'));
                return;
            }

            saveData = JSON.parse(saveDataStr);

        }

        // Migrate old saves if version is missing or 1.0
        if (!saveData.version || saveData.version === "1.0") {
            saveData = migrateOldSave(saveData);
        }

        clearCurrentGame();

        STATE.money = saveData.money || 0;
        STATE.reputation = saveData.reputation || 100;
        STATE.requestsProcessed = saveData.requestsProcessed || 0;
        // A spread of undefined is {} (truthy), so `|| default` never fired —
        // an old save without this field got {} and NaN'd the score math.
        STATE.score = saveData.score ? { ...saveData.score } : {
            total: 0,
            storage: 0,
            database: 0,
            maliciousBlocked: 0,
        };
        STATE.activeTool = saveData.activeTool || "select";
        STATE.selectedNodeId = saveData.selectedNodeId || null;
        STATE.lastTime = performance.now(); // Reset timing
        STATE.spawnTimer = saveData.spawnTimer || 0;
        STATE.currentRPS = saveData.currentRPS || 0.5;
        STATE.timeScale = saveData.timeScale || 0; // Start paused
        STATE.elapsedGameTime = saveData.elapsedGameTime ?? 0;
        STATE.isRunning = saveData.isRunning || false;
        STATE.gameStartTime = performance.now();

        STATE.gameMode = saveData.gameMode || "survival";
        STATE.sandboxBudget = saveData.sandboxBudget || 2000;
        STATE.upkeepEnabled = saveData.upkeepEnabled !== false;
        // Same dead-fallback pattern as score above: spread of undefined is {}.
        STATE.trafficDistribution = saveData.trafficDistribution ? { ...saveData.trafficDistribution } : {
            STATIC: 0.3,
            READ: 0.2,
            WRITE: 0.15,
            UPLOAD: 0.05,
            SEARCH: 0.1,
            MALICIOUS: 0.2,
        };
        STATE.burstCount = saveData.burstCount || 10;
        STATE.gameStarted = saveData.gameStarted || true;
        STATE.previousTimeScale = saveData.previousTimeScale || 1;

        // Initialize intervention state for survival mode mechanics
        if (STATE.gameMode === "survival") {
            STATE.intervention = {
                trafficShiftTimer: 0,
                trafficShiftActive: false,
                currentShift: null,
                originalTrafficDist: null,
                randomEventTimer: 0,
                activeEvent: null,
                eventEndTime: 0,
                currentMilestoneIndex: 0,
                rpsMultiplier: 1.0,
                recentEvents: [],
                warnings: [],
                costMultiplier: 1.0,
                trafficBurstMultiplier: 1.0,
            };
            STATE.maliciousSpikeTimer = 0;
            STATE.maliciousSpikeActive = false;
            STATE.normalTrafficDist = null;
            STATE.autoRepairEnabled = saveData.autoRepairEnabled || false;
        }

        // Restore finances from the save (fall back to zeroed defaults for older
        // saves that predate finance tracking). Previously this always reset to
        // zero, so every reload wiped the player's income/expense history even
        // though saveGameState had written it to disk.
        const defaultFinances = {
            income: {
                byType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 },
                countByType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, blocked: 0 },
                requests: 0,
                blocked: 0,
                total: 0,
            },
            expenses: {
                services: 0,
                upkeep: 0,
                repairs: 0,
                autoRepair: 0,
                mitigation: 0,
                breach: 0,
                byService: { waf: 0, alb: 0, compute: 0, db: 0, s3: 0, cache: 0, sqs: 0, search: 0, replica: 0, apigw: 0, nosql: 0, cdn: 0, serverless: 0 },
                countByService: { waf: 0, alb: 0, compute: 0, db: 0, s3: 0, cache: 0, sqs: 0, search: 0, replica: 0, apigw: 0, nosql: 0, cdn: 0, serverless: 0 },
            },
        };
        STATE.finances = saveData.finances
            ? {
                income: { ...defaultFinances.income, ...saveData.finances.income },
                expenses: { ...defaultFinances.expenses, ...saveData.finances.expenses },
            }
            : defaultFinances;

        restoreServices(saveData.services);

        const autoRepairBtn = document.getElementById("auto-repair-toggle");
        if (autoRepairBtn) {
            if (STATE.autoRepairEnabled) {
                autoRepairBtn.textContent = i18n.t('upkeep_on');
                autoRepairBtn.classList.remove("text-gray-400");
                autoRepairBtn.classList.add("text-green-400");
            } else {
                autoRepairBtn.textContent = i18n.t('upkeep_off');
                autoRepairBtn.classList.remove("text-green-400");
                autoRepairBtn.classList.add("text-gray-400");
            }
        }
        updateRepairCostTable();

        restoreConnections(
            saveData.connections,
            saveData.internetConnections || []
        );

        updateScoreUI();
        document.getElementById("money-display").innerText = `$${Math.floor(
            STATE.money
        )}`;
        document.getElementById("rep-bar").style.width = `${Math.max(
            0,
            STATE.reputation
        )}%`;
        document.getElementById(
            "rps-display"
        ).innerText = `${STATE.currentRPS.toFixed(1)} ${i18n.t('req_per_sec')}`;

        const sandboxPanel = document.getElementById("sandboxPanel");
        const objectivesPanel = document.getElementById("objectivesPanel");

        if (STATE.gameMode === "sandbox") {
            if (sandboxPanel) sandboxPanel.classList.remove("hidden");
            if (objectivesPanel) objectivesPanel.classList.add("hidden");
            syncInput("budget", STATE.sandboxBudget);
            syncInput("rps", STATE.currentRPS);
            syncInput("static", (STATE.trafficDistribution.STATIC || 0) * 100);
            syncInput("read", (STATE.trafficDistribution.READ || 0) * 100);
            syncInput("write", (STATE.trafficDistribution.WRITE || 0) * 100);
            syncInput("upload", (STATE.trafficDistribution.UPLOAD || 0) * 100);
            syncInput("search", (STATE.trafficDistribution.SEARCH || 0) * 100);
            syncInput("malicious", (STATE.trafficDistribution.MALICIOUS || 0) * 100);
            syncInput("burst", STATE.burstCount);
            const upkeepBtn = document.getElementById("upkeep-toggle");
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled
                    ? i18n.t('upkeep_on_label')
                    : i18n.t('upkeep_off_label');
                upkeepBtn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
                upkeepBtn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
            }
        } else {
            if (sandboxPanel) sandboxPanel.classList.add("hidden");
            if (objectivesPanel) objectivesPanel.classList.remove("hidden");
        }

        document.getElementById("main-menu-modal").classList.add("hidden");

        if (!STATE.animationId) {
            animate(performance.now());
        }

        STATE.sound.playPlace();
    } catch (error) {
        console.error("Failed to load game:", error);
        alert(i18n.t('load_failed_corrupted'));
    }
}

function clearCurrentGame() {
    while (serviceGroup.children.length > 0) {
        serviceGroup.remove(serviceGroup.children[0]);
    }
    while (connectionGroup.children.length > 0) {
        connectionGroup.remove(connectionGroup.children[0]);
    }
    while (requestGroup.children.length > 0) {
        requestGroup.remove(requestGroup.children[0]);
    }

    STATE.services.forEach((s) => s.destroy());
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.internetNode.connections = [];
}

function restoreServices(savedServices) {
    savedServices.forEach((serviceData) => {
        const position = new THREE.Vector3(
            serviceData.position[0],
            serviceData.position[1],
            serviceData.position[2]
        );

        restoreService(serviceData, position);
    });
}

function restoreConnections(savedConnections, internetConnections) {
    // internetConnections is an array of service IDs (strings), not objects
    internetConnections.forEach((serviceId) => {
        createConnection("internet", serviceId);
    });

    savedConnections.forEach((connData) => {
        createConnection(connData.from, connData.to);
    });
}

export {
    closeSaveModal,
    loadGameState,
    onClickContinueGame,
    onSaveGameFileUpload,
    saveGameState,
    showSaveModal,
};
