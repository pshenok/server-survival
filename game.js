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
    updateInferenceStaging,
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
import { upkeepInstanceFactor } from "./src/sim/autoscaling.js";
import { resetResilience } from "./src/sim/circuit-breaker.js";
import { recomputePower } from "./src/sim/power.js";
import { getRollingGoodput, metricsTick, resetMetrics } from "./src/core/metrics.js";
import { renderMetricsPanel } from "./src/ui/metrics-panel.js";
// Educational failure badges (#156): the floating "why did this fail" labels.
// game.js owns their scene group (badgeGroup, below), ticks them once per
// frame next to metricsTick, and clears them on reset.
import {
    clearFailureBadges,
    syncFailureBadgeButton,
    tickFailureBadges,
    toggleFailureBadges,
} from "./src/ui/failure-badges.js";
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
// Input layer (#155 PR 8): importing the module registers every pointer/
// keyboard/camera listener as a side effect. It evaluates before this file's
// body runs — safe, because no events can fire until the whole module graph
// finishes evaluating, and the handlers only dereference game.js's exports
// at event time. animate() reads the input state via these live bindings.
import {
    container,
    isDraggingNode,
    isIsometric,
    isPanning,
    keysPressed,
    lastPointerPos,
    orbitCamera,
    panCameraScreen,
    resetCamera,
} from "./src/input/handlers.js";
// Share Architecture (#157): the share modal, PNG export, and the ?arch=
// link. consumeSharedArchParam/rebuildSharedArch are called from the boot
// path below; the modal handlers are re-exposed in the ESM-boundary block.
import {
    closeShareModal,
    consumeSharedArchParam,
    copyShareLink,
    downloadArchitecturePNG,
    rebuildSharedArch,
    showShareModal,
} from "./src/ui/share.js";
// Service palette (toolbar categories, 2026-07-24): index.html ships only the
// empty shell, so the tab strip and the active category's buttons are drawn
// from here. The call sits in the body, not in toolbar.js's own evaluation,
// so that handlers.js is fully evaluated first — it listens for the
// "toolbarRendered" event to re-wire the button tooltips.
import { applyToolbarGating, renderToolbar } from "./src/ui/toolbar.js";
// Achievements (#158): the engine observes the sim (never mutates it). Wired
// here at the boundary: init once, onSessionStart from resetGame, tick(dt)
// from animate, and the Trophies panel handlers re-exposed on window below.
import { achievements } from "./src/achievements/achievements.js";
import { closeTrophies, showTrophies } from "./src/achievements/ui.js";

STATE.sound = new SoundService();

renderToolbar();

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

// Frame-rate-independent exponential smoothing toward a target. Calibrated so
// one 60 fps frame closes exactly 1% of the gap — the constant this replaces —
// which keeps the shipped ramp feel identical on a 60 Hz machine while making
// it identical on every OTHER machine too. Exported so the ramp can be pinned
// by tests instead of re-derived in them.
function smoothTowardsRPS(current, target, dt) {
    return current + (target - current) * (1 - Math.pow(0.99, dt * 60));
}

function calculateTargetRPS(gameTimeSeconds) {

    const base = CONFIG.survival.baseRPS;
    const logGrowth = Math.log(1 + gameTimeSeconds / 20) * 2.2;
    const linearBoost = gameTimeSeconds * 0.008; // Adds ~0.5 RPS per minute
    let targetRPS = base + logGrowth + linearBoost;


    if (CONFIG.survival.rpsAcceleration && STATE.intervention) {
        const milestones = CONFIG.survival.rpsAcceleration.milestones;
        const multiplier = rpsMilestoneMultiplier(gameTimeSeconds, milestones);

        // The WARNINGS still fire at the original milestone times — the player's
        // sense of "a surge just landed" is unchanged; only the arrival is
        // spread out. Announcing a threshold the traffic reached gradually is
        // the point: it tells them the next tier of pressure is now in effect.
        for (let i = 0; i < milestones.length; i++) {
            if (
                gameTimeSeconds >= milestones[i].time &&
                STATE.intervention.currentMilestoneIndex < i + 1
            ) {
                STATE.intervention.currentMilestoneIndex = i + 1;
                addInterventionWarning(
                    i18n.t('rps_surge_warning', {
                        multiplier: milestones[i].multiplier.toFixed(1),
                    }),
                    "danger",
                    5000
                );
            }
        }

        STATE.intervention.rpsMultiplier = multiplier;
        targetRPS *= multiplier;
    }

    return targetRPS;
}

