// Campaign level definitions. See spec at
// docs/superpowers/specs/2026-05-24-campaign-mode-design.md
//
// Level schema:
//   id                 — 1..14, used for unlock + persistence
//   chapter            — 1=Basics, 2=Optimization, 3=Defense & Mastery
//   title, scenario    — UI strings (EN)
//   learn              — educational text (EN)
//   icon               — single emoji
//   diagramHighlights  — { [preBuiltIndex]: "critical" } visual hints
//   budget             — starting money (overrides survival.startBudget)
//   durationSec        — wall-clock target for speedrun star
//   preBuilt           — { services: [{type,x,z}...], connections: [[from,to]...] }
//                         connection ids: "internet" or numeric index into services[]
//   trafficDistribution — forced mix (sums to 1.0)
//   rps                — fixed spawn rate (overrides survival ramp)
//   allowedServices    — string[]; [] or undefined = all allowed
//   forbiddenServices  — string[]; overrides allowedServices for explicit blocks
//   objectives         — { primary: Obj[], bonus: Obj[] }
//                         Obj: { id, label, check: (STATE) => bool }
//   failConditions     — { repBelow?, moneyBelow?, timeoutSec? }
//   debriefTip         — shown on win

import { CampaignObjectives } from "./objectives.js";

export const CAMPAIGN_LEVELS = [
    // ===== Chapter 1: Basics =====
    {
        id: 1, chapter: 1,
        title: "The First Server",
        scenario: "You're launching a brand-new web service. Build the basic pipeline: Internet → Firewall → Load Balancer → Compute → Database.",
        learn: "Every request flows through the same chain. The Firewall blocks attacks, the Load Balancer distributes work, Compute does the processing, and the Database persists data.",
        icon: "🚀",
        diagramHighlights: {},
        budget: 300,
        durationSec: 60,
        preBuilt: { services: [], connections: [] },
        trafficDistribution: { STATIC: 0, READ: 0.85, WRITE: 0.1, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05 },
        rps: 2,
        allowedServices: ["waf", "alb", "compute", "db", "s3"],
        objectives: {
            primary: [
                { id: "process_50_read", label: "Process 50 READ requests", check: (s) => CampaignObjectives.completedOfType(s, "READ") >= 50 },
                { id: "rep_above_80", label: "Keep reputation above 80%", check: (s) => s.reputation >= 80 },
            ],
            bonus: [
                { id: "no_failures", label: "Zero failed requests", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "speedrun", label: "Complete under 48s", check: (s) => s.elapsedGameTime <= 48 },
            ],
        },
        failConditions: { repBelow: 50, timeoutSec: 180 },
        debriefTip: "The Firewall isn't optional — MALICIOUS traffic destroys reputation fast. Always put it first.",
    },

    {
        id: 2, chapter: 1,
        title: "Store the Files",
        scenario: "Users want to upload profile pictures. Your Compute nodes can't store files directly — they need Storage.",
        learn: "UPLOAD traffic must be routed to Storage. Compute is stateless; persistent files live in S3-style storage.",
        icon: "📁",
        diagramHighlights: {},
        budget: 200,
        durationSec: 45,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        trafficDistribution: { STATIC: 0.1, READ: 0.3, WRITE: 0.1, UPLOAD: 0.45, SEARCH: 0, MALICIOUS: 0.05 },
        rps: 2,
        allowedServices: ["s3"],
        objectives: {
            primary: [
                { id: "process_30_upload", label: "Process 30 UPLOAD requests", check: (s) => CampaignObjectives.completedOfType(s, "UPLOAD") >= 30 },
            ],
            bonus: [
                { id: "no_upload_fails", label: "Zero UPLOAD failures", check: (s) => (s.failures.UPLOAD || 0) === 0 },
                { id: "speedrun", label: "Complete under 36s", check: (s) => s.elapsedGameTime <= 36 },
            ],
        },
        failConditions: { repBelow: 50, timeoutSec: 135 },
        debriefTip: "Storage is cheap ($25) and handles UPLOAD/STATIC traffic without burdening Compute.",
    },

    {
        id: 3, chapter: 1,
        title: "Edge with CDN",
        scenario: "Your site went viral and 80% of traffic is static assets — images, JS, CSS. Your servers are drowning.",
        learn: "CDN caches STATIC content at the edge with 95% hit rate. Traffic served by CDN never touches your origin servers.",
        icon: "🌍",
        diagramHighlights: {},
        budget: 150,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 5 },
                { type: "s3", x: 10, z: -5 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3], [2, 4]],
        },
        trafficDistribution: { STATIC: 0.8, READ: 0.1, WRITE: 0.05, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05 },
        rps: 8,
        allowedServices: ["cdn"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "rep_above_70", label: "Keep reputation above 70%", check: (s) => s.reputation >= 70 },
            ],
            bonus: [
                { id: "db_load_low", label: "DB load stays below 50%", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.5 },
                { id: "no_static_fails", label: "Zero STATIC failures", check: (s) => (s.failures.STATIC || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
        debriefTip: "CDN intercepts STATIC before it reaches your servers. Always pair Internet→CDN→Storage for static content.",
    },

    // ===== Chapter 2: Optimization =====
    {
        id: 4, chapter: 2,
        title: "Cache the DB",
        scenario: "Your e-commerce DB is melting under READ traffic. Players add the same items to cart over and over.",
        learn: "Memory Cache stores responses in RAM and serves repeated READs without hitting the DB. ~40% of READs are cacheable.",
        icon: "🛒",
        diagramHighlights: { 3: "critical" },
        budget: 200,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        // STATIC has no destination on this level (no Storage/CDN in preBuilt, not in
        // allowedServices) so any STATIC traffic was doomed to fail — moved to READ
        // which is the actual lesson here. Same fix as Level 5 (see #159, #162).
        trafficDistribution: { STATIC: 0, READ: 0.8, WRITE: 0.1, UPLOAD: 0, SEARCH: 0.05, MALICIOUS: 0.05 },
        rps: 6,
        allowedServices: ["cache"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "db_load_below_70", label: "Average DB load below 70%", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.7 },
            ],
            bonus: [
                { id: "no_drops", label: "Zero failed requests", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "rep_above_90", label: "Reputation above 90%", check: (s) => s.reputation >= 90 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
        debriefTip: "Cache hit rate degrades for unique keys (e.g. SEARCH with random queries). Use it for repeated READs.",
    },

    {
        id: 5, chapter: 2,
        title: "Buffer the Spikes",
        scenario: "Your traffic is bursty — quiet for 5 seconds, then 20 requests at once. Compute can't keep up and requests drop.",
        learn: "Message Queue (max 200) buffers bursts so Compute processes them at its own pace. But a queue only buys time — it can't add throughput. Sustained load here exceeds Compute Tier 1, so upgrade Compute too, or the queue will eventually saturate.",
        icon: "📊",
        diagramHighlights: { 2: "critical" },
        budget: 180,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.5, WRITE: 0.4, UPLOAD: 0, SEARCH: 0.05, MALICIOUS: 0.05 },
        rps: 5,
        burstPattern: { enabled: true, intervalSec: 5, burstSize: 15 },
        allowedServices: ["sqs"],
        objectives: {
            primary: [
                { id: "survive_90s", label: "Survive 90 seconds", check: (s) => s.elapsedGameTime >= 90 },
                { id: "fail_under_5_pct", label: "Failure rate under 5%", check: (s) => CampaignObjectives.failureRate(s) < 0.05 },
            ],
            bonus: [
                { id: "zero_drops", label: "Zero dropped requests", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "rep_above_85", label: "Reputation above 85%", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 270 },
        debriefTip: "Queues smooth peaks but add latency. Don't use them for low-latency reads.",
    },

    {
        id: 6, chapter: 2,
        title: "Scale Reads",
        scenario: "Read-heavy API traffic (45% READ). One DB can't keep up.",
        learn: "Read Replica syphons READ traffic off the master DB. Compute prefers Replica → NoSQL → SQL automatically.",
        icon: "📖",
        diagramHighlights: { 3: "critical" },
        budget: 200,
        durationSec: 75,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
                { type: "cache", x: 5, z: 5 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 4], [4, 3], [2, 3]],
        },
        // STATIC + UPLOAD have no destination on this level — moved into READ
        // (the actual lesson is Read Replica offloading reads). Same fix as L5.
        trafficDistribution: { STATIC: 0, READ: 0.6, WRITE: 0.15, UPLOAD: 0, SEARCH: 0.15, MALICIOUS: 0.1 },
        rps: 7,
        allowedServices: ["replica"],
        objectives: {
            primary: [
                { id: "survive_75s", label: "Survive 75 seconds", check: (s) => s.elapsedGameTime >= 75 },
                { id: "db_load_below_60", label: "DB load below 60%", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.6 },
            ],
            bonus: [
                { id: "replica_takes_half", label: "Replica handles ≥50% of READ", check: (s) => CampaignObjectives.replicaShareOfReads(s) >= 0.5 },
                { id: "rep_above_85", label: "Reputation above 85%", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 225 },
        debriefTip: "Read Replica needs a master DB connection. Without it, READs to the replica fail.",
    },

    {
        id: 7, chapter: 2,
        title: "Search Done Right",
        scenario: "A Search Storm hits — 50% SEARCH traffic. SQL DB grinds to a halt under expensive full-text queries.",
        learn: "Search Engine handles SEARCH 3× faster than SQL DB. Compute auto-routes SEARCH → Search Engine when available.",
        icon: "🔍",
        diagramHighlights: { 3: "critical" },
        budget: 250,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
                { type: "cache", x: 5, z: 5 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 4], [4, 3], [2, 3]],
        },
        // STATIC + UPLOAD have no destination — moved into SEARCH which is the
        // actual focus of this level (Search Engine for full-text queries).
        trafficDistribution: { STATIC: 0, READ: 0.2, WRITE: 0.1, UPLOAD: 0, SEARCH: 0.6, MALICIOUS: 0.1 },
        rps: 6,
        allowedServices: ["search"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "sql_load_below_40", label: "SQL DB load below 40%", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.4 },
            ],
            bonus: [
                { id: "no_search_fails", label: "Zero SEARCH failures", check: (s) => (s.failures.SEARCH || 0) === 0 },
                { id: "rep_above_80", label: "Reputation above 80%", check: (s) => s.reputation >= 80 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 180 },
        debriefTip: "Search Engine only handles SEARCH. Other traffic must keep going to DB/NoSQL.",
    },

    {
        id: 8, chapter: 2,
        title: "NoSQL for Speed",
        scenario: "Your SQL DB is the bottleneck. Most of your traffic is simple READ/WRITE — overkill for a relational DB.",
        learn: "NoSQL is 2× faster than SQL for READ/WRITE (150ms vs 300ms). But it can't handle SEARCH — keep SQL for that.",
        icon: "⚡",
        diagramHighlights: { 3: "critical" },
        budget: 300,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
                { type: "cache", x: 5, z: 5 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 4], [4, 3], [2, 3]],
        },
        // STATIC + UPLOAD have no destination — split into READ/WRITE which is
        // the actual lesson here (NoSQL is the alternative for transactional READs/WRITEs).
        trafficDistribution: { STATIC: 0, READ: 0.45, WRITE: 0.35, UPLOAD: 0, SEARCH: 0.1, MALICIOUS: 0.1 },
        rps: 7,
        allowedServices: ["nosql"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "rep_above_75", label: "Reputation above 75%", check: (s) => s.reputation >= 75 },
            ],
            bonus: [
                { id: "nosql_takes_writes", label: "NoSQL handles ≥60% of WRITE", check: (s) => CampaignObjectives.nosqlShareOfWrites(s) >= 0.6 },
                { id: "rep_above_85", label: "Reputation above 85%", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 180 },
        debriefTip: "NoSQL ≠ universal upgrade. SEARCH still needs SQL DB or a Search Engine.",
    },

    {
        id: 9, chapter: 2,
        title: "Rate Limit Gateway",
        scenario: "Traffic spikes randomly to 4× normal. Excess requests fail hard, costing -1 reputation each.",
        learn: "API Gateway throttles excess traffic with only -0.2 reputation per throttle (vs -1 for failures). Soft-fail is much cheaper.",
        icon: "🚦",
        diagramHighlights: {},
        budget: 220,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        // STATIC + UPLOAD have no destination — moved into READ. The lesson is
        // API Gateway throttling under burst pressure, which is what 15% extra READ
        // load lets us demonstrate without the unwinnable doom-traffic (fixes #162).
        trafficDistribution: { STATIC: 0, READ: 0.55, WRITE: 0.2, UPLOAD: 0, SEARCH: 0.15, MALICIOUS: 0.1 },
        rps: 4,
        burstPattern: { enabled: true, intervalSec: 8, burstSize: 25 },
        allowedServices: ["apigw"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "fail_under_10_pct", label: "Failure rate under 10%", check: (s) => CampaignObjectives.failureRate(s) < 0.1 },
            ],
            bonus: [
                { id: "rep_above_80", label: "Reputation above 80%", check: (s) => s.reputation >= 80 },
                { id: "rep_above_90", label: "Reputation above 90%", check: (s) => s.reputation >= 90 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
        debriefTip: "Throttling > failing. Place API Gateway behind WAF (Internet→WAF→APIGW→ALB).",
    },

    {
        id: 10, chapter: 2,
        title: "Serverless or Compute?",
        scenario: "You have low, bursty traffic (~1.5 RPS) and a tight $500 budget. Always-on Compute bleeds upkeep.",
        learn: "Serverless Function has very low upkeep but charges $0.03 per request. Cheap for low/bursty traffic, expensive at high RPS.",
        icon: "λ",
        diagramHighlights: {},
        budget: 500,
        durationSec: 90,
        preBuilt: { services: [], connections: [] },
        trafficDistribution: { STATIC: 0.2, READ: 0.4, WRITE: 0.2, UPLOAD: 0.05, SEARCH: 0.05, MALICIOUS: 0.1 },
        rps: 1.5,
        allowedServices: [],
        objectives: {
            primary: [
                { id: "profit_100", label: "Net profit ≥ -$210 in 90s", check: (s) => CampaignObjectives.netProfit(s) >= -210 },
                { id: "rep_above_70", label: "Reputation above 70%", check: (s) => s.reputation >= 70 },
            ],
            bonus: [
                { id: "uses_serverless", label: "Used Serverless Function (no Compute)", check: (s) => CampaignObjectives.usesOnly(s, "serverless", ["compute"]) },
                { id: "speedrun", label: "Complete under 72s", check: (s) => s.elapsedGameTime <= 72 },
            ],
        },
        failConditions: { moneyBelow: -50, repBelow: 30, timeoutSec: 270 },
        debriefTip: "Pay-per-use only wins at low RPS. Once traffic stabilizes high, switch to always-on Compute.",
    },

    // ===== Chapter 3: Defense & Mastery =====
    {
        id: 11, chapter: 3,
        title: "Defense in Depth",
        scenario: "A DDoS wave is incoming — 70% malicious traffic. A single Firewall isn't enough; you need defense in layers.",
        learn: "WAF blocks MALICIOUS hard. API Gateway throttles legitimate spikes. Together they form a layered defense.",
        icon: "🛡️",
        diagramHighlights: {},
        budget: 300,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2]],
        },
        // STATIC + UPLOAD have no destination — moved into READ. MALICIOUS stays at
        // 0.7 because the lesson is layered DDoS defense (WAF + APIGW).
        trafficDistribution: { STATIC: 0, READ: 0.2, WRITE: 0.05, UPLOAD: 0, SEARCH: 0.05, MALICIOUS: 0.7 },
        rps: 8,
        allowedServices: ["waf", "apigw"],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "no_leaks", label: "Zero MALICIOUS leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
            bonus: [
                { id: "rep_above_70", label: "Reputation above 70%", check: (s) => s.reputation >= 70 },
                { id: "uses_both", label: "Used both WAF and API Gateway", check: (s) => CampaignObjectives.hasService(s, "waf") && CampaignObjectives.hasService(s, "apigw") },
            ],
        },
        failConditions: { repBelow: 20, timeoutSec: 180 },
        debriefTip: "MALICIOUS leaks are 5× worse than failures. WAF is non-negotiable for any production system.",
    },

    {
        id: 12, chapter: 3,
        title: "High Availability",
        scenario: "Single Firewall = single point of failure. A simulated outage will disable one of your services mid-game. Build redundancy.",
        learn: "Multiple identical entry points share load via round-robin. If one fails, others absorb the traffic.",
        icon: "🔄",
        diagramHighlights: { 0: "critical" },
        budget: 250,
        durationSec: 75,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        // STATIC + UPLOAD have no destination — moved into READ. The lesson here
        // is redundancy (multiple WAFs surviving a forced outage event).
        trafficDistribution: { STATIC: 0, READ: 0.55, WRITE: 0.2, UPLOAD: 0, SEARCH: 0.1, MALICIOUS: 0.15 },
        rps: 6,
        forceOutageAtSec: 30,
        allowedServices: ["waf"],
        objectives: {
            primary: [
                { id: "survive_75s", label: "Survive 75 seconds", check: (s) => s.elapsedGameTime >= 75 },
                { id: "rep_above_60", label: "Reputation above 60%", check: (s) => s.reputation >= 60 },
            ],
            bonus: [
                { id: "two_wafs", label: "Run at least 2 Firewalls", check: (s) => CampaignObjectives.countServices(s, "waf") >= 2 },
                { id: "no_leaks", label: "Zero MALICIOUS leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 20, timeoutSec: 225 },
        debriefTip: "Two cheap WAFs beat one expensive one. Redundancy > capacity for entry points.",
    },

    {
        id: 13, chapter: 3,
        title: "Cost Crunch",
        scenario: "Your over-engineered architecture is bleeding money. Upkeep is eating all your income. Trim the fat without breaking throughput.",
        learn: "Every service has upkeep. Removing redundant or oversized services can keep you alive financially.",
        icon: "💰",
        diagramHighlights: {},
        budget: 100,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -25, z: 0 },
                { type: "apigw", x: -18, z: 0 },
                { type: "alb", x: -11, z: 0 },
                { type: "sqs", x: -4, z: 0 },
                { type: "compute", x: 3, z: 0 },
                { type: "cache", x: 10, z: 5 },
                { type: "db", x: 17, z: 5 },
                { type: "nosql", x: 17, z: -5 },
                { type: "replica", x: 24, z: 5 },
                { type: "search", x: 24, z: -5 },
                { type: "cdn", x: -11, z: -7 },
                { type: "s3", x: -4, z: -7 },
            ],
            connections: [
                ["internet", 0], [0, 1], [1, 2], [2, 3], [3, 4],
                [4, 5], [5, 6], [4, 7], [4, 8], [4, 9],
                ["internet", 10], [10, 11],
            ],
        },
        trafficDistribution: { STATIC: 0.2, READ: 0.3, WRITE: 0.2, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.15 },
        rps: 4,
        allowedServices: [],
        objectives: {
            primary: [
                { id: "survive_60s", label: "Survive 60 seconds", check: (s) => s.elapsedGameTime >= 60 },
                { id: "net_profit", label: "Net profit > 0", check: (s) => CampaignObjectives.netProfit(s) > 0 },
            ],
            bonus: [
                { id: "upkeep_low", label: "Total upkeep below $0.80/s", check: (s) => CampaignObjectives.totalUpkeepPerSec(s) < 0.8 },
                { id: "rep_above_70", label: "Reputation above 70%", check: (s) => s.reputation >= 70 },
            ],
        },
        failConditions: { moneyBelow: -200, timeoutSec: 180 },
        debriefTip: "Over-provisioning is the silent killer. Right-size every service to actual load.",
    },

    {
        id: 14, chapter: 3,
        title: "Black Friday",
        scenario: "It's go time. 90 seconds of chaos: 4× normal RPS, DDoS waves, traffic shifts. Build whatever you need.",
        learn: "Real production combines everything: WAF, API GW, Cache, Queue, Replicas, Search Engine, CDN — pick the right tools for each problem.",
        icon: "🔥",
        diagramHighlights: {},
        budget: 1000,
        durationSec: 90,
        preBuilt: { services: [], connections: [] },
        trafficDistribution: { STATIC: 0.25, READ: 0.25, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.15, MALICIOUS: 0.15 },
        rps: 12,
        enableSurvivalShifts: true,
        allowedServices: [],
        objectives: {
            primary: [
                { id: "survive_90s", label: "Survive 90 seconds", check: (s) => s.elapsedGameTime >= 90 },
                { id: "rep_above_50", label: "Reputation above 50%", check: (s) => s.reputation >= 50 },
            ],
            bonus: [
                { id: "rep_above_70", label: "Reputation above 70%", check: (s) => s.reputation >= 70 },
                { id: "no_leaks", label: "Zero MALICIOUS leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 20, moneyBelow: -500, timeoutSec: 270 },
        debriefTip: "Congratulations, Architect. You've mastered the basics of cloud system design. Now try Survival mode for the real grind.",
    },
];
