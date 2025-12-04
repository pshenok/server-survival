const TRAFFIC_TYPES = {
    WEB: 'WEB',     // Requires S3 (Simpler, lower reward)
    API: 'API',     // Requires RDS (Complex, higher reward)
    FRAUD: 'FRAUD'  // Must be blocked by WAF
};

const CONFIG = {
    gridSize: 30,
    tileSize: 4,
    colors: {
        bg: 0x050505, grid: 0x1a1a1a,
        alb: 0x3b82f6, compute: 0xf97316,
        db: 0xdc2626, waf: 0xa855f7,
        s3: 0x10b981, line: 0x475569,
        lineActive: 0x38bdf8,
        requestWeb: 0x4ade80, // Green
        requestApi: 0xffa500, // Orange
        requestFraud: 0xff00ff, // Pink
        requestFail: 0xef4444,
        cache: 0xDC382D, // Redis red
        sqs: 0xFF9900  // AWS orange
    },
    internetNodeStartPos: { x: -40, y: 0, z: 0 },
    services: {
        waf: {
            name: "Firewall", cost: 40, type: 'waf', processingTime: 20, capacity: 100, upkeep: 6,
            tooltip: { upkeep: "Low", desc: "<b>Firewall.</b> The first line of defense. Blocks Fraud traffic." }
        },
        alb: {
            name: "Load Balancer", cost: 50, type: 'alb', processingTime: 50, capacity: 50, upkeep: 10,
            tooltip: { upkeep: "Medium", desc: "<b>Load Balancer.</b> Distributes traffic to multiple Compute instances." }
        },
        compute: {
            name: "Compute", cost: 80, type: 'compute', processingTime: 600, capacity: 4, upkeep: 18,
            tooltip: { upkeep: "High", desc: "<b>EC2 Instance.</b> Processes requests. <b>Upgradeable (Tiers 1-3).</b>" },
            tiers: [
                { level: 1, capacity: 4, cost: 0 },
                { level: 2, capacity: 10, cost: 120 },
                { level: 3, capacity: 18, cost: 180 }
            ]
        },
        db: {
            name: "Relational DB", cost: 180, type: 'db', processingTime: 300, capacity: 8, upkeep: 36,
            tooltip: { upkeep: "Very High", desc: "<b>RDS.</b> Destination for API traffic. <b>Upgradeable (Tiers 1-3).</b>" },
            tiers: [
                { level: 1, capacity: 8, cost: 0 },
                { level: 2, capacity: 20, cost: 250 },
                { level: 3, capacity: 35, cost: 400 }
            ]
        },
        s3: {
            name: "File Storage", cost: 30, type: 's3', processingTime: 200, capacity: 100, upkeep: 8,
            tooltip: { upkeep: "Low", desc: "<b>Storage.</b> Destination for Web traffic." }
        },
        cache: {
            name: "ElastiCache",
            cost: 75,
            type: 'cache',
            processingTime: 50,
            capacity: 30,
            upkeep: 10,
            tooltip: { upkeep: "Medium", desc: "<b>Redis Cache.</b> Caches responses to reduce DB load." },
            cacheHitRate: 0.35,
            tiers: [
                { level: 1, capacity: 30, cacheHitRate: 0.35, cost: 0 },
                { level: 2, capacity: 50, cacheHitRate: 0.50, cost: 150 },
                { level: 3, capacity: 80, cacheHitRate: 0.65, cost: 200 }
            ]
        },
        sqs: {
            name: "SQS Queue",
            cost: 40,
            type: 'sqs',
            processingTime: 100,
            capacity: 10,
            maxQueueSize: 200,
            upkeep: 3,
            tooltip: { upkeep: "Low", desc: "<b>Queue.</b> Buffers requests during spikes. Prevents drops." }
        }
    },
    survival: {
        startBudget: 400,
        baseRPS: 0.5,
        rampUp: 0.015,
        maxRPS: 25,
        trafficDistribution: {
            [TRAFFIC_TYPES.WEB]: 0.45,
            [TRAFFIC_TYPES.API]: 0.40,
            [TRAFFIC_TYPES.FRAUD]: 0.15
        },

        SCORE_POINTS: {
            WEB_SCORE: 5,
            API_SCORE: 8,
            WEB_REWARD: 0.80,
            API_REWARD: 1.20,
            FAIL_REPUTATION: -2,
            FRAUD_PASSED_REPUTATION: -8,
            FRAUD_BLOCKED_SCORE: 10
        },

        upkeepScaling: {
            enabled: true,
            baseMultiplier: 1.0,
            maxMultiplier: 2.0,
            scaleTime: 600
        },

        fraudSpike: {
            enabled: true,
            interval: 90,
            duration: 15,
            fraudPercent: 0.40,
            warningTime: 5
        }
    },
    sandbox: {
        defaultBudget: 2000,
        defaultRPS: 1.0,
        defaultBurstCount: 10,
        upkeepEnabled: false,
        trafficDistribution: { WEB: 45, API: 40, FRAUD: 15 }
    }
};
