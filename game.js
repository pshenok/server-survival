import { CONFIG, TRAFFIC_TYPES } from "./src/config.js";
import { STATE } from "./src/state.js";
import { i18n } from "./src/i18n.js";
import { Request } from "./src/entities/Request.js";
import { Service } from "./src/entities/Service.js";
import { SoundService } from "./src/services/SoundService.js";
// Side-effect imports: these modules install their instances on window
// (window.tutorial, window.campaign), which is how game.js reaches them.
import "./src/tutorial.js";
import "./src/campaign/campaign.js";
import { CAMPAIGN_LEVELS } from "./src/campaign/levels.js";
import { renderArchitectureSVG } from "./src/campaign/diagram.js";
import {
    flashMoney,
    getUpkeepMultiplier,
    removeRequest,
    routeRequestToEntry,
    spawnRequest,
    updateScoreUI,
} from "./src/core/actions.js";
import {
    addInterventionWarning,
    endRandomEvent,
    triggerRandomEvent,
    updateActiveEventTimer,
    updateMaliciousSpike,
    updateRandomEvents,
    updateTrafficShift,
} from "./src/core/events.js";
import {
    getAutoRepairUpkeep,
    processAutoRepair,
    toggleAutoRepair,
    updateFinancesDisplay,
    updateRepairCostTable,
} from "./src/core/economy.js";
import { checkSmartHints } from "./src/core/hints.js";
import {
    campaignNextLevel,
    campaignRetryLevel,
    campaignStartCurrentLevel,
    exitCampaignToMap,
    exitCampaignToMenu,
    hideCampaignLevelTooltip,
    openCampaignBriefing,
    openCampaignSelect,
    showCampaignLevelTooltip,
    startCampaignLevel,
} from "./src/ui/campaign-ui.js";
import {
    closeSaveModal,
    onClickContinueGame,
    onSaveGameFileUpload,
    saveGameState,
    showSaveModal,
} from "./src/persistence/save-load.js";
import {
    clearAllServices,
    createConnection,
    createService,
    deleteConnection,
    deleteObject,
    getConnectionAtPoint,
    snapToGrid,
    updateConnectionsForNode,
} from "./src/sim/topology.js";

STATE.sound = new SoundService();

// ==================== UTILITY FUNCTIONS ====================

// Format time as h:m:s, m:s, or just s depending on duration
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);

    if (hours > 0) {
        return i18n.t('time_h', { h: hours, m: mins, s: secs });
    } else if (mins > 0) {
        return i18n.t('time_m', { m: mins, s: secs });
    } else {
        return i18n.t('time_s', { s: secs });
    }
}

// ==================== BALANCE OVERHAUL FUNCTIONS ====================

function calculateTargetRPS(gameTimeSeconds) {

    const base = CONFIG.survival.baseRPS;
    const logGrowth = Math.log(1 + gameTimeSeconds / 20) * 2.2;
    const linearBoost = gameTimeSeconds * 0.008; // Adds ~0.5 RPS per minute
    let targetRPS = base + logGrowth + linearBoost;


    if (CONFIG.survival.rpsAcceleration && STATE.intervention) {
        const milestones = CONFIG.survival.rpsAcceleration.milestones;
        let multiplier = 1.0;

        for (let i = 0; i < milestones.length; i++) {
            if (gameTimeSeconds >= milestones[i].time) {
                multiplier = milestones[i].multiplier;
                if (STATE.intervention.currentMilestoneIndex < i + 1) {
                    STATE.intervention.currentMilestoneIndex = i + 1;

                    addInterventionWarning(
                        i18n.t('rps_surge_warning', { multiplier: multiplier.toFixed(1) }),
                        "danger",
                        5000
                    );
                }
            }
        }

        STATE.intervention.rpsMultiplier = multiplier;
        targetRPS *= multiplier;
    }

    return targetRPS;
}

window.handleGameState = (timeScale) => {
    if (timeScale === 0) { // pause state
        STATE.intervention.pausedEvent = STATE.intervention.activeEvent;
        STATE.intervention.remainingTime = STATE.intervention.eventEndTime - Date.now();
        // Remember which service the outage hit so resume re-disables the SAME one.
        STATE.intervention.pausedOutageServiceId = STATE.intervention.outageServiceId || null;
        endRandomEvent();
    } else if (STATE.intervention.pausedEvent) { // not paused state
        triggerRandomEvent(
            STATE.intervention.pausedEvent,
            STATE.intervention.remainingTime,
            STATE.intervention.pausedOutageServiceId
        );
        STATE.intervention.pausedEvent = null;
        STATE.intervention.remainingTime = 0;
        STATE.intervention.pausedOutageServiceId = null;
    }

    window.setTimeScale(timeScale);
}

function updateServiceHealthIndicators() {
    if (STATE.gameMode !== "survival") return;
    if (!CONFIG.survival.degradation?.enabled) return;

    const healthContainer = document.getElementById("service-health-list");
    if (!healthContainer) return;

    const criticalServices = STATE.services.filter(
        (s) => s.health < (CONFIG.survival.degradation?.criticalHealth || 30)
    );

    if (criticalServices.length === 0) {
        healthContainer.innerHTML =
            `<div class="text-green-400 text-xs">${i18n.t('all_services_healthy')}</div>`;
        return;
    }

    healthContainer.innerHTML = criticalServices
        .map(
            (s) => `
        <div class="flex justify-between items-center text-xs mb-1">
            <span class="text-red-400">${i18n.t(s.type).toUpperCase()}</span>
            <span class="text-red-300">${i18n.t('hp_display', { hp: Math.round(s.health) })}</span>
        </div>
    `
        )
        .join("");
}

// ==================== END BALANCE OVERHAUL FUNCTIONS ====================

const container = document.getElementById("canvas-container");
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

let isDraggingNode = false;
let draggedNode = null;
let dragOffset = new THREE.Vector3();
let dragStartPos = new THREE.Vector3();

const aspect = window.innerWidth / window.innerHeight;
const d = 50;
const camera = new THREE.OrthographicCamera(
    -d * aspect,
    d * aspect,
    d,
    -d,
    1,
    1000
);
const cameraTarget = new THREE.Vector3(0, 0, 0);
let isIsometric = true;
resetCamera();

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(20, 50, 20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(
    CONFIG.gridSize * CONFIG.tileSize,
    CONFIG.gridSize,
    CONFIG.colors.grid,
    CONFIG.colors.grid
);
scene.add(gridHelper);

const serviceGroup = new THREE.Group();
const connectionGroup = new THREE.Group();
const requestGroup = new THREE.Group();
scene.add(serviceGroup);
scene.add(connectionGroup);
scene.add(requestGroup);

const internetGeo = new THREE.BoxGeometry(6, 1, 10);
const internetMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    emissive: 0x00ffff,
    emissiveIntensity: 0.7,
    roughness: 0.2,
});
const internetMesh = new THREE.Mesh(internetGeo, internetMat);
internetMesh.position.copy(STATE.internetNode.position);
internetMesh.castShadow = true;
internetMesh.receiveShadow = true;
scene.add(internetMesh);
STATE.internetNode.mesh = internetMesh;

const intRingGeo = new THREE.RingGeometry(7, 7.2, 32);
const intRingMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
});
const internetRing = new THREE.Mesh(intRingGeo, intRingMat);
internetRing.rotation.x = -Math.PI / 2;
internetRing.position.set(
    internetMesh.position.x,
    -internetMesh.position.y + 0.1,
    internetMesh.position.z
);
scene.add(internetRing);
STATE.internetNode.ring = internetRing;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

