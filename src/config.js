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
        requestFail: 0xef4444
    },
    services: {
        waf: { name: "WAF Firewall", cost: 50, type: 'waf', processingTime: 20, capacity: 100, upkeep: 5 },
        alb: { name: "Load Balancer", cost: 50, type: 'alb', processingTime: 50, capacity: 50, upkeep: 8 },
        compute: {
            name: "EC2 Compute", cost: 100, type: 'compute', processingTime: 600, capacity: 5, upkeep: 15,
            tiers: [
                { level: 1, capacity: 5, cost: 0 },
                { level: 2, capacity: 15, cost: 200 },
                { level: 3, capacity: 25, cost: 250 }
            ]
        },
        db: {
            name: "RDS Database", cost: 200, type: 'db', processingTime: 300, capacity: 20, upkeep: 30,
            tiers: [
                { level: 1, capacity: 10, cost: 0 },
                { level: 2, capacity: 30, cost: 400 },
                { level: 3, capacity: 50, cost: 600 }
            ]
        },
        s3: { name: "S3 Storage", cost: 25, type: 's3', processingTime: 200, capacity: 100, upkeep: 5 }
    },
    survival: {
        startBudget: 500,
        baseRPS: 1.0,
        rampUp: 0.025,
        trafficDistribution: {
            [TRAFFIC_TYPES.WEB]: 0.50,
            [TRAFFIC_TYPES.API]: 0.45,
            [TRAFFIC_TYPES.FRAUD]: 0.05
        },

        SCORE_POINTS: {
            WEB_SCORE: 5,
            API_SCORE: 5,
            WEB_REWARD: 1.5,
            API_REWARD: 1.4,
            FAIL_REPUTATION: -2.5,
            FRAUD_PASSED_REPUTATION: -5,
            FRAUD_BLOCKED_SCORE: 5
        }
    }
};