// The acceleration multiplier, interpolated in time instead of stepped (#74).
//
// The milestones used to be a step function: at t=180 the multiplier jumped
// 1.6 -> 2.0 and target RPS went from 12.0 to 15.0 in ONE frame, which the
// smoother then chased down in under two seconds. The measured readable band
// on the reference board is about 20% wide in arrival rate, so a 25% step
// vaults clean over it — at exactly the three-minute mark #74 complains about.
//
// Interpolating from 1.0 at t=0 (rather than holding 1.0 until the first
// milestone) is deliberate: leaving that first 1.0 -> 1.3 edge in place would
// keep one 30% discontinuity, and the whole point is that the ramp is
// continuous everywhere. The endpoints are unchanged — every milestone time
// still has exactly its milestone multiplier — so the difficulty envelope is
// the same curve, just without the cliffs between its sample points.
function rpsMilestoneMultiplier(t, milestones) {
    if (!milestones || !milestones.length) return 1.0;
    if (t <= 0) return 1.0;

    const first = milestones[0];
    if (t < first.time) {
        return 1.0 + (first.multiplier - 1.0) * (t / first.time);
    }
    for (let i = 0; i < milestones.length - 1; i++) {
        const a = milestones[i];
        const b = milestones[i + 1];
        if (t < b.time) {
            const span = b.time - a.time;
            // A zero-width span would be a config typo; treat it as a step
            // rather than dividing by zero.
            if (span <= 0) return b.multiplier;
            return a.multiplier + (b.multiplier - a.multiplier) * ((t - a.time) / span);
        }
    }
    // Past the last milestone the multiplier holds, as before.
    return milestones[milestones.length - 1].multiplier;
}

