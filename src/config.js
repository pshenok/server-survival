export const TRAFFIC_TYPES = {
  STATIC: "STATIC",
  READ: "READ",
  WRITE: "WRITE",
  UPLOAD: "UPLOAD",
  SEARCH: "SEARCH",
  MALICIOUS: "MALICIOUS",
  INFERENCE: "INFERENCE",
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
    container: 0x326ce5, // Kubernetes blue — dense box cluster (#198)
    stream: 0x2dd4bf, // Teal — an ordered flow of records (#198)
    dns: 0xa3e635, // Lime — global routing / a resolver globe (#198)
    warehouse: 0xb45309, // Amber — a big cold analytics store (#198)
    gpu: 0xd946ef, // Fuchsia — the INFERENCE color, worn by the node that serves it (#87)
    infgw: 0xa21caf, // Deep fuchsia — the gateway in front of the GPUs (#87)
    power: 0xfacc15, // Electric yellow — the substation pylon (#87)
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
    INFERENCE: {
      // AI Wave (#87). The only traffic with PER-REQUEST duration variance:
      // req.genLength is rolled at spawn (70% short 0.6–1.0, 30% long 1.8–3.0,
      // mean 1.28 — see entities/Request.js) and scales the GPU batch time.
      // Never cacheable — every generation is unique output.
      name: "INFERENCE",
      method: "POST",
      color: 0xd946ef,
      reward: 0.5,
      score: 15,
      cacheable: false,
      cacheHitRate: 0,
      destination: "gpu",
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
    // ===== Sandbox archetypes, batch 2 (#198) — the "complex" set =====
    // Each still clears the #193 bar: distinguishable simulation behavior no
    // existing service replicates. Sandbox + Survival only — no campaign level
    // is gated behind them. Their distinguishing behaviors touch the CORE
    // systems (capacity model, ordering, entry point, traffic classes) rather
    // than bolting on beside them, which is what makes this batch "complex".
    container: {
      // Container Cluster. The economic ANTI-TWIN of Serverless: a big block
      // of fixed capacity at a flat per-CLUSTER price (no per-request charge),
      // where Serverless is tiny fixed upkeep + a per-request bleed. It packs
      // far denser than a single Compute (capacity 12 vs 4) and shares
      // Compute's processing brain (same handler), so on paper it "does the
      // same thing" — the DIFFERENT CHOICE is entirely economic: it wins
      // steady high-throughput, where the flat cluster price beats Serverless's
      // per-request cost AND its density beats paying upkeep for N Compute
      // instances. It reuses the #195 autoscaling engine (canAutoscale) but
      // with a NOTABLY LONGER warmup than ASG Compute (a node-pool boot, not a
      // VM boot — see CONFIG.autoscaling.containerWarmupSec), so its cold start
      // hurts more and pre-scaling matters more.
      name: "Container Cluster",
      cost: 120,
      type: "container",
      processingTime: 600, // same per-request cost as Compute — it IS compute
      capacity: 12, // 3× a Tier-1 Compute: denser packing
      upkeep: 16,
      tooltip: {
        upkeep: "High",
        desc: "<b>Container Cluster.</b> Dense fixed capacity at a flat fee. Slow node-pool warmup on scale-out.",
      },
    },
    stream: {
      // Stream. The ONLY node that models HEAD-OF-LINE BLOCKING: records are
      // spread across `partitions` independent partitions, each of which
      // processes STRICTLY in order. If a partition's head cannot forward
      // (its downstream is saturated) the whole partition waits behind it —
      // it never skips ahead — while the OTHER partitions keep flowing. That
      // ordered-but-blockable behavior is the lesson (ordering vs throughput),
      // and it lives in src/sim/stream.js (ticked from update(), not a handler).
      name: "Stream",
      cost: 90,
      type: "stream",
      processingTime: 100, // fast per-record append; the delay is the ordering, not the work
      capacity: 40, // high throughput ceiling (feeds the totalLoad denominator)
      maxQueueSize: 200, // deep ingress buffer before the per-partition split
      upkeep: 10,
      partitions: 3, // independent ordered partitions
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Stream.</b> High throughput, strictly ordered per partition. A stalled partition backs up its tail.",
      },
    },
    dns: {
      // DNS / GeoDNS. The ONLY entry node that sits IN FRONT of the internet-
      // facing tier and fans traffic across 2+ INDEPENDENT front-door stacks
      // (each its own WAF→ALB→… region). Where an ALB balances workers WITHIN
      // one stack, DNS balances whole stacks at the very front — the basis for
      // multi-region. It is chosen as the entry (see routeRequestToEntry), then
      // round-robins across its own routable downstream front-doors
      // (src/sim/handlers/dns.js). Cheap and fast — it is just a resolver.
      name: "GeoDNS",
      cost: 50,
      type: "dns",
      processingTime: 20, // a resolver lookup, not real work
      capacity: 60,
      upkeep: 4,
      tooltip: {
        upkeep: "Low",
        desc: "<b>GeoDNS.</b> Front-door for the whole site: splits traffic across independent regional stacks.",
      },
    },
    warehouse: {
      // Data Warehouse. The ONLY store that ACCEPTS write-derived analytics and
      // REJECTS realtime READ (OLAP, not OLTP): a WRITE/UPLOAD copy completes
      // here — slowly and cheaply at volume — but a READ/SEARCH that reaches it
      // FAILS, because a warehouse is not a serving database. High capacity +
      // very low upkeep-per-capacity is the "cheap at volume" half; the very
      // high processingTime is the "slow" half. Fed by an analytics fan-out
      // (Pub/Sub copy) or a scheduled batch load (Scheduler ETL); it is a pure
      // terminal sink (src/sim/handlers/warehouse.js).
      name: "Data Warehouse",
      cost: 90,
      type: "warehouse",
      processingTime: 1200, // OLAP is slow
      capacity: 40, // cheap at volume: big and low-upkeep
      upkeep: 8,
      tooltip: {
        upkeep: "Low",
        desc: "<b>Data Warehouse.</b> Stores analytics WRITES cheaply and slowly. Cannot serve realtime READ.",
      },
    },
    // ===== The AI Wave (#87) — GPU inference archetypes =====
    // Spec: docs/superpowers/specs/2026-07-30-ai-wave-design.md. Both traffic
    // nodes are TICK-NODES (like stream/dlq/scheduler): no SERVICE_HANDLERS
    // entry, processQueue() skips them, and their mechanics live in
    // src/sim/gpu.js / src/sim/infgw.js, ticked from Service.update().
    gpu: {
      // GPU Cluster. The ONLY node that BATCHES: it accumulates INFERENCE
      // requests (to batchSize or batchWindowSec from first arrival) and runs
      // the whole batch as ONE job of (batchBaseMs + batchPerItemMs·n) ×
      // meanGenLength — a full batch amortizes the base cost, a lonely
      // request pays nearly full price. Tiers are MODEL SIZE: bigger batches
      // (the economic half) and a lower bad-answer risk (the flavor half),
      // bought with a longer model (re)load during which the node is not
      // routable (modelLoading — a dedicated flag, never isDisabled).
      // Accepts INFERENCE only; the intake queue is BOUNDED at batchSize —
      // the big buffer is the Inference Gateway's job, not the GPU's.
      // Economics (spec §2): at reward $0.50 the saturated pipelined regime
      // profits ≈ +$29/min at full fill and breaks even around half fill —
      // the profit/min-at-fill harness in tests/sim/ai-wave.test.mjs is the
      // authority on the curve. Draws CONFIG.power.gpuDrawKw from the grid.
      name: "GPU Cluster",
      cost: 300,
      type: "gpu",
      processingTime: 900, // unused — batch time is batchBaseMs-driven
      capacity: 8,
      maxQueueSize: 8, // bounded intake = batchSize, tier-linked
      upkeep: 60,
      batchSize: 8,
      batchWindowSec: 1.5, // window from FIRST arrival before a partial batch runs
      batchBaseMs: 900, // per-batch fixed cost...
      batchPerItemMs: 150, // ...plus this per request, × meanGenLength
      qualityRisk: 0.1, // per-request bad-answer chance, tier-linked
      loadTimeSec: 12, // model (re)load, tier-linked
      tooltip: {
        upkeep: "Very High",
        desc: "<b>GPU Cluster.</b> Batches INFERENCE. Bigger tiers batch more and answer better, but reload the model. <b>Upgradeable (Tiers 1-3).</b>",
      },
      tiers: [
        { level: 1, capacity: 8, batchSize: 8, qualityRisk: 0.1, loadTimeSec: 12, cost: 0 },
        { level: 2, capacity: 12, batchSize: 12, qualityRisk: 0.04, loadTimeSec: 20, cost: 200 },
        { level: 3, capacity: 16, batchSize: 16, qualityRisk: 0.01, loadTimeSec: 30, cost: 320 },
      ],
    },
    infgw: {
      // Inference Gateway. The honest pitch (told on its concept card): a
      // direct-wired GPU has only its tiny bounded intake — during warmup or
      // overload requests die fast; the gateway holds up to maxQueueSize with
      // DEADLINE honesty (an entry older than deadlineSec is failed as an SLO
      // breach, never dispatched — sweep-then-dispatch, src/sim/infgw.js) and
      // dispatches heads to the least-loaded routable GPU. Its value is
      // reputation saved during those windows, not revenue — hence the low
      // price (below apigw: single-type scope). One carve-out keeps that
      // pitch true: deadlineSec (6) is shorter than EVERY tier's model load
      // (12/20/30s), so while the whole connected fleet is mid-load the
      // deadline clock waits (the warmup grace in tickInfgw) — otherwise the
      // gateway expires requests a bare GPU's queue would have held, and the
      // card's "reputation saved during warmup" inverts at low rates.
      name: "Inference Gateway",
      cost: 70,
      type: "infgw",
      processingTime: 20, // unused — the deadline array is the mechanic
      capacity: 10,
      maxQueueSize: 20, // the held backlog cap ("holds up to 20")
      upkeep: 5,
      deadlineSec: 6, // SLO: entries older than this expire
      tooltip: {
        upkeep: "Low",
        desc: "<b>Inference Gateway.</b> Holds INFERENCE for warming/full GPUs, but expires anything older than its deadline.",
      },
    },
    power: {
      // Substation. Not a traffic node at all: UNWIREABLE (no isValidEdge
      // rows, like Monitoring) and never routable — it exists only as a term
      // in recomputePower() (src/sim/power.js): each one adds substationKw of
      // grid capacity, and GPUs cannot be placed past the cap. +6 kW per
      // substation on a 6 kW GPU draw means a 3-GPU fleet needs TWO of them —
      // watts stay a real marginal decision, not a one-time unlock.
      name: "Substation",
      cost: 150,
      type: "power",
      processingTime: 100, // never used — it processes nothing
      capacity: 1, // dummy (keeps totalLoad finite)
      upkeep: 8,
      tooltip: {
        upkeep: "Medium",
        desc: "<b>Substation.</b> +6 kW of grid capacity. GPUs draw 6 kW each and cannot be placed past the cap.",
      },
    },
  },
  // The power grid (#87). One tiny model: GPUs draw, the base grid + placed
  // substations supply, and src/sim/power.js derives STATE.power from it.
  // baseCapKw 8 lets exactly ONE free GPU; every further GPU costs a real
  // substation decision (see the placement + deletion gates in topology.js).
  power: {
    baseCapKw: 8,
    gpuDrawKw: 6,
    substationKw: 6,
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
  // Load signal (#74). `totalLoad` is an instantaneous ratio whose numerator is
  // an integer job count, so on a tier-1 Compute (capacity 4) it can only take
  // the values 0.75, 1.00, 1.25 — and a sweep of the reference board measured
  // its mean dwell inside the interesting band at 0.10-0.25 s at EVERY load.
  // That is a strobe, not a state: no threshold placed on the instantaneous
  // signal can describe something a player is able to see and act on.
  //
  // `smoothedLoad` is the same quantity through a trailing exponential mean, so
  // it is continuous (resolution ~0.001 instead of 1/capacity) and persists
  // long enough to be read. tau is in GAME seconds — the update is driven by
  // the game-scaled dt, so fast-forward advances it by game time, not frames.
  // Every threshold below is expressed in smoothedLoad, where 0.5 is 100% of
  // rated capacity (the denominator carries a x2 — see Service.totalLoad). The
  // shipped numbers were all calibrated against the WRONG half of that scale:
  // the ring turned orange at 0.5 — exactly when a node begins dropping
  // requests — and red only at 0.8, which is 160% of capacity, deep inside
  // collapse. The $75 Monitoring node alerted at 0.85, i.e. 170%, long past
  // the point where the information could still be used.
  //
  // Recalibrated so the colours mean what a player would assume: red is "at
  // capacity, dropping next", and the alert arrives BEFORE the first drop.
  // The ordering alertUtil < ringRed = failureOnset is asserted in
  // tests/sim/rings-and-alert.test.mjs rather than left as a comment.
  load: {
    smoothingTau: 2.5,
    ringYellow: 0.25, // 50% of capacity — working, worth noticing
    ringOrange: 0.35, // 70% — busy
    ringRed: 0.45, // 90% — at capacity, drops start next
    alertUtil: 0.375, // 85% — fires ahead of the first failure
    // 2 samples at 2 Hz = 1 s. The shipped 6 (3 s) existed to filter a noisy
    // instantaneous signal; stacking it on a 2.5 s trailing mean would land
    // the alert after the failures it is meant to precede.
    alertSustainSamples: 2,
  },

  autoscaling: {
    targetUtil: 0.7, // scale out above this sustained utilization
    scaleInUtil: 0.3, // scale in below this (hysteresis gap prevents flapping)
    cooldownSec: 5, // minimum game-time between two scaling actions
    warmupSec: 3, // cold start: a new instance carries no traffic until then
    // Container Cluster (#198) reuses this whole engine but boots a NODE POOL,
    // not a single VM — a notably longer cold start than ASG Compute's 3s, so
    // its scale-out lag is the distinguishing pain and pre-scaling matters
    // more. Only updateAutoscaling reads this, gated on service.type.
    containerWarmupSec: 8,
    minInstances: 1,
    maxInstances: 5,
    sustainSec: 2, // util must hold past the threshold this long
    // Queue-depth scaling (#220), the SECOND scale-out signal. Utilization is
    // the CPU-style signal and it is blind for a pull-based fleet: the SQS
    // pull loop caps intake at current capacity, so a drowning consumer reads
    // comfortable util forever while the queue grows without bound. So the
    // engine also watches the fill ratio of every upstream SQS the fleet
    // pulls from — (queue + parked jobs) / maxQueueSize, max across queues —
    // and scales out when it holds above this fraction, through the same
    // sustain/cooldown machinery. Scale-in requires the pressure to have
    // dropped below HALF this value (queue-side hysteresis, mirrors the
    // targetUtil/scaleInUtil gap). Real-world mapping: ASG target tracking on
    // SQS ApproximateNumberOfMessages — scale workers on backlog depth, not
    // on their CPU, because busy-enough workers never look busy.
    // Calibrated 0.2 by headless repro of #220 (20 rps into waf→sqs→
    // compute(AUTO)→db): a saturated SQS equilibrates at ~0.25 fill, not
    // 1.0 — its processing pool caps at `capacity` (50) parked jobs, which is
    // 0.25 of maxQueueSize (200), and past load 0.5 the load-failure roll
    // sheds the rest — so any threshold above 0.25 can never fire. 0.2 sits
    // just under that ceiling while staying far above the transient ripple a
    // healthy, actively-drained queue shows.
    queuePressureThreshold: 0.2,
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
      // AI Wave (#87): survival starts with NO inference — the base share is
      // staged in over the run (0 → 3% after 300s → 10% once a GPU exists)
      // by updateInferenceStaging() in core/events.js.
      // Deliberate economics: the 10% share (1.2 rps at 12 RPS) feeds a GPU
      // BELOW its 2.0 rps revenue break-even, and late-game upkeep scaling
      // doubles that bar past even a full tier-1's ceiling — in survival a
      // GPU is REPUTATION INSURANCE (the no-GPU 3% share bleeds ≈ −21
      // rep/min measured; ownership buys that off), not a profit center.
      // The margin lives in the hype waves (25% ≈ 3 rps, above break-even)
      // and in the classic stack that pays the bills between them.
      [TRAFFIC_TYPES.INFERENCE]: 0,
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
      // A GPU bad answer (#87): the request COMPLETED and paid — this is the
      // quiet quality tax rolled per request in tickGpu, not a failure. At
      // −0.5 against +0.1 SUCCESS a tier-1 GPU still nets +0.05 rep per
      // served request, so the tax never drags the rep number down by
      // itself — it halves the recovery rate. Intended: quality is made
      // legible through the amber badge, the tooltip line and the
      // badAnswers bonus objectives (spec §2d); rep collapses stay the
      // province of real failures (drops, expiries, breaches).
      QUALITY_RISK_REPUTATION: -0.5,
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
        {
          // AI Wave (#87): INFERENCE jumps to 25%, the classic base shares
          // scaled proportionally (×0.75). `requiresService` keeps it out of
          // the rotation until a GPU exists — evaluated at shift-SELECTION
          // time only (see startTrafficShift), so losing the last GPU
          // mid-shift does not cancel it.
          name: "AI Hype Wave",
          requiresService: "gpu",
          distribution: {
            STATIC: 0.225,
            READ: 0.15,
            WRITE: 0.1125,
            UPLOAD: 0.0375,
            SEARCH: 0.075,
            MALICIOUS: 0.15,
            INFERENCE: 0.25,
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
      INFERENCE: 0,
    },
  },
};
