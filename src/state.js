import { CONFIG } from "./config.js";

export const STATE = {
    money: 0,
    reputation: 0,
    requestsProcessed: 0,
    lateCompletions: 0, // #248

    score: {
        total: 0,
        storage: 0,
        database: 0,
        maliciousBlocked: 0
    },

    failures: {
        STATIC: 0,
        READ: 0,
        WRITE: 0,
        UPLOAD: 0,
        SEARCH: 0,
        MALICIOUS: 0,
        INFERENCE: 0
    },

    activeTool: 'select',
    selectedNodeId: null,
    services: [],
    requests: [],
    connections: [],

    lastTime: 0,
    spawnTimer: 0,
    currentRPS: 0.5,
    timeScale: 1,
    isRunning: true,
    animationId: null,

    internetNode: {
        id: 'internet',
        type: 'internet',
        position: new THREE.Vector3(
            CONFIG.internetNodeStartPos.x,
            CONFIG.internetNodeStartPos.y,
            CONFIG.internetNodeStartPos.z
        ),
        connections: []
    },

    sound: null,

    // Sandbox mode state
    gameMode: 'survival',
    sandboxBudget: 2000,
    upkeepEnabled: true,
    trafficDistribution: {
        STATIC: 0.30,
        READ: 0.20,
        WRITE: 0.15,
        UPLOAD: 0.05,
        SEARCH: 0.10,
        MALICIOUS: 0.20
    },
    burstCount: 10,

    // Menu state
    gameStarted: false,
    previousTimeScale: 1,

    // Balance overhaul state
    gameStartTime: 0,
    elapsedGameTime: 0,
    maliciousSpikeTimer: 0,
    maliciousSpikeActive: false,
    normalTrafficDist: null,

    // Intervention mechanics state
    intervention: {
        // Traffic shift state
        trafficShiftTimer: 0,
        trafficShiftActive: false,
        currentShift: null,
        originalTrafficDist: null,

        // Random events state
        randomEventTimer: 0,
        activeEvent: null,
        eventEndTime: 0,
        pausedEvent: null,
        remainingTime: 0,

        // RPS milestone tracking
        currentMilestoneIndex: 0,
        rpsMultiplier: 1.0,

        // Event history for UI
        recentEvents: [],

        // Warning state
        warnings: []
    },

    // Resilience session counters (#196). Reset by resetResilience() from
    // resetGame(); read by the campaign objective helpers, which stay pure
    // functions over STATE.
    resilience: {
        trips: 0,       // circuit breakers opened this session
        retries: 0,     // requests retried via a healthy peer
        outages: 0,     // SERVICE_OUTAGE events (random or campaign-forced)
        drained: 0,     // requests recovered by a DLQ auto-drain (#234)
    },

    // AI Wave session counters (#87), the resilience-counter precedent:
    // reset by resetGame(), bumped by the Inference Gateway's deadline sweep,
    // read by CampaignObjectives.expiredRequests().
    inference: {
        expired: 0,     // SLO-expired requests at Inference Gateways
    },

    // The power grid (#87). ALWAYS a derivation over live services — never
    // mutated directly; recomputePower() in src/sim/power.js is the single
    // writer (8 = CONFIG.power.baseCapKw, restated here only so the field
    // exists before the first recompute).
    power: {
        usedKw: 0,
        capKw: 8,
    },

    // Campaign mode runtime state. Populated by CampaignController when active.
    campaign: {
        active: false,
        currentLevelId: null,
        level: null,            // level config object
        objectiveResults: {},   // { objectiveId: boolean }
        bonusResults: {},
        startedAt: 0,
        ended: false,
        outcome: null,          // "win" | "lose" | null
        failureReason: null,
        // Region outage (#221). regionOutage is the live event record
        // ({ serviceIds, endAtSec, active, startedCompleted, endedCompleted })
        // written by triggerRegionOutage; the fired flag makes the campaign
        // trigger one-shot per level session. Both reset in loadLevel.
        regionOutageFired: false,
        regionOutage: null,
    }
};