window.handleGameState = (timeScale) => {
    if (timeScale === 0) { // pause state
        // Guard INSIDE the branch, not on it: pausing an already-paused game
        // must not overwrite the parked event with null (endRandomEvent has
        // already cleared activeEvent), but it must not fall through to the
        // resume branch either — that would restart the parked event while
        // the game is still paused.
        if (STATE.intervention.activeEvent) {
            STATE.intervention.pausedEvent = STATE.intervention.activeEvent;
            STATE.intervention.remainingTime =
                (STATE.intervention.eventEndTime - STATE.elapsedGameTime) * 1000;
            // Remember which service the outage hit so resume re-disables the SAME one.
            STATE.intervention.pausedOutageServiceId = STATE.intervention.outageServiceId || null;
            endRandomEvent();
        }
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

// The canvas container element and the whole input layer (pointer/keyboard/
// camera handlers with their drag/pan/zoom/tooltip state) moved to
// src/input/handlers.js (#155 PR 8).
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

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
// Failure badges (#156) get their own group: a badge must outlive the node
// that dropped the request, and sprite scale must not inherit a node's.
const badgeGroup = new THREE.Group();
scene.add(serviceGroup);
scene.add(connectionGroup);
scene.add(requestGroup);
scene.add(badgeGroup);

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

function resetGame(mode = "survival") {
    STATE.sound.init();
    STATE.sound.playGameBGM();
    STATE.gameMode = mode;

    // Campaign gating is applied when a level starts but nothing ever cleared
    // it, so leaving a level for sandbox or survival left most of the toolbar
    // dead (reproduced on the pre-toolbar build too — this is an old bug, not
    // a side effect of the category tabs). Any non-campaign mode starts ungated.
    if (mode !== "campaign") applyToolbarGating([], []);

    // ...and the campaign CONTROLLER stops with it. `active` is set by
    // loadLevel() and cleared by exit(), which only exitCampaignToMap()
    // called — so every other way out of a level (Escape to the pause menu,
    // then New Game or Sandbox; or the menu's own campaign exit) left the
    // controller running. animate() then kept calling campaign.tick(dt) on
    // the NEW run: it repainted the abandoned level's objectives over the
    // HUD, fired that level's scripted bursts into a survival board, and
    // graded the new run against the old level's conditions.
    //
    // The worst of that is not cosmetic. resetGame hands the new run
    // reputation 100 while STATE.campaign.completedByType still holds the
    // completions banked during the campaign attempt, and those two together
    // are the win gate: a level abandoned in failure was scored a WIN — three
    // stars, persisted, next level unlocked — on a sandbox board with no
    // services on it at all. Levels with a timeoutSec did the mirror of it,
    // ending a later run in a LOSE debrief and freezing its clock.
    //
    // startCampaignLevel() calls resetGame("campaign") before loadLevel(),
    // so gating on the mode is what keeps this from shutting down the run it
    // is about to start.
    if (mode !== "campaign") window.campaign?.exit();

    // ...and a half-finished lesson stops with the run it belonged to. See
    // Tutorial.abandon: this does NOT mark the tutorial completed, so the
    // offer survives for a player who wandered off mid-lesson.
    // window.startTutorial calls resetGame() BEFORE tutorial.reset() and
    // start(), so re-arming still works.
    window.tutorial?.abandon();

    // Set budget based on mode
    if (mode === "campaign") {
        STATE.money = 0; // will be set by startCampaignLevel from level.budget
        STATE.upkeepEnabled = true;
        STATE.trafficDistribution = { STATIC: 0.3, READ: 0.2, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.2, INFERENCE: 0 };
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
            INFERENCE: CONFIG.sandbox.trafficDistribution.INFERENCE / 100,
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
    STATE.lateCompletions = 0;
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
        INFERENCE: 0,
    };
    STATE.failuresByReason = {};
    STATE.failuresDismissedAt = 0;
    // AI Wave session counter (#87) + the power grid derivation over the
    // (now empty) service list.
    STATE.inference = { expired: 0 };
    recomputePower();
    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    STATE.timeScale = 0;
    STATE.spawnTimer = 0;

    // Hide failures panel on reset
    const failuresPanel = document.getElementById("failures-panel");
    if (failuresPanel) failuresPanel.classList.add("hidden");

    // A random event that is still live belongs to the run that just ended:
    // end it BEFORE the clock rewinds. Its deadline is a game-time stamp
    // (#242), so a stranded event would otherwise be measured against a clock
    // restarting at 0 and hold its effects — doubled costs, tripled traffic,
    // a disabled node — for the whole of the next run. endRandomEvent()
    // reverses the effects; the timers below stop a half-elapsed interval
    // from firing the next event early into a fresh session.
    if (STATE.intervention) {
        endRandomEvent();
        STATE.intervention.eventEndTime = 0;
        STATE.intervention.randomEventTimer = 0;
        STATE.intervention.pausedEvent = null;
        STATE.intervention.remainingTime = 0;
        STATE.intervention.pausedOutageServiceId = null;
        STATE.intervention.costMultiplier = 1.0;
        STATE.intervention.trafficBurstMultiplier = 1.0;
        STATE.intervention.currentMilestoneIndex = 0;
        STATE.intervention.rpsMultiplier = 1.0;
        // A traffic shift belongs to its run just as much as a random event
        // does, and four of its fields used to outlive one. The worst is
        // originalTrafficDist: endTrafficShift() restores it, so a stranded
        // one does not merely misfire once — it becomes the NEXT run's
        // baseline, and every later shift in that run returns to the old
        // run's mix instead of this one's.
        //
        // Cleared directly rather than through endTrafficShift(), which would
        // restore that stale mix over the distribution this function has
        // already chosen for the new mode a few lines above.
        STATE.intervention.trafficShiftActive = false;
        STATE.intervention.trafficShiftTimer = 0;
        STATE.intervention.originalTrafficDist = null;
        STATE.intervention.currentShift = null;
    }

    // Initialize balance overhaul state
    STATE.elapsedGameTime = 0;
    STATE.gameStartTime = performance.now();
    STATE.maliciousSpikeTimer = 0;
    STATE.maliciousSpikeActive = false;
    // The pointer belongs to the run too. activeTool is the sharper of the
    // two: the click handler places with
    // createService(PLACEMENT_TYPE_MAP[STATE.activeTool]) and never consults
    // the toolbar gate, which only decides which BUTTONS render. So a tool
    // armed in one run stayed armed into the next, and a campaign level that
    // allows only s3 could be handed a GPU by a player who never saw a GPU
    // button — the ban is on the toolbar, and the toolbar was bypassed.
    //
    // selectedNodeId is the quieter one: ids restart with the board, so a
    // stale id either points at nothing or, worse, at a DIFFERENT node in
    // the new run, which then renders as selected with nobody having
    // clicked it — and in "connect" mode is one click from a wire the
    // player did not draw.
    STATE.activeTool = "select";
    STATE.selectedNodeId = null;
    // A run that ended while the main menu was open left its own speed here,
    // and Resume restores it: a new run could start at the old run's 2x.
    STATE.previousTimeScale = 1;
    STATE.normalTrafficDist = null;
    STATE.autoRepairEnabled = false;
    resetMetrics();
    resetResilience();
    // Dispose the floating failure labels (#156) — a badge anchored to a
    // node from the previous run is both meaningless and a texture leak.
    clearFailureBadges();
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
                monitor: 0,
                dlq: 0,
                pubsub: 0,
                auth: 0,
                scheduler: 0,
                notify: 0,
                container: 0,
                stream: 0,
                dns: 0,
                warehouse: 0,
                gpu: 0,
                infgw: 0,
                power: 0,
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
                monitor: 0,
                dlq: 0,
                pubsub: 0,
                auth: 0,
                scheduler: 0,
                notify: 0,
                container: 0,
                stream: 0,
                dns: 0,
                warehouse: 0,
                gpu: 0,
                infgw: 0,
                power: 0,
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
            syncInput("inference", (STATE.trafficDistribution.INFERENCE || 0) * 100);
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

    // Achievements (#158): session boundary. Clears armed/edge state and
    // captures the live-play baselines the poll defs measure deltas from —
    // called AFTER the state above is reset so the baselines read the fresh
    // board (elapsed 0, failures 0).
    achievements.onSessionStart();

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

    // THE GRID HAS TO BE TOLD. This path pushes straight into STATE.services
    // to skip the cost check, so it also skips createService's
    // recomputePower() — and resetGame above ran that on the EMPTY board.
    // Without this the HUD reads 0/8 kW for a room really drawing 12 on a 14
    // kW grid, and both gates that read STATE.power rather than re-deriving
    // it go with it: the next GPU is placed free past the cap, and the
    // Substation holding the fleet up can be scrapped for its refund.
    recomputePower();

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

// Initial setup - show menu, don't start game loop yet. Exception (#157): a
// valid ?arch= share link skips the menu entirely and drops the player into
// Sandbox with the shared build already placed — that's the whole point of
// the link. The param is stripped from the URL bar either way, so reloads
// don't re-trigger and saves don't confuse.
setTimeout(() => {
    // Achievements (#158) boot wiring — in this deferred block, NOT the
    // module body: game.js's body can run mid-graph through the established
    // import cycles (achievements → circuit-breaker → metrics → events →
    // game.js), where the engine's own bindings are still in TDZ. By the
    // time this timer fires the whole graph has evaluated.
    // init records the starting locale (polyglot counts it) and paints the
    // main-menu Trophies badge from the persisted store.
    achievements.init(i18n.currentLocale);
    // Locale hook: i18n.setLocale is the single locale-change site, but
    // i18n.js must stay a leaf module (see the note there), so the engine
    // subscribes HERE — at the window boundary — to the localeChanged event
    // that setLocale already dispatches synchronously.
    window.addEventListener("localeChanged", (e) =>
        achievements.onLocaleChange(e.detail)
    );

    const sharedArch = consumeSharedArchParam();
    if (sharedArch) {
        document.getElementById("main-menu-modal").classList.add("hidden");
        resetGame("sandbox");
        rebuildSharedArch(sharedArch);
    } else {
        showMainMenu();
    }
}, 100);

// getIntersect (canvas raycast picking) moved to src/input/handlers.js
// (#155 PR 8).

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

    // The tutorial has always written a "completed" flag and NEVER read it
    // (#263): isCompleted() existed but had no callers, so a veteran got the
    // whole 17-step walkthrough on every single survival start. Read it now.
    // `startTutorial()` below is the deliberate way back in.
    if (window.tutorial && !window.tutorial.isCompleted()) {
        setTimeout(() => {
            window.tutorial.start();
        }, 500);
    }
};

// Replay the tutorial on demand (#263). Respecting the completed flag without
// this would REMOVE the tutorial from anyone who has seen it once — the fix
// has to give the door back, not just close it.
window.startTutorial = () => {
    document.getElementById("main-menu-modal")?.classList.add("hidden");
    resetGame();
    if (window.tutorial) {
        window.tutorial.reset();
        setTimeout(() => window.tutorial.start(), 500);
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
syncFailureBadgeButton();

// The wheel-zoom, upgrade-indicator, keyboard-navigation, and mouse
// drag/pan/connect/place listeners (with their state) moved to
// src/input/handlers.js (#155 PR 8).

// Accumulator for the ~4 Hz live tooltip refresh in animate (#173); the
// paired lastPointerPos tracking moved to src/input/handlers.js (#155 PR 8).
let tooltipRefreshAcc = 0;

        // clear failure list
        document.getElementById('clear-all').addEventListener('click', () => {
            // DISMISSES THE PANEL. It used to zero STATE.failures, which is
            // not this button's to rewrite: four PRIMARY campaign objectives
            // grade on that tally (fail_under_5_pct, fail_under_10_pct,
            // no_leaks, fail_under_12_pct) plus eight bonuses, and the run
            // report counts it too. One click turned a leaked level 11 into a
            // clean win — the level whose entire subject is having the
            // Firewall up BEFORE the wave, replaced by hiding the evidence.
            //
            // The achievements engine was already hardened against exactly
            // this button (see the clean-window watermark in
            // src/achievements/achievements.js) — the campaign evaluator and
            // the debrief never were. Recording a view preference instead of
            // erasing history fixes all three at once, and the panel is still
            // dismissable: it comes back when something NEW fails.
            STATE.failuresDismissedAt = Object.values(STATE.failures)
                .reduce((a, n) => a + (typeof n === "number" ? n : 0), 0);
            document.getElementById('failures-panel').classList.add('hidden');
        })

// showTooltip / setupUITooltips moved to src/input/handlers.js (#155 PR 8).

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

    // Keyboard panning + orbit. The direction math lives in
    // src/input/handlers.js (panCameraScreen / orbitCamera) so the pan axes
    // rotate with the camera azimuth (#231) — after a 90° orbit "up" is still
    // "away from the camera". This block only reads held keys and picks
    // magnitudes: unscaled time so the camera moves while paused, divided by
    // zoom so the on-screen speed stays constant.
    const moveSpeed = 50 * clampedDt;
    const effectivePanSpeed = moveSpeed / camera.zoom;
    // Historical speeds, preserved exactly: the isometric key-pan stepped one
    // unit on BOTH world axes per frame (a √2-long diagonal), top-down one.
    const keyPanStep = effectivePanSpeed * (isIsometric ? Math.SQRT2 : 1);
    if (keysPressed["ArrowUp"] || keysPressed["w"] || keysPressed["W"]) {
        panCameraScreen(0, keyPanStep);
    }
    if (keysPressed["ArrowDown"] || keysPressed["s"] || keysPressed["S"]) {
        panCameraScreen(0, -keyPanStep);
    }
    if (keysPressed["ArrowLeft"] || keysPressed["a"] || keysPressed["A"]) {
        panCameraScreen(-keyPanStep, 0);
    }
    if (keysPressed["ArrowRight"] || keysPressed["d"] || keysPressed["D"]) {
        panCameraScreen(keyPanStep, 0);
    }
    // Q/E orbit the view around the target (#231). Angular speed — no zoom
    // scaling — and a no-op in top-down, which has no azimuth.
    const orbitStep = 1.8 * clampedDt; // ~103°/s — brisk but trackable
    if (keysPressed["q"] || keysPressed["Q"]) orbitCamera(-orbitStep);
    if (keysPressed["e"] || keysPressed["E"]) orbitCamera(orbitStep);

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

            // Smooth transition to target. The per-FRAME 0.01 this replaces
            // made the whole ramp frame-rate dependent: a 144 Hz machine
            // approached the target 2.4x faster in game time than a 60 Hz
            // one, so two players at the same elapsed time faced different
            // traffic. Exponential smoothing over dt is identical at 60 fps
            // (0.99^1 = 0.01 of the gap) and now frame-rate independent —
            // and because dt carries timeScale, fast-forward advances the
            // ramp by game time rather than by frames drawn.
            STATE.currentRPS = smoothTowardsRPS(STATE.currentRPS, targetRPS, dt);
            STATE.currentRPS = Math.min(STATE.currentRPS, CONFIG.survival.maxRPS);
        }
    }

    updateMaliciousSpike(dt);

    // AI Wave (#87): stage the survival INFERENCE base share (0 → 3% → 10%).
    // Pure re-derivation over game time + GPU ownership, so no dt needed.
    updateInferenceStaging();

    // Intervention mechanics updates
    updateTrafficShift(dt);
    updateRandomEvents(dt);
    updateServiceHealthIndicators();
    updateActiveEventTimer();
    processAutoRepair(dt);
    updateFinancesDisplay();
    checkSmartHints();

    // Observability (#194): sample service metrics (2 Hz game time, frozen
    // while paused), then refresh the METRICS panel — cheap by construction,
    // it only rebuilds rows on service-set changes and redraws on new samples.
    metricsTick(dt);
    renderMetricsPanel();

    // Failure badges (#156): age and fade the floating labels. Same
    // game-scaled dt as everything else, so they freeze with the board.
    tickFailureBadges(dt);

    // Achievements (#158): 2 Hz poll cadence on game time (frozen while
    // paused, the #183 timer class); skips entirely once every poll def is
    // unlocked. Observation only — never mutates sim state.
    achievements.tick(dt);

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

    // ASG fleets (#195) bill per instance, so the HUD figure has to use the
    // same factor Service.update() charges with.
    const baseUpkeep = STATE.services.reduce(
        (sum, s) => sum + (s.config.upkeep / 60) * upkeepInstanceFactor(s),
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
        if (!STATE.upkeepEnabled) {
            // SANDBOX SHIPS WITH UPKEEP OFF, and Service.update() charges only
            // inside `if (STATE.upkeepEnabled)`. The display was the one site
            // that never asked — the auto-repair deduction ten lines up does —
            // so every sandbox session showed a red "Upkeep Cost -$X.XX/s"
            // that is never charged, next to a panel reporting $0 upkeep and a
            // button reading "Upkeep: OFF". A learner budgeting a topology
            // read a running cost off the HUD that the simulation does not
            // apply.
            upkeepDisplay.innerText = `-$0.00/s ${i18n.t('upkeep_off_label')}`;
            upkeepDisplay.className = "text-gray-500 font-mono";
        } else if (autoRepairCost > 0) {
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
        const inferenceEl = document.getElementById("mix-inference");
        if (inferenceEl)
            inferenceEl.textContent =
                Math.round((STATE.trafficDistribution.INFERENCE || 0) * 100) + "%";
    }

    // Power HUD badge (#87): kW used/cap, shown only once a GPU or a
    // Substation exists — before the AI wave touches a board, the grid is
    // invisible.
    const powerRow = document.getElementById("power-row");
    if (powerRow) {
        const powered = STATE.services.some(
            (s) => s.type === "gpu" || s.type === "power"
        );
        powerRow.classList.toggle("hidden", !powered);
        if (powered) {
            const powerEl = document.getElementById("power-display");
            if (powerEl) {
                powerEl.textContent = i18n.t("power_hud", {
                    used: STATE.power.usedKw,
                    cap: STATE.power.capKw,
                });
                powerEl.className =
                    STATE.power.usedKw >= STATE.power.capKw
                        ? "text-red-400 font-mono"
                        : "text-yellow-300 font-mono";
            }
        }
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

    // Rolling goodput (#261). Deliberately NOT behind the Monitoring gate:
    // this is one board-wide headline number, the equivalent of knowing your
    // revenue without hiring an analyst. PER-SERVICE attribution — which node
    // is slow — stays behind Monitoring, which is where the buy-the-eyes
    // lesson actually lives.
    const goodputEl = document.getElementById("goodput-display");
    if (goodputEl) {
        const g = getRollingGoodput();
        if (g === null) {
            goodputEl.textContent = "--";
            goodputEl.className = "text-gray-500 font-mono text-lg font-bold";
        } else {
            goodputEl.textContent = `${Math.round(g * 100)}%`;
            // Coloured on the same scale the load rings use, so "amber means
            // busy, red means losing" reads the same everywhere on screen.
            const tone =
                g >= 0.9 ? "text-green-400" : g >= 0.7 ? "text-yellow-400" : "text-red-400";
            goodputEl.className = `${tone} font-mono text-lg font-bold`;
        }
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
    if (totalFailures > (STATE.failuresDismissedAt || 0) && failuresPanel) {
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
        document.getElementById("fail-inference").textContent = STATE.failures.INFERENCE;

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
        document.getElementById("fail-inference-rep").textContent =
            STATE.failures.INFERENCE * Math.abs(points.FAIL_REPUTATION);

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
        document.getElementById("fail-row-inference").style.display =
            STATE.failures.INFERENCE > 0 ? "" : "none";
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

    if (!STATE.services.some((s) => s.type === "monitor")) {
        result.tips.push(i18n.t('tip_monitor'));
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

// The window-resize listener, the document-level keyboard shortcuts
// (Esc/H/R/T), toggleView, and resetCamera moved to
// src/input/handlers.js (#155 PR 8).

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
// #156: the failure-badge toggle in the toolbar's settings cluster.
window.toggleFailureBadges = toggleFailureBadges;

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

// #158: the Trophies panel's inline handlers in index.html.
window.showTrophies = showTrophies;
window.closeTrophies = closeTrophies;

// #157: the share modal's inline handlers in index.html.
window.showShareModal = showShareModal;
window.closeShareModal = closeShareModal;
window.copyShareLink = copyShareLink;
window.downloadArchitecturePNG = downloadArchitecturePNG;

// #155 PR 7: the build/wire/demolish cluster now lives in src/sim/topology.js;
// index.html's sandbox "Clear All" button still resolves this on window.
window.clearAllServices = clearAllServices;

// The generated smart-hint dismiss button (showSmartHint) embeds an inline
// onclick that touches STATE.hints — inline handlers resolve against the
// global scope, and the old top-level `const STATE` was a global lexical
// binding. Keep STATE reachable from there.
window.STATE = STATE;

// Runtime cross-module surface: Request.js, Service.js, core/events.js,
// ui/campaign-ui.js, persistence/save-load.js, sim/topology.js and
// input/handlers.js import these (cyclically — safe, they are hoisted
// declarations / top-level consts only dereferenced after evaluation).
export {
    animate,
    badgeGroup,
    calculateTargetRPS,
    camera,
    cameraTarget,
    connectionGroup,
    d,
    formatTime,
    mouse,
    openMainMenu,
    plane,
    raycaster,
    renderer,
    requestGroup,
    resetGame,
    rpsMilestoneMultiplier,
    scene,
    serviceGroup,
    smoothTowardsRPS,
    syncInput,
};
