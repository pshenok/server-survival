const TRAFFIC_TYPES = {
  STATIC: "STATIC",
  READ: "READ",
  WRITE: "WRITE",
  UPLOAD: "UPLOAD",
  SEARCH: "SEARCH",
  MALICIOUS: "MALICIOUS",
};

const CONFIG = {
  gridSize: 30,
  tileSize: 4,
  colors: {
    bg: 0x050505,
    grid: 0x1a1a1a,
    alb: 0x3b82f6,
    compute: 0xf97316,
    db: 0xdc2626,
    waf: 0xa855f7,
    s3: 0x10b981,
    lineActive: 0x00FFFF,
    line: 0x00FF85,
    requestFail: 0xef4444,
    cache: 0xdc382d, // Redis red
    sqs: 0xff9900, // AWS orange
  },
  trafficTypes: {
    STATIC: {
      name: "STATIC",
      method: "GET",
      color: 0x4ade80,
      reward: 0.5,
      score: 3,
      cacheable: true,
      cacheHitRate: 0.9,
      destination: "s3",
      processingWeight: 0.5,
    },
    READ: {
      name: "READ",
      method: "GET",
      color: 0x3b82f6,
      reward: 0.8,
      score: 5,
      cacheable: true,
      cacheHitRate: 0.4,
      destination: "db",
      processingWeight: 1.0,
    },
    WRITE: {
      name: "WRITE",
      method: "POST/PUT",
      color: 0xf97316,
      reward: 1.2,
      score: 8,
      cacheable: false,
      cacheHitRate: 0,
      destination: "db",
      processingWeight: 1.5,
    },
    UPLOAD: {
      name: "UPLOAD",
      method: "POST+file",
      color: 0xfbbf24,
      reward: 1.5,
      score: 10,
      cacheable: false,
      cacheHitRate: 0,
      destination: "s3",
      processingWeight: 2.0,
    },
    SEARCH: {
      name: "SEARCH",
      method: "GET+query",
      color: 0x06b6d4,
      reward: 0.8,
      score: 5,
      cacheable: true,
      cacheHitRate: 0.15,
      destination: "db",
      processingWeight: 2.5,
    },
    MALICIOUS: {
      name: "MALICIOUS",
      method: "any",
      color: 0xef4444,
      reward: 0,
      score: 0,
      cacheable: false,
      cacheHitRate: 0,
      destination: "blocked",
      processingWeight: 1.0,
    },
  },
  internetNodeStartPos: { x: -40, y: 0, z: 0 },
  services: {
    waf: {
      name: "Firewall",
      cost: 40,
      type: "waf",
      processingTime: 20,
      capacity: 30,
      upkeep: 4,
      tooltip: {
        upkeep: "Low",
        desc: "<b>Firewall.</b> The first line of defense. Blocks Malicious traffic.",
      },
    },
    alb: {
      name: "Load Balancer",
      cost: 50,
      type: "alb",
      processingTime: 50,
      capacity: 20,
      upkeep: 6,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Load Balancer.</b> Distributes traffic to multiple Compute instances.",
      },
    },
    compute: {
      name: "Compute",
      cost: 60,
      type: "compute",
      processingTime: 600,
      capacity: 4,
      upkeep: 12,
      tooltip: {
        upkeep: "High",
        desc: "<b>Compute Node.</b> Processes requests. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 4, cost: 0 },
        { level: 2, capacity: 10, cost: 100 },
        { level: 3, capacity: 18, cost: 160 },
      ],
    },
    db: {
      name: "Relational DB",
      cost: 150,
      type: "db",
      processingTime: 300,
      capacity: 8,
      upkeep: 24,
      tooltip: {
        upkeep: "Very High",
        desc: "<b>SQL Database.</b> Destination for READ/WRITE/SEARCH traffic. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 8, cost: 0 },
        { level: 2, capacity: 20, cost: 200 },
        { level: 3, capacity: 35, cost: 350 },
      ],
    },
    s3: {
      name: "File Storage",
      cost: 25,
      type: "s3",
      processingTime: 200,
      capacity: 25,
      upkeep: 5,
      tooltip: {
        upkeep: "Low",
        desc: "<b>Storage.</b> Destination for STATIC/UPLOAD traffic.",
      },
    },
    cache: {
      name: "Memory Cache",
      cost: 60,
      type: "cache",
      processingTime: 50,
      capacity: 30,
      upkeep: 8,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Memory Cache.</b> Caches responses to reduce DB load.",
      },
      cacheHitRate: 0.35,
      tiers: [
        { level: 1, capacity: 30, cacheHitRate: 0.35, cost: 0 },
        { level: 2, capacity: 50, cacheHitRate: 0.5, cost: 120 },
        { level: 3, capacity: 80, cacheHitRate: 0.65, cost: 180 },
      ],
    },
    sqs: {
      name: "Message Queue",
      cost: 35,
      type: "sqs",
      processingTime: 100,
      capacity: 10,
      maxQueueSize: 200,
      upkeep: 2,
      tooltip: {
        upkeep: "Low",
        desc: "<b>Queue.</b> Buffers requests during spikes. Prevents drops.",
      },
    },
  },
  survival: {
    startBudget: 340,
    baseRPS: 1.0,
    rampUp: 0.025,
    maxRPS: Infinity,
    trafficDistribution: {
      [TRAFFIC_TYPES.STATIC]: 0.3,
      [TRAFFIC_TYPES.READ]: 0.2,
      [TRAFFIC_TYPES.WRITE]: 0.15,
      [TRAFFIC_TYPES.UPLOAD]: 0.05,
      [TRAFFIC_TYPES.SEARCH]: 0.1,
      [TRAFFIC_TYPES.MALICIOUS]: 0.2,
    },

    SCORE_POINTS: {
      SUCCESS_REPUTATION: 0.1, // Gain rep on successful requests
      FAIL_REPUTATION: -1, // Reduced from -2
      MALICIOUS_PASSED_REPUTATION: -5, // Reduced from -8
      MALICIOUS_BLOCKED_SCORE: 10,
      CACHE_HIT_BONUS: 0.2,
    },

    upkeepScaling: {
      enabled: true,
      baseMultiplier: 1.0,
      maxMultiplier: 2.0,
      scaleTime: 600,
    },

    maliciousSpike: {
      enabled: true,
      interval: 45,
      duration: 12,
      maliciousPercent: 0.5,
      warningTime: 3,
    },

    // Service degradation - services lose health over time
    degradation: {
      enabled: true,
      healthDecayRate: 0.4, // Health points lost per second - slower decay
      criticalHealth: 40, // Higher threshold for critical state
      repairCostPercent: 0.15, // 15% of service cost to repair
      autoRepairEnabled: false, // Auto-repair toggle (user can enable)
      autoRepairCostPercent: 0.1, // 10% additional upkeep when auto-repair enabled
    },

    // Traffic pattern shifts - periodic changes to traffic distribution
    trafficShifts: {
      enabled: true,
      interval: 40, // Faster shifts - every 40 seconds
      duration: 25, // Shorter duration keeps things dynamic
      warningTime: 3, // Less warning = more reactive gameplay
      patterns: [
        {
          name: "API Heavy",
          distribution: {
            STATIC: 0.1,
            READ: 0.35,
            WRITE: 0.25,
            UPLOAD: 0.05,
            SEARCH: 0.15,
            MALICIOUS: 0.1,
          },
        },
        {
          name: "Storage Surge",
          distribution: {
            STATIC: 0.45,
            READ: 0.1,
            WRITE: 0.1,
            UPLOAD: 0.2,
            SEARCH: 0.05,
            MALICIOUS: 0.1,
          },
        },
        {
          name: "Search Storm",
          distribution: {
            STATIC: 0.15,
            READ: 0.15,
            WRITE: 0.1,
            UPLOAD: 0.05,
            SEARCH: 0.4,
            MALICIOUS: 0.15,
          },
        },
        {
          name: "Write Flood",
          distribution: {
            STATIC: 0.1,
            READ: 0.1,
            WRITE: 0.45,
            UPLOAD: 0.1,
            SEARCH: 0.1,
            MALICIOUS: 0.15,
          },
        },
      ],
    },

    // Random events that require immediate attention
    randomEvents: {
      enabled: true,
      minInterval: 15, // Events can happen very rapidly
      maxInterval: 45, // Frequent events keep players engaged
      types: ["COST_SPIKE", "CAPACITY_DROP", "TRAFFIC_BURST", "SERVICE_OUTAGE"],
      events: [
        {
          type: "COST_SPIKE",
          name: "Cloud Price Surge",
          duration: 20,
          multiplier: 3.0,
          description: "Upkeep costs tripled!",
        },
        {
          type: "CAPACITY_DROP",
          name: "Service Degradation",
          duration: 15,
          multiplier: 0.4,
          description: "All capacities reduced 60%!",
        },
        {
          type: "TRAFFIC_BURST",
          name: "Viral Traffic",
          duration: 12,
          rpsMultiplier: 4.0,
          description: "Traffic 4x!",
        },
        {
          type: "SERVICE_OUTAGE",
          name: "Service Outage",
          duration: 15,
          description: "Random service goes offline!",
        },
      ],
    },

    // RPS acceleration after milestones - aggressive scaling
    rpsAcceleration: {
      enabled: true,
      milestones: [
        { time: 60, multiplier: 1.3 }, // After 1 min, 1.3x
        { time: 120, multiplier: 1.6 }, // After 2 min, 1.6x
        { time: 180, multiplier: 2.0 }, // After 3 min, 2x
        { time: 300, multiplier: 2.5 }, // After 5 min, 2.5x
        { time: 420, multiplier: 3.0 }, // After 7 min, 3x
        { time: 600, multiplier: 4.0 }, // After 10 min, 4x - endgame pressure
      ],
    },
  },
  sandbox: {
    defaultBudget: 2000,
    defaultRPS: 1.0,
    defaultBurstCount: 10,
    upkeepEnabled: false,
    trafficDistribution: {
      STATIC: 30,
      READ: 20,
      WRITE: 15,
      UPLOAD: 5,
      SEARCH: 10,
      MALICIOUS: 20,
    },
  },
};