function resetGame(mode = "survival") {
    STATE.sound.init();
    STATE.sound.playGameBGM();
    STATE.gameMode = mode;

    // Set budget based on mode
    if (mode === "campaign") {
        STATE.money = 0; // will be set by startCampaignLevel from level.budget
        STATE.upkeepEnabled = true;
        STATE.trafficDistribution = { STATIC: 0.3, READ: 0.2, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.2 };
        STATE.currentRPS = 1; // overridden by level.rps
    } else if (mode === "sandbox") {
        STATE.sandboxBudget = CONFIG.sandbox.defaultBudget;
        STATE.money = STATE.sandboxBudget;
        STATE.upkeepEnabled = CONFIG.sandbox.upkeepEnabled;
        STATE.trafficDistribution = {
            STATIC: CONFIG.sandbox.trafficDistribution.STATIC / 100,
            READ: CONFIG.sandbox.trafficDistribution.READ / 100,
            WRITE: CONFIG.sandbox.trafficDistribution.WRITE / 100,
            UPLOAD: CONFIG.sandbox.trafficDistribution.UPLOAD / 100,
            SEARCH: CONFIG.sandbox.trafficDistribution.SEARCH / 100,
            MALICIOUS: CONFIG.sandbox.trafficDistribution.MALICIOUS / 100,
        };
        STATE.burstCount = CONFIG.sandbox.defaultBurstCount;
        STATE.currentRPS = CONFIG.sandbox.defaultRPS;
    } else {
        STATE.money = CONFIG.survival.startBudget;
        STATE.upkeepEnabled = true;
        STATE.trafficDistribution = { ...CONFIG.survival.trafficDistribution };
        STATE.currentRPS = 0.5;
    }

    STATE.reputation = 100;
    STATE.requestsProcessed = 0;
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.score = { total: 0, storage: 0, database: 0, maliciousBlocked: 0 };
    STATE.failures = {
        STATIC: 0,
        READ: 0,
        WRITE: 0,
        UPLOAD: 0,
        SEARCH: 0,
        MALICIOUS: 0,
    };
    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    STATE.timeScale = 0;
    STATE.spawnTimer = 0;

    // Hide failures panel on reset
    const failuresPanel = document.getElementById("failures-panel");
    if (failuresPanel) failuresPanel.classList.add("hidden");

    // Initialize balance overhaul state
    STATE.elapsedGameTime = 0;
    STATE.gameStartTime = performance.now();
    STATE.maliciousSpikeTimer = 0;
    STATE.maliciousSpikeActive = false;
    STATE.normalTrafficDist = null;
    STATE.autoRepairEnabled = false;
    STATE.hints = {
      lastHintTime: 0,
      dismissedHints: new Set(),
      hintCooldown: 30,
    };

    // Initialize detailed finance tracking
    STATE.finances = {
        income: {
            byType: {
                STATIC: 0,
                READ: 0,
                WRITE: 0,
                UPLOAD: 0,
                SEARCH: 0,
            },
            countByType: {
                STATIC: 0,
                READ: 0,
                WRITE: 0,
                UPLOAD: 0,
                SEARCH: 0,
                blocked: 0,
            },
            requests: 0, // Total from all request types
            blocked: 0, // From blocking attacks
            total: 0, // Grand total income
        },
        expenses: {
            services: 0, // One-time service purchase costs
            upkeep: 0, // Running upkeep costs
            repairs: 0, // Manual repair costs
            autoRepair: 0, // Auto-repair overhead costs
            byService: {
                // Breakdown by service type (upkeep + repairs)
                waf: 0,
                alb: 0,
                compute: 0,
                db: 0,
                s3: 0,
                cache: 0,
                sqs: 0,
                search: 0,
                replica: 0,
                apigw: 0,
                nosql: 0,
                cdn: 0,
                serverless: 0,
            },
            countByService: {
                // Count of each service purchased
                waf: 0,
                alb: 0,
                compute: 0,
                db: 0,
                s3: 0,
                cache: 0,
                sqs: 0,
                search: 0,
                apigw: 0,
                nosql: 0,
                cdn: 0,
                replica: 0,
                serverless: 0,
            },
        },
    };

    // Reset auto-repair toggle UI
    const autoRepairBtn = document.getElementById("auto-repair-toggle");
    if (autoRepairBtn) {
        autoRepairBtn.textContent = i18n.t('upkeep_off');
        autoRepairBtn.classList.remove("text-green-400");
        autoRepairBtn.classList.add("text-gray-400");
    }

    // Reset repair cost table
    const repairTable = document.getElementById("repair-cost-table");
    if (repairTable) repairTable.classList.add("hidden");

    const maliciousWarning = document.getElementById("malicious-warning");
    if (maliciousWarning) maliciousWarning.remove();
    const maliciousIndicator = document.getElementById(
        "malicious-spike-indicator"
    );
    if (maliciousIndicator) maliciousIndicator.remove();

    // Clear visual elements
    while (serviceGroup.children.length > 0) {
        serviceGroup.remove(serviceGroup.children[0]);
    }
    while (connectionGroup.children.length > 0) {
        connectionGroup.remove(connectionGroup.children[0]);
    }
    while (requestGroup.children.length > 0) {
        requestGroup.remove(requestGroup.children[0]);
    }
    STATE.internetNode.connections = [];
    STATE.internetNode.position.set(
        CONFIG.internetNodeStartPos.x,
        CONFIG.internetNodeStartPos.y,
        CONFIG.internetNodeStartPos.z
    );
    STATE.internetNode.mesh.position.set(
        CONFIG.internetNodeStartPos.x,
        CONFIG.internetNodeStartPos.y,
        CONFIG.internetNodeStartPos.z
    );

    // Reset UI
    document
        .querySelectorAll(".time-btn")
        .forEach((b) => b.classList.remove("active"));
    document.getElementById("btn-pause").classList.add("active");
    // Only add pulse-green if tutorial is not active
    if (!window.tutorial?.isActive) {
        document.getElementById("btn-play").classList.add("pulse-green");
    }

    // Update UI displays
    updateScoreUI();

    // Mark game as started
    STATE.gameStarted = true;

    // Show/hide sandbox panel and objectives panel based on mode
    const sandboxPanel = document.getElementById("sandboxPanel");
    const objectivesPanel = document.getElementById("objectivesPanel");

    if (mode === "campaign") {
        if (sandboxPanel) sandboxPanel.classList.add("hidden");
        if (objectivesPanel) objectivesPanel.classList.remove("hidden");
    } else if (mode === "sandbox") {
        // Show sandbox panel, hide objectives
        if (sandboxPanel) {
            sandboxPanel.classList.remove("hidden");
            // Sync sandbox UI controls
            syncInput("budget", STATE.sandboxBudget);
            syncInput("rps", STATE.currentRPS);
            syncInput("static", STATE.trafficDistribution.STATIC * 100);
            syncInput("read", STATE.trafficDistribution.READ * 100);
            syncInput("write", STATE.trafficDistribution.WRITE * 100);
            syncInput("upload", STATE.trafficDistribution.UPLOAD * 100);
            syncInput("search", STATE.trafficDistribution.SEARCH * 100);
            syncInput("malicious", STATE.trafficDistribution.MALICIOUS * 100);
            syncInput("burst", STATE.burstCount);
            // Reset upkeep toggle button
            const upkeepBtn = document.getElementById("upkeep-toggle");
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled
                    ? i18n.t('upkeep_on_label')
                    : i18n.t('upkeep_off_label');
                upkeepBtn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
                upkeepBtn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
            }
        }
        if (objectivesPanel) objectivesPanel.classList.add("hidden");
    } else {
        // Show objectives, hide sandbox panel
        if (sandboxPanel) sandboxPanel.classList.add("hidden");
        if (objectivesPanel) objectivesPanel.classList.remove("hidden");
    }

    // Ensure loop is running
    if (!STATE.animationId) {
        animate(performance.now());
    }
}

function restartGame() {
    document.getElementById("modal").classList.add("hidden");

    // startCampaignLevel integrates important campaign level state and calls resetGame
    if (STATE.gameMode === "campaign" && STATE.campaign?.currentLevelId) {
        window.startCampaignLevel(STATE.campaign.currentLevelId);
        return;
    }
    resetGame(STATE.gameMode);
}

function retryWithSameArchitecture() {
    document.getElementById("modal").classList.add("hidden");

    // Save current architecture with indices for connection mapping
    const savedServices = STATE.services.map((s, idx) => ({
        type: s.type,
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        index: idx,
        cost: s.config.cost, // Save the cost for budget calculation
    }));

    // Calculate total cost of saved architecture
    const totalArchitectureCost = savedServices.reduce(
        (sum, s) => sum + s.cost,
        0
    );

    // Save connections with indices instead of IDs
    const savedConnections = STATE.connections.map((c) => ({
        fromIndex:
            c.from === "internet"
                ? -1
                : STATE.services.findIndex((s) => s.id === c.from),
        toIndex:
            c.to === "internet" ? -1 : STATE.services.findIndex((s) => s.id === c.to),
    }));

    // Reset game state but keep mode
    resetGame(STATE.gameMode);

    // Deduct the architecture cost from starting budget (simulate buying services)
    STATE.money -= totalArchitectureCost;
    if (STATE.finances) {
        STATE.finances.expenses.services = totalArchitectureCost;
    }

    // Rebuild services in same order (bypass cost check since we already deducted)
    savedServices.forEach((saved) => {
        const pos = new THREE.Vector3(
            saved.position.x,
            saved.position.y,
            saved.position.z
        );
        // Create service directly without cost check for retry
        const service = new Service(saved.type, pos);
        service.mesh.position.set(saved.position.x, 0, saved.position.z);
        STATE.services.push(service);
    });

    // Update repair cost table after all services are created
    updateRepairCostTable();

    // Rebuild connections using indices
    savedConnections.forEach((saved) => {
        const fromId =
            saved.fromIndex === -1 ? "internet" : STATE.services[saved.fromIndex]?.id;
        const toId =
            saved.toIndex === -1 ? "internet" : STATE.services[saved.toIndex]?.id;

        if (fromId && toId) {
            createConnection(fromId, toId);
        }
    });

    addInterventionWarning(i18n.t('arch_restored'), "info", 3000);
    STATE.sound?.playPlace();
}

