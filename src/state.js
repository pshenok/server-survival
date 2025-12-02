const STATE = {
    money: 0,
    reputation: 0,
    requestsProcessed: 0,

    score: {
        total: 0,
        web: 0,
        api: 0,
        fraudBlocked: 0
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
    trafficDistribution: { WEB: 0.5, API: 0.45, FRAUD: 0.05 },
    burstCount: 10,

    // Menu state
    gameStarted: false,
    previousTimeScale: 1,

    // Balance overhaul state
    gameStartTime: 0,
    fraudSpikeTimer: 0,
    fraudSpikeActive: false,
    normalTrafficDist: null
};
