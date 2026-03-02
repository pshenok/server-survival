const STATE = {
    money: 0,
    reputation: 0,
    requestsProcessed: 0,

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
        MALICIOUS: 0
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
    }
};