// Initial setup - show menu, don't start game loop yet
setTimeout(() => {
    showMainMenu();
}, 100);

function getIntersect(clientX, clientY) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(serviceGroup.children, true);
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj.parent && obj.parent !== serviceGroup) obj = obj.parent;
        return { type: "service", id: obj.userData.id, obj: obj };
    }

    const intInter = raycaster.intersectObject(STATE.internetNode.mesh);
    if (intInter.length > 0)
        return { type: "internet", id: "internet", obj: STATE.internetNode.mesh };

    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    return { type: "ground", pos: target };
}

function showMainMenu() {
    // Ensure sound is initialized if possible (browsers might block until interaction)
    if (!STATE.sound.ctx) STATE.sound.init();
    STATE.sound.playMenuBGM();

    document.getElementById("main-menu-modal").classList.remove("hidden");
    document.getElementById("faq-modal").classList.add("hidden");
    document.getElementById("modal").classList.add("hidden");

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById("load-btn");
    const hasSave = localStorage.getItem("serverSurvivalSave") !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? "block" : "none";
    }
}

let faqSource = "menu"; // 'menu' or 'game'

window.showFAQ = (source = "menu") => {
    faqSource = source;
    // If called from button (onclick="showFAQ()"), it defaults to 'menu' effectively unless we change the HTML.
    // But wait, the button in index.html just calls showFAQ().
    // We can check if main menu is visible.

    if (
        !document.getElementById("main-menu-modal").classList.contains("hidden")
    ) {
        faqSource = "menu";
        document.getElementById("main-menu-modal").classList.add("hidden");
    } else {
        faqSource = "game";
    }

    document.getElementById("faq-modal").classList.remove("hidden");
};

window.closeFAQ = () => {
    document.getElementById("faq-modal").classList.add("hidden");
    if (faqSource === "menu") {
        document.getElementById("main-menu-modal").classList.remove("hidden");
    }
};

window.togglePanel = (contentId, iconId) => {
    const content = document.getElementById(contentId);
    const icon = document.getElementById(iconId);
    if (content) {
        content.classList.toggle('hidden');
        if (icon) {
            icon.innerText = content.classList.contains('hidden') ? '▼' : '▲';
        }
    }
};

window.toggleFailureModal = () => {
    const card = document.getElementById("modal-card");
    const restore = document.getElementById("modal-restore");
    if (!card || !restore) return;
    const minimized = card.classList.toggle("hidden");
    restore.classList.toggle("hidden", !minimized);
};

window.startGame = () => {
    document.getElementById("main-menu-modal").classList.add("hidden");
    resetGame();

    if (window.tutorial) {
        setTimeout(() => {
            window.tutorial.start();
        }, 500);
    }
};

window.startSandbox = () => {
    document.getElementById("main-menu-modal").classList.add("hidden");
    resetGame("sandbox");
};

// ===================== CAMPAIGN MODE =====================
// Campaign UI (level select map, briefing/debrief modals, level tooltips,
// toolbar gating, objectives panel, level start/navigation) moved to
// src/ui/campaign-ui.js (#155 PR 6). The window-exposed handlers are
// re-assigned in the ESM-boundary block below.

// The build/wire/demolish cluster (createService, restoreService,
// createConnection, deleteConnection, getConnectionAtPoint, deleteObject,
// updateConnectionsForNode, snapToGrid, clearAllServices) moved to
// src/sim/topology.js (#155 PR 7).

window.setTool = (t) => {
    STATE.activeTool = t;
    STATE.selectedNodeId = null;
    document
        .querySelectorAll(".service-btn")
        .forEach((b) => b.classList.remove("active"));
    document.getElementById(`tool-${t}`).classList.add("active");
    new Audio("assets/sounds/click-9.mp3").play();
};

window.setTimeScale = (s) => {
    STATE.timeScale = s;
    document
        .querySelectorAll(".time-btn")
        .forEach((b) => b.classList.remove("active"));

    if (s === 0) {
        document.getElementById("btn-pause").classList.add("active");
        // Only add pulse-green if tutorial is not active
        if (!window.tutorial?.isActive) {
            document.getElementById("btn-play").classList.add("pulse-green");
        }
    } else if (s === 1) {
        document.getElementById("btn-play").classList.add("active");
        document.getElementById("btn-play").classList.remove("pulse-green");

        // Notify tutorial when game starts
        if (window.tutorial?.isActive) {
            window.tutorial.onAction("start_game");
        }
    } else if (s === 3) {
        document.getElementById("btn-fast").classList.add("active");
        document.getElementById("btn-play").classList.remove("pulse-green");
    }
};

// Separate music / SFX controls (#112). Muted channel = red toolbar button,
// pulsing menu button, dimmed icon — same affordances the old combined
// mute button used.
function syncSoundButtons() {
    const channels = [
        { muted: STATE.sound.musicMuted, tool: "tool-music", toolIcon: "music-icon", menu: "menu-music-btn", menuIcon: "menu-music-icon" },
        { muted: STATE.sound.sfxMuted, tool: "tool-sfx", toolIcon: "sfx-icon", menu: "menu-sfx-btn", menuIcon: "menu-sfx-icon" },
    ];
    for (const ch of channels) {
        const toolBtn = document.getElementById(ch.tool);
        const menuBtn = document.getElementById(ch.menu);
        for (const iconId of [ch.toolIcon, ch.menuIcon]) {
            document.getElementById(iconId)?.classList.toggle("opacity-40", ch.muted);
        }
        if (toolBtn) {
            toolBtn.classList.toggle("bg-red-900", ch.muted);
            toolBtn.classList.toggle("pulse-green", ch.muted);
        }
        if (menuBtn) menuBtn.classList.toggle("pulse-green", ch.muted);
    }
}

window.toggleMusic = () => {
    STATE.sound.init();
    STATE.sound.toggleMusic();
    syncSoundButtons();
};

window.toggleSfx = () => {
    STATE.sound.init();
    STATE.sound.toggleSfx();
    syncSoundButtons();
};

// Reflect persisted prefs on load
syncSoundButtons();

let currentZoom = 1;
const minZoom = 0.5;
const maxZoom = 3.0;
const zoomSpeed = 0.001;

container.addEventListener("wheel", (e) => {
    e.preventDefault();

    // Zoom logic
    const zoomDelta = e.deltaY * -zoomSpeed;
    const newZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom + zoomDelta));

    if (newZoom !== currentZoom) {
        currentZoom = newZoom;

        // For OrthographicCamera, zoom is applied via dividing the frustum or using the zoom property
        // Three.js OrthographicCamera has a .zoom property
        camera.zoom = currentZoom;
        camera.updateProjectionMatrix();
    }
}, { passive: false });

// Upgrade Indicator Logic
// Upgrade Indicator Logic
let hoveredUpgradeService = null;
let hideUpgradeTimer = null;
const upgradeIndicator = document.getElementById("upgrade-indicator");
const upgradeCostEl = document.getElementById("upgrade-cost");

if (upgradeIndicator) {
    upgradeIndicator.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent map click
        if (hoveredUpgradeService) {
            hoveredUpgradeService.upgrade();

            // Immediate UI update
            const tiers = CONFIG.services[hoveredUpgradeService.type].tiers;
            if (hoveredUpgradeService.tier < tiers.length) {
                const nextCost = tiers[hoveredUpgradeService.tier].cost;
                upgradeCostEl.textContent = `$${nextCost}`;

                if (STATE.money < nextCost) {
                    upgradeCostEl.classList.remove("bg-green-600", "border-green-400");
                    upgradeCostEl.classList.add("bg-red-600", "border-red-400");
                } else {
                    upgradeCostEl.classList.remove("bg-red-600", "border-red-400");
                    upgradeCostEl.classList.add("bg-green-600", "border-green-400");
                }
            } else {
                // Max tier reached - hide immediately
                hoveredUpgradeService = null;
                upgradeIndicator.classList.add("hidden");
                if (hideUpgradeTimer) {
                    clearTimeout(hideUpgradeTimer);
                    hideUpgradeTimer = null;
                }
            }
        }
    });

    // Prevent hiding when hovering the indicator itself
    upgradeIndicator.addEventListener("mouseenter", () => {
        if (hideUpgradeTimer) {
            clearTimeout(hideUpgradeTimer);
            hideUpgradeTimer = null;
        }
    });

    // Start hide timer when leaving indicator
    upgradeIndicator.addEventListener("mouseleave", () => {
        if (hoveredUpgradeService) {
            hideUpgradeTimer = setTimeout(() => {
                hoveredUpgradeService = null;
                upgradeIndicator.classList.add("hidden");
                hideUpgradeTimer = null;
            }, 300);
        }
    });
}

