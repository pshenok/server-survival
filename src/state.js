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
        position: new THREE.Vector3(-40, 0, 0),
        connections: []
    },

    sound: null
};
