export const TRAFFIC_TYPES = {
  STATIC: "STATIC",
  READ: "READ",
  WRITE: "WRITE",
  UPLOAD: "UPLOAD",
  SEARCH: "SEARCH",
  MALICIOUS: "MALICIOUS",
};

export const CONFIG = {
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
    apigw: 0xe879f9, // Pink/magenta for API Gateway
    nosql: 0x7c3aed, // Violet for NoSQL
    search: 0x06b6d4, // Cyan-500 for Search Engine
    replica: 0xf472b6, // Pink-400 for Read Replica
    serverless: 0xfbbf24, // amber - lambda style
    monitor: 0x14b8a6, // Teal for Monitoring
    dlq: 0x78716c, // Stone — "dead" letters parked for recovery (#197)
    pubsub: 0x818cf8, // Indigo — fan-out broadcast (#197)
    auth: 0xeab308, // Gold — identity / key (#197)
    scheduler: 0x38bdf8, // Sky — clock / cron (#197)
    notify: 0xfb7185, // Rose — notification bell (#197)
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
      destination: "cdn", // Prefer CDN, fallback to s3 logic in game
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
      reward: 1.2,
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
    cdn: {
      name: "CDN",
      cost: 60,
      type: "cdn",
      processingTime: 30,
      capacity: 50,
      upkeep: 5,
      tooltip: {
        upkeep: "Low",
        desc: "<b>Content Delivery Network.</b> Caches STATIC content at the edge. High cache hit rate.",
      },
      cacheHitRate: 0.95,
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
      cost: 45, // Increased from 35
      type: "sqs",
      processingTime: 20, // Reduced from 100 for high throughput
      capacity: 50, // Increased from 10 to handle bursts
      maxQueueSize: 200,
      upkeep: 3, // Increased from 2
      tooltip: {
        upkeep: "Low",
        desc: "<b>Queue.</b> Buffers requests during spikes. Prevents drops.",
      },
    },
    apigw: {
      // Rate limits and capacity bumped 2026-06 (#166): the previous ceiling
      // (T3 rateLimit=80 RPS, capacity=80) throttled legit traffic at endgame
      // load (~200 RPS). Players learned to remove the gateway to survive,
      // inverting the intended lesson (throttle > hard-fail). New ceilings
      // scale with the ×4 RPS milestone so the gateway stays useful late-game.
      name: "API Gateway",
      cost: 70,
      type: "apigw",
      processingTime: 30,
      capacity: 60,
      upkeep: 8,
      rateLimit: 30,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>API Gateway.</b> Rate limits traffic. Throttled requests lose less reputation than failures.",
      },
      tiers: [
        { level: 1, capacity: 60,  rateLimit: 30,  cost: 0 },
        { level: 2, capacity: 100, rateLimit: 80,  cost: 120 },
        { level: 3, capacity: 160, rateLimit: 200, cost: 200 },
      ],
    },
    nosql: {
      name: "NoSQL DB",
      cost: 80,
      type: "nosql",
      processingTime: 150,
      capacity: 15,
      upkeep: 14,
      tooltip: {
        upkeep: "High",
        desc: "<b>NoSQL Database.</b> Fast for READ/WRITE, but cannot handle SEARCH queries. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 15, cost: 0 },
        { level: 2, capacity: 30, cost: 120 },
        { level: 3, capacity: 50, cost: 200 },
      ],
    },
    search: {
      name: "Search Engine",
      cost: 120,
      type: "search",
      processingTime: 100,
      capacity: 12,
      upkeep: 16,
      tooltip: {
        upkeep: "High",
        desc: "<b>Search Engine.</b> Specialized for SEARCH queries. 3× faster than SQL DB. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 12, cost: 0 },
        { level: 2, capacity: 25, cost: 150 },
        { level: 3, capacity: 40, cost: 250 },
      ],
    },
    replica: {
      name: "Read Replica",
      cost: 100,
      type: "replica",
      processingTime: 200,
      capacity: 12,
      upkeep: 12,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Read Replica.</b> Offloads READ traffic from master DB. Requires connection to a DB. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 12, cost: 0 },
        { level: 2, capacity: 24, cost: 130 },
        { level: 3, capacity: 40, cost: 200 },
      ],
    },
    serverless: {
      name: "Serverless Function",
      cost: 45,
      type: "serverless",
      processingTime: 900,
      capacity: 30,
      upkeep: 2,
      perRequestCost: 0.03,
      tooltip: {
        upkeep: "Very Low",
        desc: "<b>Serverless Function.</b> Auto-scales with traffic. Very low upkeep but pays $0.03 per completed request. Great for spiky / low-volume traffic, expensive at high RPS.",
      },
    },
    monitor: {
      // Observability service (#194). Never receives traffic: it has no
      // entry in the connection-validity table and no handler in the
      // registry — placing it anywhere unlocks the METRICS dashboard and
      // threshold alerts (see src/core/metrics.js). Capacity 1 is a dummy
      // (keeps totalLoad finite); processingTime is never used.
      name: "Monitoring",
      cost: 75,
      type: "monitor",
      processingTime: 100,
      capacity: 1,
      upkeep: 8,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Monitoring.</b> Unlocks the live METRICS dashboard and alerts.",
      },
    },
    // ===== Sandbox archetypes, batch 1 (#197) =====
    // Each clears the bar from #193: distinguishable simulation behavior no
    // existing service replicates. Sandbox + Survival only — no campaign level
    // is gated behind them (levels with an allow-list simply do not offer them).
    dlq: {
      // Dead-Letter Queue. The ONLY node that holds already-failed requests
      // instead of dropping them: when a connected upstream would FINALLY fail
      // a request (retry exhausted / no route), it is parked here instead of
      // failed. Parked requests are neither success nor failure until the DLQ
      // auto-drains them — a slow recovery that costs money per drained request
      // and refunds a little reputation. Overflow past `capacity` drops
      // normally plus an extra reputation penalty (an unmanaged DLQ is worse
      // than none). `capacity` is the parked cap, not a processing capacity;
      // processingTime is unused (requests never enter its job pipeline).
      name: "Dead-Letter Queue",
      cost: 55,
      type: "dlq",
      processingTime: 100,
      capacity: 25,
      upkeep: 4,
      drainIntervalSec: 0.6, // game-time between two automatic drains
      drainCost: 0.5, // $ spent recovering one parked request
      drainRepRefund: 0.4, // reputation refunded per recovered request
      overflowRepPenalty: 1, // extra reputation hit when full and a drop spills
      tooltip: {
        upkeep: "Low",
        desc: "<b>Dead-Letter Queue.</b> Parks requests that finally failed, draining them back for a cost.",
      },
    },
    pubsub: {
      // Pub/Sub Topic. The ONLY node that MULTIPLIES requests: one inbound
      // request fans out to a copy per connected subscriber (capped at the
      // subscriber count so it can never explode). The original is delivered to
      // the first subscriber, one clone is minted per additional subscriber,
      // and every copy is an independent request that must terminate on its own.
      name: "Pub/Sub Topic",
      cost: 65,
      type: "pubsub",
      processingTime: 40,
      capacity: 30,
      upkeep: 6,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Pub/Sub Topic.</b> Fan-out: one event becomes one delivery per subscriber.",
      },
    },
    auth: {
      // Auth / Identity. The ONLY node that trades latency for security on the
      // pass-through path: every request routed through it pays an extra
      // processing delay (processingTime deliberately high), and a share of the
      // MALICIOUS traffic that slips past the edge is caught here (session-based
      // attacks a WAF alone misses). Forwards survivors downstream generically.
      name: "Identity Provider",
      cost: 55,
      type: "auth",
      processingTime: 150, // the latency trade — far above ALB's 50ms
      capacity: 20,
      upkeep: 6,
      catchRate: 0.5, // fraction of MALICIOUS caught on the pass-through path
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Identity Provider.</b> Adds latency but catches session-based attacks a WAF misses.",
      },
    },
    scheduler: {
      // Scheduler / Cron. The ONLY node that is a traffic SOURCE, not a
      // processor: every `intervalSec` of game time it injects a burst of
      // `burstSize` batch jobs into its downstream, independent of external RPS.
      // Ticked from the update loop (never setTimeout, #183) so it freezes with
      // the game at timeScale 0. capacity is a dummy (it processes nothing).
      name: "Scheduler",
      cost: 50,
      type: "scheduler",
      processingTime: 100,
      capacity: 1,
      upkeep: 5,
      intervalSec: 8, // game-time between scheduled bursts
      burstSize: 6, // jobs injected per burst
      burstType: "WRITE", // batch jobs are write-ish
      tooltip: {
        upkeep: "Low",
        desc: "<b>Scheduler.</b> Injects its own scheduled batch-job bursts on a timer.",
      },
    },
    notify: {
      // Notification. A terminal sink whose SUCCESS grants reputation (user
      // goodwill), not just money — the only terminal like that. Its overload
      // failures are SILENT: no fail sound and a much smaller reputation hit
      // than a normal drop, accrued as "dissatisfaction" rather than a counted
      // failure.
      name: "Notification",
      cost: 40,
      type: "notify",
      processingTime: 80,
      capacity: 20,
      upkeep: 4,
      repBonus: 0.5, // extra reputation on a successful send (on top of the base)
      dissatisfaction: 0.3, // quiet reputation cost of a dropped send
      tooltip: {
        upkeep: "Low",
        desc: "<b>Notification.</b> Terminal 'send': success earns reputation, failures are silent.",
      },
    },
  },
  // Auto-Scaling Group tuning (#195). Only Compute can run an ASG; every
  // knob here is expressed in seconds of GAME time (so fast-forward scales
  // the whole mechanic consistently) and in fractions of totalLoad.
  //
  // The numbers survived the economics pass in #195 (single Compute vs ASG
  // Compute vs Serverless over four traffic profiles): warmup and sustain are
  // long enough that a burst still hurts (the cold-start lesson), and at
  // targetUtil 0.7 the fleet stays right-sized — ~2 instances at 10 RPS —
  // instead of over-provisioning. Serverless still wins idle and spiky
  // traffic, a fixed Compute wins steady mid-range traffic, and the ASG is
  // the only option that survives past Serverless's capacity ceiling.
  autoscaling: {
    targetUtil: 0.7, // scale out above this sustained utilization
    scaleInUtil: 0.3, // scale in below this (hysteresis gap prevents flapping)
    cooldownSec: 5, // minimum game-time between two scaling actions
    warmupSec: 3, // cold start: a new instance carries no traffic until then
    minInstances: 1,
    maxInstances: 5,
    sustainSec: 2, // util must hold past the threshold this long
    // Per-instance upkeep premium: instance #1 costs the base upkeep, every
    // further instance costs base * instanceUpkeepFactor. Left at 1.0 (plain
    // per-instance billing) — the #195 sweep showed this knob cannot flip any
    // profile's winner in either direction: Serverless's $0.03/request has the
    // same marginal cost per RPS as a saturated Compute instance, so even free
    // extra instances would not buy back the requests an ASG drops while it
    // warms up. Kept as the tuning lever if Serverless is ever repriced.
    instanceUpkeepFactor: 1.0,
  },
  // Resilience tuning (#196). Times are in seconds of GAME time (fast-forward
  // scales the whole mechanic), rates are fractions of the rolling event
  // window the breaker keeps per service.
  //
  // Calibrated against the #194 alert thresholds and the load-failure curve:
  // calculateFailChanceBasedOnLoad only starts producing errors above 50%
  // utilization and reaches 50% error rate at full saturation, so a breaker at
  // tripErrorRate 0.5 over tripMinEvents 8 fires for a node that is genuinely
  // drowning (or outright broken) and never for a healthy one riding a spike.
  // openSec 5 matches the ASG cooldown — long enough for a peer to absorb the
  // traffic, short enough that the player sees recovery inside one burst.
  resilience: {
    tripErrorRate: 0.5, // error rate over the window that trips the breaker
    tripMinEvents: 8, // ...but never on fewer events than this (rate is noise)
    windowSize: 20, // rolling window of recorded job outcomes per service
    openSec: 5, // time skipped by routing before the first probe
    probeCount: 3, // half-open probes that must all succeed to close
    retryEnabled: true,
    maxRetries: 1, // hard cap — one retry, never a storm
    retryBackoffSec: 0.3, // backoff before the retry flies to the peer
  },
  survival: {
    startBudget: 500,
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
      MALICIOUS_MITIGATION_COST: 1.0, // Cost per blocked attack
      MALICIOUS_BREACH_PENALTY: 50.0, // Cost per successful attack
      THROTTLED_REPUTATION: -0.2, // Soft fail from API Gateway rate limiting
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
      autoRepairRate: 2, // Health points per second when idle
    },

    // Traffic pattern shifts - periodic changes to traffic distribution
    trafficShift: {
      enabled: true,
      interval: 40, // Faster shifts - every 40 seconds
      duration: 25, // Shorter duration keeps things dynamic
      warningTime: 3, // Less warning = more reactive gameplay
      shifts: [
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
        {
          name: "Read Heavy",
          distribution: {
            STATIC: 0.1,
            READ: 0.45,
            WRITE: 0.15,
            UPLOAD: 0.05,
            SEARCH: 0.15,
            MALICIOUS: 0.1,
          },
        },
        {
          name: "Full-Text Flood",
          distribution: {
            STATIC: 0.05,
            READ: 0.1,
            WRITE: 0.1,
            UPLOAD: 0.05,
            SEARCH: 0.55,
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
      checkInterval: 30, // How often to check for triggering events
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