// Keyboard navigation
const keysPressed = {};

window.addEventListener("keydown", (e) => {
    keysPressed[e.key] = true;
});

window.addEventListener("keyup", (e) => {
    keysPressed[e.key] = false;
});

// Clear all held keys when the window loses focus — otherwise a keyup missed
// during an alt-tab / focus switch leaves the key "stuck" and the camera pans
// forever until that key is pressed and released again.
window.addEventListener("blur", () => {
    for (const k in keysPressed) keysPressed[k] = false;
});

container.addEventListener("contextmenu", (e) => e.preventDefault());

container.addEventListener("mousedown", (e) => {
    if (!STATE.isRunning) return;

    if (e.button === 2 || e.button === 1) {
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        container.style.cursor = "grabbing";
        e.preventDefault();
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    if (STATE.activeTool === "select") {
        const i = getIntersect(e.clientX, e.clientY);
        if (i.type === "service") {
            const svc = STATE.services.find((s) => s.id === i.id);
            // Use criticalHealth from config for consistency
            const criticalHealth = CONFIG.survival.degradation?.criticalHealth || 40;
            if (svc && svc.health < criticalHealth && CONFIG.survival.degradation?.enabled) {
                // Repair on click when damaged below critical threshold
                if (svc.repair()) {
                    addInterventionWarning(
                        i18n.t('repaired_msg', { type: i18n.t(svc.type) }),
                        "info",
                        2000
                    );
                    return;
                }
            }
            draggedNode = svc;
        } else if (i.type === "internet") {
            draggedNode = STATE.internetNode;
        }
        if (draggedNode) {
            isDraggingNode = true;
            dragStartPos.copy(draggedNode.position);
            const hit = getIntersect(e.clientX, e.clientY);
            if (hit.pos) {
                dragOffset.copy(draggedNode.position).sub(hit.pos);
            }
            container.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }
    } else if (STATE.activeTool === "delete" && i.type === "service")
        deleteObject(i.id);
    else if (STATE.activeTool === "unlink") {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            deleteConnection(conn.from, conn.to);
        } else {
            new Audio("assets/sounds/click-9.mp3").play();
        }
    } else if (
        STATE.activeTool === "connect" &&
        (i.type === "service" || i.type === "internet")
    ) {
        if (STATE.selectedNodeId) {
            createConnection(STATE.selectedNodeId, i.id);
            STATE.selectedNodeId = null;
        } else {
            STATE.selectedNodeId = i.id;
            new Audio("assets/sounds/click-5.mp3").play();
        }
    } else if (
        ["waf", "alb", "lambda", "db", "nosql", "s3", "sqs", "cache", "cdn", "apigw", "search", "replica", "serverless"].includes(
            STATE.activeTool
        )
    ) {
        // Handle upgrades for compute, db, cache, apigw, and nosql
        if (
            (STATE.activeTool === "lambda" && i.type === "service") ||
            (STATE.activeTool === "db" && i.type === "service") ||
            (STATE.activeTool === "cache" && i.type === "service") ||
            (STATE.activeTool === "apigw" && i.type === "service") ||
            (STATE.activeTool === "nosql" && i.type === "service") ||
            (STATE.activeTool === "search" && i.type === "service") ||
            (STATE.activeTool === "replica" && i.type === "service")
        ) {
            const svc = STATE.services.find((s) => s.id === i.id);
            if (
                svc &&
                ((STATE.activeTool === "lambda" && svc.type === "compute") ||
                    (STATE.activeTool === "db" && svc.type === "db") ||
                    (STATE.activeTool === "cache" && svc.type === "cache") ||
                    (STATE.activeTool === "apigw" && svc.type === "apigw") ||
                    (STATE.activeTool === "nosql" && svc.type === "nosql") ||
                    (STATE.activeTool === "search" && svc.type === "search") ||
                    (STATE.activeTool === "replica" && svc.type === "replica"))
            ) {
                svc.upgrade();
                return;
            }
        }
        if (i.type === "ground") {
            const typeMap = {
                waf: "waf",
                alb: "alb",
                lambda: "compute",
                db: "db",
                nosql: "nosql",
                s3: "s3",
                sqs: "sqs",
                cache: "cache",
                apigw: "apigw",
                cdn: "cdn",
                search: "search",
                replica: "replica",
                serverless: "serverless",
            };

            const serviceType = typeMap[STATE.activeTool];
            if (serviceType) {
                createService(serviceType, snapToGrid(i.pos));
            }
        }
    }
});

// Last known pointer position over the canvas — lets the animate loop
// refresh the hover tooltip in real time while the mouse is stationary (#173).
let lastPointerPos = null;
let tooltipRefreshAcc = 0;
container.addEventListener("mouseleave", () => {
    lastPointerPos = null;
});

container.addEventListener("mousemove", (e) => {
    lastPointerPos = { x: e.clientX, y: e.clientY };
    if (isDraggingNode && draggedNode) {
        const hit = getIntersect(e.clientX, e.clientY);
        if (hit.pos) {
            const newPos = hit.pos.clone().add(dragOffset);
            newPos.y = 0;

            draggedNode.position.copy(newPos);

            if (draggedNode === STATE.internetNode) {
                STATE.internetNode.mesh.position.x = newPos.x;
                STATE.internetNode.mesh.position.z = newPos.z;
                STATE.internetNode.ring.position.x = newPos.x;
                STATE.internetNode.ring.position.z = newPos.z;
            } else if (draggedNode.mesh) {
                draggedNode.mesh.position.x = newPos.x;
                draggedNode.mesh.position.z = newPos.z;
            }

            updateConnectionsForNode(draggedNode.id);

            container.style.cursor = "grabbing";
        }
        return;
    }
    if (isPanning) {
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;

        const panX =
            ((-dx * (camera.right - camera.left)) / window.innerWidth) * panSpeed;
        const panY =
            ((dy * (camera.top - camera.bottom)) / window.innerHeight) * panSpeed;

        if (isIsometric) {
            camera.position.x += panX;
            camera.position.z += panY;
            cameraTarget.x += panX;
            cameraTarget.z += panY;
            camera.lookAt(cameraTarget);
        } else {
            camera.position.x += panX;
            camera.position.z += panY;
            camera.lookAt(camera.position.x, 0, camera.position.z);
        }
        camera.updateProjectionMatrix();
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        document.getElementById("tooltip").style.display = "none";
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    const t = document.getElementById("tooltip");
    let cursor = "default";

    // Reset all connection colors first
    STATE.connections.forEach((c) => {
        if (c.mesh && c.mesh.material) {
            c.mesh.material.color.setHex(CONFIG.colors.line);
        }
    });

    // Handle unlink tool hover
    if (STATE.activeTool === "unlink") {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            cursor = "pointer";
            // Highlight the connection in red
            if (conn.mesh && conn.mesh.material) {
                conn.mesh.material.color.setHex(0xff4444);
            }

            // Get source and target names for tooltip
            const from =
                conn.from === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === conn.from);
            const to =
                conn.to === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === conn.to);
            const fromName =
                conn.from === "internet" ? i18n.t('internet') : from?.config?.name || i18n.t('unknown');
            const toName =
                conn.to === "internet" ? i18n.t('internet') : to?.config?.name || i18n.t('unknown');

            showTooltip(
                e.clientX + 15,
                e.clientY + 15,
                `<strong class="text-orange-400">${i18n.t('remove_link')}</strong><br>
                <span class="text-gray-300">${fromName}</span> → <span class="text-gray-300">${toName}</span><br>
                <span class="text-red-400 text-xs">${i18n.t('click_to_remove')}</span>`
            );
        } else {
            t.style.display = "none";
        }
        container.style.cursor = cursor;
        return;
    }

    if (i.type === "service") {
        const s = STATE.services.find((s) => s.id === i.id);
        if (s) {
            const load = s.processing.length / s.config.capacity;
            let loadColor =
                load > 0.8
                    ? "text-red-400"
                    : load > 0.4
                        ? "text-yellow-400"
                        : "text-green-400";

            // Base tooltip content with static info
            let content = `<strong class="text-blue-300">${i18n.t(s.type)}</strong>`;
            if (s.tier)
                content += ` <span class="text-xs text-yellow-400">T${s.tier}</span>`;

            // Show health percentage
            const healthColor =
                s.health < 40
                    ? "text-red-400"
                    : s.health < 70
                        ? "text-yellow-400"
                        : "text-green-400";
            content += ` <span class="${healthColor}">${Math.round(
                s.health
            )}%</span>`;

            // Add static description and upkeep if available
            if (s.config.tooltip) {
                content += `<br><span class="text-xs text-gray-400">${i18n.t(s.type + '_desc')}</span>`;
                content += `<br><span class="text-xs text-gray-500">${i18n.t('upkeep_label')} <span class="text-gray-300">${i18n.t(s.config.tooltip.upkeep.toLowerCase().replace(' ', '_'))}</span></span>`;
            }

            content += `<div class="mt-1 border-t border-gray-700 pt-1">`;

            // Service-specific dynamic stats
            if (s.type === "apigw") {
                const rateLimit = s.config.rateLimit || 20;
                const rateUsed = s.rateCounter || 0;
                const rateColor = rateUsed > rateLimit ? "text-red-400" : rateUsed > rateLimit * 0.7 ? "text-yellow-400" : "text-green-400";
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                ${i18n.t('rate_limit_label')} <span class="${rateColor}">${rateUsed}/${rateLimit} RPS</span>`;
            } else if (s.type === "cache") {
                const hitRate = Math.round((s.config.cacheHitRate || 0.35) * 100);
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                ${i18n.t('hit_rate_label')} <span class="text-green-400">${hitRate}%</span>`;
            } else if (s.type === "sqs") {
                const maxQ = s.config.maxQueueSize || 200;
                const fillPercent = Math.round((s.queue.length / maxQ) * 100);
                const status =
                    fillPercent > 80 ? i18n.t('status_critical') : fillPercent > 50 ? i18n.t('status_busy') : i18n.t('status_healthy');
                const statusColor =
                    fillPercent > 80
                        ? "text-red-400"
                        : fillPercent > 50
                            ? "text-yellow-400"
                            : "text-green-400";
                content += `${i18n.t('buffered_label')} <span class="${loadColor}">${s.queue.length}/${maxQ}</span><br>
                ${i18n.t('processing_label')} ${s.processing.length}/${s.config.capacity}<br>
                ${i18n.t('status_label')} <span class="${statusColor}">${status}</span>`;
            } else {
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;
            }
            content += `</div>`;

            // Show upgrade option for upgradeable services
            if (
                (STATE.activeTool === "lambda" && s.type === "compute") ||
                (STATE.activeTool === "db" && s.type === "db") ||
                (STATE.activeTool === "cache" && s.type === "cache") ||
                (STATE.activeTool === "apigw" && s.type === "apigw") ||
                (STATE.activeTool === "nosql" && s.type === "nosql") ||
                (STATE.activeTool === "search" && s.type === "search") ||
                (STATE.activeTool === "replica" && s.type === "replica")
            ) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = "pointer";
                    const nextCost = tiers[s.tier].cost;
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-green-300 text-xs font-bold">${i18n.t('upgrade_label')} $${nextCost}</span></div>`;
                    if (s.mesh.material.emissive)
                        s.mesh.material.emissive.setHex(0x333333);
                } else {
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-gray-500 text-xs">${i18n.t('max_tier')}</span></div>`;
                }
            }

            // SHOW UPGRADE INDICATOR (Green Arrow)
            if (["compute", "db", "cache", "apigw", "nosql", "search", "replica"].includes(s.type)) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    // Clear any pending hide timer since we are hovering a valid service
                    if (hideUpgradeTimer) {
                        clearTimeout(hideUpgradeTimer);
                        hideUpgradeTimer = null;
                    }

                    hoveredUpgradeService = s;
                    const nextCost = tiers[s.tier].cost;

                    // Project 3D position to 2D screen
                    const pos = s.mesh.position.clone();
                    pos.y += 3; // Offset above service
                    pos.project(camera);

                    const x = (pos.x * .5 + .5) * container.clientWidth;
                    const y = (pos.y * -.5 + .5) * container.clientHeight;

                    if (upgradeIndicator && upgradeCostEl) {
                        upgradeIndicator.style.left = `${x}px`;
                        upgradeIndicator.style.top = `${y}px`;
                        upgradeIndicator.classList.remove("hidden");
                        upgradeCostEl.textContent = `$${nextCost}`;

                        // Color code cost
                        if (STATE.money < nextCost) {
                            upgradeCostEl.classList.remove("bg-green-600", "border-green-400");
                            upgradeCostEl.classList.add("bg-red-600", "border-red-400");
                        } else {
                            upgradeCostEl.classList.remove("bg-red-600", "border-red-400");
                            upgradeCostEl.classList.add("bg-green-600", "border-green-400");
                        }
                    }
                } else {
                    // Max tier
                    if (hoveredUpgradeService === s) {
                        hoveredUpgradeService = null;
                        if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                    }
                }
            } else {
                // Not an upgradeable service or different type - trigger hide
                if (hoveredUpgradeService && !hideUpgradeTimer) {
                    hideUpgradeTimer = setTimeout(() => {
                        hoveredUpgradeService = null;
                        if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                        hideUpgradeTimer = null;
                    }, 300);
                }
            }

            showTooltip(e.clientX + 15, e.clientY + 15, content);

            // Reset previous highlights
            STATE.services.forEach((svc) => {
                if (svc !== s && svc.mesh.material.emissive)
                    svc.mesh.material.emissive.setHex(0x000000);
            });
        }
    } else {
        t.style.display = "none";
        // Reset highlights when not hovering service
        STATE.services.forEach((svc) => {
            if (svc.mesh.material.emissive)
                svc.mesh.material.emissive.setHex(0x000000);
        });

        // Hide upgrade indicator if visible (with delay)
        if (hoveredUpgradeService && !hideUpgradeTimer) {
            hideUpgradeTimer = setTimeout(() => {
                hoveredUpgradeService = null;
                if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                hideUpgradeTimer = null;
            }, 300);
        }
    }

    container.style.cursor = cursor;
});

        // clear failure list
        document.getElementById('clear-all').addEventListener('click',()=>{
            STATE.failures.MALICIOUS=0;
            STATE.failures.STATIC=0;
            STATE.failures.READ=0;
            STATE.failures.WRITE=0;
            STATE.failures.UPLOAD=0;
            STATE.failures.SEARCH=0;
            // when click on clear button, update ui immediately
            document.getElementById('failures-panel').classList.add('hidden');
            document.getElementById('failures-total').textContent = `0 ${i18n.t('total')}`;
        })

// Helper function for showing tooltips
function showTooltip(x, y, html) {
    const t = document.getElementById("tooltip");
    t.style.display = "block";
    t.style.left = x + "px";
    t.style.top = y + "px";
    t.innerHTML = html;
}

// Setup UI tooltips
function setupUITooltips() {
    const tools = ["waf", "apigw", "sqs", "alb", "lambda", "db", "nosql", "cache", "s3", "cdn", "search", "replica", "serverless"];
    tools.forEach((toolId) => {
        const btn = document.getElementById(`tool-${toolId}`);
        if (!btn) return;

        // Map tool ID to config service key
        const serviceKey = toolId === "lambda" ? "compute" : toolId;
        const config = CONFIG.services[serviceKey];

        if (config && config.tooltip) {
            btn.addEventListener("mousemove", (e) => {
                const content = `
                    <strong class="text-blue-300">${i18n.t(serviceKey)}</strong> <span class="text-green-400">$${config.cost}</span><br>
                    <span class="text-xs text-gray-400">${i18n.t(serviceKey + '_desc')}</span><br>
                    <div class="mt-1 pt-1 border-t border-gray-700 flex justify-between text-xs">
                        <span class="text-gray-500">${i18n.t('upkeep_label')} <span class="text-gray-300">${i18n.t(config.tooltip.upkeep.toLowerCase().replace(' ', '_'))}</span></span>
                    </div>
                `;
                showTooltip(e.clientX + 15, e.clientY - 100, content); // Show above the button
            });

            btn.addEventListener("mouseleave", () => {
                document.getElementById("tooltip").style.display = "none";
            });
        }
    });
}

// Call setup
setupUITooltips();

container.addEventListener("mouseup", (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = "default";
    }
    if (isDraggingNode && draggedNode) {
        isDraggingNode = false;

        let snapped = snapToGrid(draggedNode.position);

        // Reject a drop onto a tile already occupied by another service —
        // otherwise the two overlap and whichever mesh the raycaster hits first
        // makes the other permanently unselectable (can't delete/upgrade it).
        const occupied = STATE.services.some(
            (s) => s !== draggedNode && s.position.distanceTo(snapped) < 1
        );
        if (occupied) {
            snapped = snapToGrid(dragStartPos);
        }

        draggedNode.position.copy(snapped);

        if (draggedNode === STATE.internetNode) {
            STATE.internetNode.mesh.position.x = snapped.x;
            STATE.internetNode.mesh.position.z = snapped.z;
            STATE.internetNode.ring.position.x = snapped.x;
            STATE.internetNode.ring.position.z = snapped.z;
        } else if (draggedNode.mesh) {
            draggedNode.mesh.position.x = snapped.x;
            draggedNode.mesh.position.z = snapped.z;
        }

        updateConnectionsForNode(draggedNode.id);

        draggedNode = null;
        container.style.cursor = "default";
        return;
    }
});

function animate(time) {
    STATE.animationId = requestAnimationFrame(animate);
    if (!STATE.isRunning) return;

    // Limit dt to prevent huge jumps when tab loses focus
    // (requestAnimationFrame pauses when tab is inactive)
    const rawDt = (time - STATE.lastTime) / 1000;
    const clampedDt = Math.min(rawDt, 0.1); // Max 100ms per frame
    const dt = clampedDt * STATE.timeScale;
    STATE.lastTime = time;
    STATE.elapsedGameTime += dt;
    if (window.campaign?.active) window.campaign.tick(dt);

    // Keyboard panning
    const moveSpeed = 50 * clampedDt; // Use unscaled time so we can move while paused
    // If zoomed in (zoom > 1), we might want to move slower, or just keep it constant world space
    // Constant world space is usually better.
    // Three.js OrthographicCamera zoom does not affect world coordinates directly, 
    // so moving camera.position by X moves it by X world units regardless of zoom.

    // Adjust speed based on zoom? Often players expect faster panning when zoomed out.
    // Let's try constant world speed first, maybe scale by 1/zoom if needed.
    const effectivePanSpeed = moveSpeed / camera.zoom;

    if (keysPressed["ArrowUp"] || keysPressed["w"] || keysPressed["W"]) {
        // Move camera target and position "up" (-Z in isometric-ish view? No, usually up is -Z in 3D)
        // Check pan logic: panY adds to Z. So Up should probably correspond to -Z.
        // Let's match the mouse panning logic:
        // dy (mouse down) -> panY (positive) -> z += panY.
        // So moving mouse down moves camera +Z.
        // Thus Up key should move camera -Z.
        if (isIsometric) {
            camera.position.x -= effectivePanSpeed;
            camera.position.z -= effectivePanSpeed;
            cameraTarget.x -= effectivePanSpeed;
            cameraTarget.z -= effectivePanSpeed;
        } else {
            camera.position.z -= effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowDown"] || keysPressed["s"] || keysPressed["S"]) {
        if (isIsometric) {
            camera.position.x += effectivePanSpeed;
            camera.position.z += effectivePanSpeed;
            cameraTarget.x += effectivePanSpeed;
            cameraTarget.z += effectivePanSpeed;
        } else {
            camera.position.z += effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowLeft"] || keysPressed["a"] || keysPressed["A"]) {
        // Mouse: dx (right) -> panX (negative) -> x += panX.
        // So moving mouse right moves camera -X.
        // Thus Right key should move camera +X? No wait.
        // If I drag mouse right, I expect world to move right? Or camera to move left?
        // Standard RTS: Mouse right -> Camera moves right -> World moves left.
        // Wait, the pan logic: dx = e.clientX - lastMouseX. If I move mouse right, dx > 0.
        // panX = (-dx...) -> panX < 0.
        // camera.x += panX (so camera decreases X).
        // So dragging mouse right moves camera LEFT. This is "drag the world" style.
        // For KEYS, pressing Right should move camera RIGHT.
        // So Right key should contain the OPPOSITE sign of panX for right-drag.
        // mouse right -> camera left.
        // key right -> camera right (x increasing).

        if (isIsometric) {
            camera.position.x -= effectivePanSpeed;
            camera.position.z += effectivePanSpeed;
            cameraTarget.x -= effectivePanSpeed;
            cameraTarget.z += effectivePanSpeed;
        } else {
            camera.position.x -= effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowRight"] || keysPressed["d"] || keysPressed["D"]) {
        if (isIsometric) {
            camera.position.x += effectivePanSpeed;
            camera.position.z -= effectivePanSpeed;
            cameraTarget.x += effectivePanSpeed;
            cameraTarget.z -= effectivePanSpeed;
        } else {
            camera.position.x += effectivePanSpeed;
        }
    }

    if (isIsometric && (keysPressed["ArrowUp"] || keysPressed["w"] || keysPressed["W"] ||
        keysPressed["ArrowDown"] || keysPressed["s"] || keysPressed["S"] ||
        keysPressed["ArrowLeft"] || keysPressed["a"] || keysPressed["A"] ||
        keysPressed["ArrowRight"] || keysPressed["d"] || keysPressed["D"])) {
        camera.lookAt(cameraTarget);
    } else if (!isIsometric) {
        // Simple top down
        // already handled by pos update
    }

    STATE.services.forEach((s) => s.update(dt));
    STATE.requests.forEach((r) => r.update(dt));

    STATE.spawnTimer += dt;
    // Apply traffic burst multiplier from random events
    const effectiveRPS =
        STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
    if (effectiveRPS > 0) {
        const spawnInterval = 1 / effectiveRPS;
        // Spawn multiple requests if timeScale causes large dt jumps
        // This ensures correct spawn rate even when fast forwarding
        while (STATE.spawnTimer >= spawnInterval) {
            STATE.spawnTimer -= spawnInterval;
            spawnRequest();
        }
        // Only ramp up in survival mode - use logarithmic growth
        if (STATE.gameMode === "survival") {
            const gameTime = STATE.elapsedGameTime;
            const targetRPS = calculateTargetRPS(gameTime);

            // Smooth transition to target
            STATE.currentRPS += (targetRPS - STATE.currentRPS) * 0.01;
            STATE.currentRPS = Math.min(STATE.currentRPS, CONFIG.survival.maxRPS);
        }
    }

    updateMaliciousSpike(dt);

    // Intervention mechanics updates
    updateTrafficShift(dt);
    updateRandomEvents(dt);
    updateServiceHealthIndicators();
    updateActiveEventTimer();
    processAutoRepair(dt);
    updateFinancesDisplay();
    checkSmartHints();

    // Live tooltip refresh (#173): while the pointer sits still over a service,
    // replay the last mousemove at ~4 Hz so the tooltip's load/queue/rate stats
    // keep updating. Reuses the full hover pipeline — zero duplicated logic.
    tooltipRefreshAcc += clampedDt;
    if (tooltipRefreshAcc >= 0.25) {
        tooltipRefreshAcc = 0;
        if (lastPointerPos && !isDraggingNode && !isPanning) {
            const tooltipEl = document.getElementById("tooltip");
            if (tooltipEl && tooltipEl.style.display === "block") {
                container.dispatchEvent(new MouseEvent("mousemove", {
                    clientX: lastPointerPos.x,
                    clientY: lastPointerPos.y,
                }));
            }
        }
    }

    document.getElementById("money-display").innerText = `$${Math.floor(
        STATE.money
    )}`;

    const baseUpkeep = STATE.services.reduce(
        (sum, s) => sum + s.config.upkeep / 60,
        0
    );
    const multiplier =
        typeof getUpkeepMultiplier === "function" ? getUpkeepMultiplier() : 1.0;
    const autoRepairCost =
        typeof getAutoRepairUpkeep === "function" ? getAutoRepairUpkeep() : 0;
    const totalUpkeep = baseUpkeep * multiplier + autoRepairCost;

    // Deduct auto-repair cost and track it
    if (autoRepairCost > 0 && STATE.upkeepEnabled) {
        const cost = autoRepairCost * dt;
        STATE.money -= cost;
        if (STATE.finances) STATE.finances.expenses.autoRepair += cost;
    }

    const upkeepDisplay = document.getElementById("upkeep-display");
    if (upkeepDisplay) {
        if (autoRepairCost > 0) {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s ${i18n.t('plus_repair')}`;
            upkeepDisplay.className = "text-orange-400 font-mono";
        } else if (multiplier > 1.05) {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(
                2
            )}/s (×${multiplier.toFixed(2)})`;
            upkeepDisplay.className = "text-red-400 font-mono";
        } else {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s`;
            upkeepDisplay.className = "text-red-400 font-mono";
        }
    }

    if (STATE.gameMode === "survival") {
        const staticEl = document.getElementById("mix-static");
        const readEl = document.getElementById("mix-read");
        const writeEl = document.getElementById("mix-write");
        const uploadEl = document.getElementById("mix-upload");
        const searchEl = document.getElementById("mix-search");
        const maliciousEl = document.getElementById("mix-malicious");

        if (staticEl)
            staticEl.textContent =
                Math.round((STATE.trafficDistribution.STATIC || 0) * 100) + "%";
        if (readEl)
            readEl.textContent =
                Math.round((STATE.trafficDistribution.READ || 0) * 100) + "%";
        if (writeEl)
            writeEl.textContent =
                Math.round((STATE.trafficDistribution.WRITE || 0) * 100) + "%";
        if (uploadEl)
            uploadEl.textContent =
                Math.round((STATE.trafficDistribution.UPLOAD || 0) * 100) + "%";
        if (searchEl)
            searchEl.textContent =
                Math.round((STATE.trafficDistribution.SEARCH || 0) * 100) + "%";
        if (maliciousEl && !STATE.maliciousSpikeActive)
            maliciousEl.textContent =
                Math.round((STATE.trafficDistribution.MALICIOUS || 0) * 100) + "%";
    }

    STATE.reputation = Math.min(100, STATE.reputation);
    document.getElementById("rep-bar").style.width = `${Math.max(
        0,
        STATE.reputation
    )}%`;
    document.getElementById("rep-display").textContent = `${Math.round(
        Math.max(0, STATE.reputation)
    )}%`;
    document.getElementById(
        "rps-display"
    ).innerText = `${STATE.currentRPS.toFixed(1)} ${i18n.t('req_per_sec')}`;

    // Update elapsed time
    const elapsedEl = document.getElementById("elapsed-time");
    if (elapsedEl) {
        elapsedEl.textContent = formatTime(STATE.elapsedGameTime);
    }

    // Update next RPS milestone (survival mode only)
    const rpsNextEl = document.getElementById("rps-next");
    const rpsCountdownEl = document.getElementById("rps-countdown");
    const rpsMilestoneRow = document.getElementById("rps-milestone-row");

    if (STATE.gameMode === "survival" && rpsMilestoneRow) {
        rpsMilestoneRow.style.display = "flex";

        // Show next RPS acceleration milestone instead of arbitrary integer
        const milestones = CONFIG.survival.rpsAcceleration?.milestones || [];
        const currentTime = STATE.elapsedGameTime;

        // Find next upcoming milestone
        let nextMilestone = null;
        for (const m of milestones) {
            if (m.time > currentTime) {
                nextMilestone = m;
                break;
            }
        }

        if (rpsNextEl && rpsCountdownEl) {
            if (nextMilestone) {
                const timeRemaining = Math.max(0, nextMilestone.time - currentTime);

                rpsNextEl.textContent = `×${nextMilestone.multiplier.toFixed(1)}`;
                rpsCountdownEl.textContent = formatTime(timeRemaining);
            } else {
                // All milestones reached
                rpsNextEl.textContent = i18n.t('max');
                rpsCountdownEl.textContent = "--";
            }
        }
    } else if (rpsMilestoneRow) {
        rpsMilestoneRow.style.display = "none";
    }

    // Update failures panel with table format
    const totalFailures = Object.values(STATE.failures).reduce(
        (a, b) => a + b,
        0
    );
    const failuresPanel = document.getElementById("failures-panel");
    const points = CONFIG.survival.SCORE_POINTS;
    if (totalFailures > 0 && failuresPanel) {
        failuresPanel.classList.remove("hidden");
        document.getElementById(
            "failures-total"
        ).textContent = `${totalFailures} ${i18n.t('total')}`;

        // Update counts
        document.getElementById("fail-malicious").textContent =
            STATE.failures.MALICIOUS;
        document.getElementById("fail-static").textContent = STATE.failures.STATIC;
        document.getElementById("fail-read").textContent = STATE.failures.READ;
        document.getElementById("fail-write").textContent = STATE.failures.WRITE;
        document.getElementById("fail-upload").textContent = STATE.failures.UPLOAD;
        document.getElementById("fail-search").textContent = STATE.failures.SEARCH;

        // Update reputation loss (malicious = -8, others = -2)
        document.getElementById("fail-malicious-rep").textContent =
            STATE.failures.MALICIOUS * Math.abs(points.MALICIOUS_PASSED_REPUTATION);
        document.getElementById("fail-static-rep").textContent =
            STATE.failures.STATIC * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-read-rep").textContent =
            STATE.failures.READ * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-write-rep").textContent =
            STATE.failures.WRITE * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-upload-rep").textContent =
            STATE.failures.UPLOAD * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-search-rep").textContent =
            STATE.failures.SEARCH * Math.abs(points.FAIL_REPUTATION);

        // Hide rows with 0 failures
        document.getElementById("fail-row-malicious").style.display =
            STATE.failures.MALICIOUS > 0 ? "" : "none";
        document.getElementById("fail-row-static").style.display =
            STATE.failures.STATIC > 0 ? "" : "none";
        document.getElementById("fail-row-read").style.display =
            STATE.failures.READ > 0 ? "" : "none";
        document.getElementById("fail-row-write").style.display =
            STATE.failures.WRITE > 0 ? "" : "none";
        document.getElementById("fail-row-upload").style.display =
            STATE.failures.UPLOAD > 0 ? "" : "none";
        document.getElementById("fail-row-search").style.display =
            STATE.failures.SEARCH > 0 ? "" : "none";
    }

    if (STATE.internetNode.ring) {
        if (STATE.selectedNodeId === "internet") {
            STATE.internetNode.ring.material.opacity = 1.0;
        } else {
            STATE.internetNode.ring.material.opacity = 0.2;
        }
    }

    // Game over only in survival mode
    if (
        STATE.gameMode === "survival" &&
        (STATE.reputation <= 0 || STATE.money <= -1000)
    ) {
        STATE.isRunning = false;

        // Determine failure reason and generate tips
        const failureAnalysis = analyzeFailure();

        document.getElementById("modal-title").innerText = i18n.t('system_failure');
        document.getElementById("modal-title").classList.add("text-red-500");
        document.getElementById("modal-desc").innerHTML = `
            <div class="text-left space-y-3">
                <div class="text-center text-2xl font-bold text-yellow-400 mb-2">${i18n.t('final_score', { score: STATE.score.total })}</div>
                <div class="text-center text-sm text-gray-400 mb-4">${i18n.t('survived_time', { time: formatTime(STATE.elapsedGameTime || 0) })}</div>
                
                <div class="bg-red-900/30 border border-red-500/50 rounded-lg p-3">
                    <div class="text-red-400 font-bold text-sm uppercase mb-1">${i18n.t('failure_reason')}</div>
                    <div class="text-white">${failureAnalysis.reason}</div>
                </div>
                
                <div class="bg-blue-900/30 border border-blue-500/50 rounded-lg p-3">
                    <div class="text-blue-400 font-bold text-sm uppercase mb-1">${i18n.t('analysis')}</div>
                    <div class="text-gray-300 text-sm">${failureAnalysis.description}</div>
                </div>
                
                <div class="bg-green-900/30 border border-green-500/50 rounded-lg p-3">
                    <div class="text-green-400 font-bold text-sm uppercase mb-1">${i18n.t('tips_title')}</div>
                    <ul class="text-gray-300 text-sm list-disc list-inside space-y-1">
                        ${failureAnalysis.tips
                .map((tip) => `<li>${tip}</li>`)
                .join("")}
                    </ul>
                </div>
            </div>
        `;
        document.getElementById("modal").classList.remove("hidden");
        // show the results card , now has an id
        document.getElementById("modal-card").classList.remove("hidden");
        // hide the "show results" floating button , new element
        document.getElementById("modal-restore").classList.add("hidden");
        STATE.sound.playGameOver();
    }

    renderer.render(scene, camera);
}

// Analyze why the player failed and generate helpful tips
function analyzeFailure() {
    const result = {
        reason: "",
        description: "",
        tips: [],
    };

    // Determine primary failure reason
    if (STATE.reputation <= 0) {
        result.reason = i18n.t('reason_reputation');

        // Check what caused reputation loss
        const totalFailures = Object.values(STATE.failures).reduce(
            (a, b) => a + b,
            0
        );
        const maliciousFailures = STATE.failures.MALICIOUS || 0;

        if (maliciousFailures > totalFailures * 0.3) {
            result.description = i18n.t('reason_malicious', { count: maliciousFailures });
            result.tips.push(i18n.t('tip_waf'));
            result.tips.push(i18n.t('tip_multiple_waf'));
        } else {
            const worstFailure = Object.entries(STATE.failures)
                .filter(([k]) => k !== "MALICIOUS")
                .sort((a, b) => b[1] - a[1])[0];

            if (worstFailure && worstFailure[1] > 0) {
                result.description = i18n.t('reason_failed_type', { 
                    type: i18n.t('traffic_' + worstFailure[0].toLowerCase()), 
                    count: worstFailure[1] 
                });

                if (worstFailure[0] === "STATIC" || worstFailure[0] === "UPLOAD") {
                    result.tips.push(i18n.t('tip_s3'));
                } else {
                    result.tips.push(i18n.t('tip_db'));
                    result.tips.push(i18n.t('tip_cache'));
                }
            } else {
                result.description = i18n.t('desc_reputation');
            }
        }

        result.tips.push(i18n.t('tip_sqs'));
        result.tips.push(i18n.t('tip_repair'));
    } else if (STATE.money <= -1000) {
        result.reason = i18n.t('reason_bankruptcy');
        result.description = i18n.t('desc_bankruptcy', { money: Math.floor(STATE.money) });

        // Analyze spending
        if (STATE.finances) {
            const upkeepRatio =
                STATE.finances.expenses.upkeep / (STATE.finances.income.total || 1);
            if (upkeepRatio > 0.8) {
                result.tips.push(i18n.t('tip_upkeep_high'));
                result.tips.push(i18n.t('tip_scale_slow'));
            }

            if (STATE.finances.expenses.repairs > STATE.finances.income.total * 0.2) {
                result.tips.push(i18n.t('tip_auto_repair'));
            }
        }

        result.tips.push(i18n.t('tip_scale_slow'));
        result.tips.push(i18n.t('tip_cache'));
        result.tips.push(i18n.t('tip_s3'));
    }

    // Add general tips based on game state
    if (STATE.services.length < 3) {
        result.tips.push(i18n.t('tip_complete_pipeline'));
    }

    if (!STATE.services.some((s) => s.type === "cache")) {
        result.tips.push(i18n.t('tip_add_cache'));
    }

    if (!STATE.services.some((s) => s.type === "apigw")) {
        result.tips.push(i18n.t('tip_apigw'));
    }

    if (!STATE.services.some((s) => s.type === "nosql") &&
        (STATE.failures.READ > 5 || STATE.failures.WRITE > 5)) {
        result.tips.push(i18n.t('tip_nosql'));
    }

    if (!STATE.services.some((s) => s.type === "search") &&
        STATE.failures.SEARCH > 5) {
        result.tips.push(i18n.t('tip_search_engine'));
    }

    if (!STATE.services.some((s) => s.type === "replica") &&
        STATE.failures.READ > 10) {
        result.tips.push(i18n.t('tip_read_replica'));
    }

    // Limit tips to 4
    result.tips = result.tips.slice(0, 4);

    return result;
}

window.addEventListener("resize", () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -d * aspect;
    camera.right = d * aspect;
    camera.top = d;
    camera.bottom = -d;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        // Toggle main menu
        const menu = document.getElementById("main-menu-modal");
        if (menu.classList.contains("hidden")) {
            openMainMenu();
        } else if (STATE.gameStarted && STATE.isRunning) {
            window.resumeGame();
        }
        return;
    }
    if (event.key === "H" || event.key === "h") {
        document.getElementById("statsPanel").classList.toggle("hidden");
        document.getElementById("detailsPanel").classList.toggle("hidden");
        document.getElementById("objectivesPanel").classList.toggle("hidden");
    }
    if (event.key === "R" || event.key === "r") {
        resetCamera();
    }
    if (event.key === "T" || event.key === "t") {
        toggleView();
    }
});

function toggleView() {
    isIsometric = !isIsometric;
    resetCamera();
}

function resetCamera() {
    if (isIsometric) {
        camera.position.set(40, 40, 40);
        cameraTarget.set(0, 0, 0);
        camera.lookAt(cameraTarget);
    } else {
        camera.position.set(0, 50, 0);
        camera.lookAt(0, 0, 0);
    }
}

// ==================== SANDBOX MODE FUNCTIONS ====================

function syncInput(name, value) {
    const slider = document.getElementById(`${name}-slider`);
    const input = document.getElementById(`${name}-input`);
    if (slider) slider.value = value;
    if (input) input.value = value;
}

window.setSandboxBudget = (value) => {
    const v = Math.max(0, parseInt(value) || 0);
    STATE.sandboxBudget = v;
    STATE.money = v;
    syncInput("budget", v);
};

window.resetBudget = () => {
    STATE.money = STATE.sandboxBudget;
};

window.setSandboxRPS = (value) => {
    const v = Math.max(0, parseFloat(value) || 0);
    STATE.currentRPS = v;
    syncInput("rps", v);
};

window.setTrafficMix = (type, value) => {
    const v = Math.max(0, Math.min(100, parseFloat(value) || 0));
    STATE.trafficDistribution[type] = v / 100;
    syncInput(type.toLowerCase(), v);
};

window.setBurstCount = (value) => {
    const v = Math.max(1, parseInt(value) || 10);
    STATE.burstCount = v;
    syncInput("burst", v);
};

window.spawnBurst = (type) => {
    for (let i = 0; i < STATE.burstCount; i++) {
        setTimeout(() => {
            const req = new Request(type);
            STATE.requests.push(req);
            // Same entry routing as regular spawns — STATIC bursts prefer CDN,
            // everything falls back WAF → APIGW → any live entry (#175).
            routeRequestToEntry(req, type);
        }, i * 30);
    }
};

window.toggleUpkeep = () => {
    STATE.upkeepEnabled = !STATE.upkeepEnabled;
    const btn = document.getElementById("upkeep-toggle");
    if (btn) {
        btn.textContent = STATE.upkeepEnabled ? i18n.t('upkeep_on_label') : i18n.t('upkeep_off_label');
        btn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
        btn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
    }
};

// clearAllServices moved to src/sim/topology.js (#155 PR 7); the
// window-exposed handler is re-assigned in the ESM-boundary block below.

// ==================== MENU FUNCTIONS ====================

function openMainMenu() {
    // Store current time scale and pause
    STATE.previousTimeScale = STATE.timeScale;
    window.setTimeScale(0);

    // Hide tutorial while menu is open
    if (window.tutorial?.isActive) {
        window.tutorial.hide();
    }

    // Show resume button if game is active
    const resumeBtn = document.getElementById("resume-btn");
    if (resumeBtn) {
        if (STATE.gameStarted && STATE.isRunning) {
            resumeBtn.classList.remove("hidden");
        } else {
            resumeBtn.classList.add("hidden");
        }
    }

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById("load-btn");
    const hasSave = localStorage.getItem("serverSurvivalSave") !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? "block" : "none";
    }

    // Show main menu
    document.getElementById("main-menu-modal").classList.remove("hidden");
    STATE.sound.playMenuBGM();
}

window.resumeGame = () => {
    // Hide main menu, keep game paused
    document.getElementById("main-menu-modal").classList.add("hidden");
    STATE.sound.playGameBGM();

    // Restore tutorial if active
    if (window.tutorial?.isActive) {
        window.tutorial.show();
    }
};

// ==================== SAVE/LOAD FUNCTIONS ====================
// Moved to src/persistence/save-load.js (#155 PR 6); the window-exposed
// handlers are re-assigned in the ESM-boundary block below.

// ==================== ESM BOUNDARY (#155 PR 2) ====================

// Under classic scripts these three function declarations were implicit
// globals; index.html inline on*= handlers still call them, so they must be
// put on window explicitly now that module scope no longer leaks.
window.restartGame = restartGame;
window.retryWithSameArchitecture = retryWithSameArchitecture;
window.toggleAutoRepair = toggleAutoRepair;

// #155 PR 6: the campaign-UI and save/load handlers now live in
// src/ui/campaign-ui.js and src/persistence/save-load.js; index.html inline
// on*= handlers (and generated onclick strings) still resolve them on window,
// so re-expose the imported bindings here — the single window boundary.
window.openCampaignSelect = openCampaignSelect;
window.exitCampaignToMenu = exitCampaignToMenu;
window.exitCampaignToMap = exitCampaignToMap;
window.showCampaignLevelTooltip = showCampaignLevelTooltip;
window.hideCampaignLevelTooltip = hideCampaignLevelTooltip;
window.openCampaignBriefing = openCampaignBriefing;
window.campaignStartCurrentLevel = campaignStartCurrentLevel;
window.startCampaignLevel = startCampaignLevel;
window.campaignRetryLevel = campaignRetryLevel;
window.campaignNextLevel = campaignNextLevel;
window.showSaveModal = showSaveModal;
window.closeSaveModal = closeSaveModal;
window.saveGameState = saveGameState;
window.onSaveGameFileUpload = onSaveGameFileUpload;
window.onClickContinueGame = onClickContinueGame;

// #155 PR 7: the build/wire/demolish cluster now lives in src/sim/topology.js;
// index.html's sandbox "Clear All" button still resolves this on window.
window.clearAllServices = clearAllServices;

// The generated smart-hint dismiss button (showSmartHint) embeds an inline
// onclick that touches STATE.hints — inline handlers resolve against the
// global scope, and the old top-level `const STATE` was a global lexical
// binding. Keep STATE reachable from there.
window.STATE = STATE;

// Runtime cross-module surface: Request.js, Service.js, core/events.js,
// ui/campaign-ui.js, persistence/save-load.js and sim/topology.js import
// these (cyclically — safe, they are hoisted declarations / top-level consts
// only dereferenced after evaluation).
export {
    animate,
    camera,
    connectionGroup,
    formatTime,
    mouse,
    plane,
    raycaster,
    requestGroup,
    resetGame,
    serviceGroup,
    syncInput,
};
