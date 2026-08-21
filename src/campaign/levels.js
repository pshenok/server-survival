// Campaign level definitions. See spec at
// docs/superpowers/specs/2026-05-24-campaign-mode-design.md
//
// Level schema:
//   id                 — 1..N, sequential from 1; used for unlock + persistence
//   chapter            — 1=Basics, 2=Optimization, 3=Defense & Mastery,
//                        4=Production Readiness
//   (narrative)        — title/scenario/learn/debrief live in the LOCALES, not
//                        here (#238), looked up by convention: level_<id>_title,
//                        level_<id>_scenario, level_<id>_learn, level_<id>_debrief.
//                        tests/levels.test.mjs fails if en is missing any.
//   icon               — single emoji
//   diagramHighlights  — { [preBuiltIndex]: "critical" } visual hints
//   budget             — starting money (overrides survival.startBudget)
//   durationSec        — wall-clock target for speedrun star
//   preBuilt           — { services: [{type,x,z}...], connections: [[from,to]...] }
//                         connection ids: "internet" or numeric index into services[]
//   trafficDistribution — forced mix (sums to 1.0)
//   rps                — fixed spawn rate (overrides survival ramp)
//   burstPattern       — { enabled, intervalSec, burstSize } forced spawn bursts
//   forceOutageAtSec   — game time at which the first Firewall is knocked offline
//   forceRegionOutageAtSec — game time at which the whole stack behind the DNS's
//                        first-wired front door goes dark as one region (#221)
//   regionOutageDurationSec — how long that region stays dark (default 25s);
//                        it restores so the player sees traffic shift BACK too
//   enableSurvivalShifts — opt into survival's traffic shifts / random events
//   allowedServices    — string[]; [] or undefined = all allowed
//   forbiddenServices  — string[]; overrides allowedServices for explicit blocks
//   objectives         — { primary: Obj[], bonus: Obj[] }
//                         Obj: { id, check: (STATE) => bool }; the player-facing
//                         label is the locale key obj_<levelId>_<objId>, so ids
//                         must be unique within a level and readable enough to
//                         review label-vs-check adjacency in en.js
//   failConditions     — { repBelow?, moneyBelow?, timeoutSec? }

import { CampaignObjectives } from "./objectives.js";

export const CAMPAIGN_LEVELS = [
    // ===== Chapter 1: Basics =====
    {
        id: 1, chapter: 1,
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
                { id: "process_50_read", check: (s) => CampaignObjectives.completedOfType(s, "READ") >= 50 },
                { id: "rep_above_80", check: (s) => s.reputation >= 80 },
            ],
            bonus: [
                { id: "no_failures", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "speedrun", check: (s) => s.elapsedGameTime <= 48 },
            ],
        },
        failConditions: { repBelow: 50, timeoutSec: 180 },
    },

    {
        id: 2, chapter: 1,
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
                { id: "process_30_upload", check: (s) => CampaignObjectives.completedOfType(s, "UPLOAD") >= 30 },
            ],
            bonus: [
                { id: "no_upload_fails", check: (s) => (s.failures.UPLOAD || 0) === 0 },
                { id: "speedrun", check: (s) => s.elapsedGameTime <= 36 },
            ],
        },
        failConditions: { repBelow: 50, timeoutSec: 135 },
    },

    {
        id: 3, chapter: 1,
        icon: "🌍",
        diagramHighlights: {},
        // 170, not 150: the level's own reference build is a CDN (60) plus the
        // Compute tier (100), and at 150 the upgrade silently failed the
        // affordability check — the briefed solution could not be bought.
        budget: 170,
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
        // "Your site went viral" is a SPIKE, and that is what makes the CDN
        // load-bearing (#254). At a flat 8 rps the level was won by an
        // untouched board — 80% STATIC at 0.5 processing weight fits inside a
        // tier-1 Compute, so nothing the briefing teaches was needed. A burst
        // arrives 20ms apart, i.e. 50 req/s while it lasts, and 80% of it is
        // STATIC: the origin path needs ~17 concurrent slots to hold it and
        // the biggest box the budget buys has 10. Only moving STATIC to the
        // edge removes the demand instead of queueing it.
        burstPattern: { enabled: true, intervalSec: 5, burstSize: 30 },
        allowedServices: ["cdn"],
        objectives: {
            primary: [
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "rep_above_70", check: (s) => s.reputation >= 70 },
            ],
            bonus: [
                { id: "db_load_low", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.5 },
                { id: "no_static_fails", check: (s) => (s.failures.STATIC || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
    },

    // ===== Chapter 2: Optimization =====
    {
        id: 4, chapter: 2,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "db_load_below_70", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.7 },
            ],
            bonus: [
                { id: "no_drops", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "rep_above_90", check: (s) => s.reputation >= 90 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
    },

    {
        id: 5, chapter: 2,
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
                { id: "survive_90s", check: (s) => s.elapsedGameTime >= 90 },
                { id: "fail_under_5_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.05 },
            ],
            bonus: [
                { id: "zero_drops", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
                { id: "rep_above_85", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 270 },
    },

    {
        id: 6, chapter: 2,
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
                { id: "survive_75s", check: (s) => s.elapsedGameTime >= 75 },
                { id: "db_load_below_60", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.6 },
            ],
            bonus: [
                { id: "replica_takes_half", check: (s) => CampaignObjectives.replicaShareOfReads(s) >= 0.5 },
                { id: "rep_above_85", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 225 },
    },

    {
        id: 7, chapter: 2,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "sql_load_below_40", check: (s) => CampaignObjectives.maxLoadOfType(s, "db") < 0.4 },
            ],
            bonus: [
                { id: "no_search_fails", check: (s) => (s.failures.SEARCH || 0) === 0 },
                { id: "rep_above_80", check: (s) => s.reputation >= 80 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 180 },
    },

    {
        id: 8, chapter: 2,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "rep_above_75", check: (s) => s.reputation >= 75 },
            ],
            bonus: [
                { id: "nosql_takes_writes", check: (s) => CampaignObjectives.nosqlShareOfWrites(s) >= 0.6 },
                { id: "rep_above_85", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 180 },
    },

    {
        id: 9, chapter: 2,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "fail_under_10_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.1 },
            ],
            bonus: [
                { id: "rep_above_80", check: (s) => s.reputation >= 80 },
                { id: "rep_above_90", check: (s) => s.reputation >= 90 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 180 },
    },

    {
        id: 10, chapter: 2,
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
                { id: "profit_100", check: (s) => CampaignObjectives.netProfit(s) >= -210 },
                { id: "rep_above_70", check: (s) => s.reputation >= 70 },
            ],
            bonus: [
                { id: "uses_serverless", check: (s) => CampaignObjectives.usesOnly(s, "serverless", ["compute"]) },
                { id: "speedrun", check: (s) => s.elapsedGameTime <= 72 },
            ],
        },
        failConditions: { moneyBelow: -50, repBelow: 30, timeoutSec: 270 },
    },

    // ===== Chapter 3: Defense & Mastery =====
    {
        id: 11, chapter: 3,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "no_leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
            bonus: [
                { id: "rep_above_70", check: (s) => s.reputation >= 70 },
                { id: "uses_both", check: (s) => CampaignObjectives.hasService(s, "waf") && CampaignObjectives.hasService(s, "apigw") },
            ],
        },
        failConditions: { repBelow: 20, timeoutSec: 180 },
    },

    {
        id: 12, chapter: 3,
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
                { id: "survive_75s", check: (s) => s.elapsedGameTime >= 75 },
                { id: "rep_above_60", check: (s) => s.reputation >= 60 },
            ],
            bonus: [
                { id: "two_wafs", check: (s) => CampaignObjectives.countServices(s, "waf") >= 2 },
                { id: "no_leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 20, timeoutSec: 225 },
    },

    {
        id: 13, chapter: 3,
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
                { id: "survive_60s", check: (s) => s.elapsedGameTime >= 60 },
                { id: "net_profit", check: (s) => CampaignObjectives.netProfit(s) > 0 },
            ],
            bonus: [
                { id: "upkeep_low", check: (s) => CampaignObjectives.totalUpkeepPerSec(s) < 0.8 },
                { id: "rep_above_70", check: (s) => s.reputation >= 70 },
            ],
        },
        failConditions: { moneyBelow: -200, timeoutSec: 180 },
    },

    {
        id: 14, chapter: 3,
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
                { id: "survive_90s", check: (s) => s.elapsedGameTime >= 90 },
                { id: "rep_above_50", check: (s) => s.reputation >= 50 },
            ],
            bonus: [
                { id: "rep_above_70", check: (s) => s.reputation >= 70 },
                { id: "no_leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
            ],
        },
        failConditions: { repBelow: 20, moneyBelow: -500, timeoutSec: 270 },
    },

    // ===== Chapter 4: Production Readiness (#217) =====
    // The Wave 1 mechanics (#193): observability, auto-scaling, resilience,
    // dead-letter queues and fan-out. Levels 1-14 are deliberately untouched —
    // wiring a new objective into a released level re-balances it for players
    // who are mid-progress, so new mechanics get new levels.
    {
        id: 15, chapter: 4,
        icon: "📈",
        diagramHighlights: {},
        budget: 190,
        durationSec: 85,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: -2, z: 0 },
                { type: "cache", x: 8, z: 7 },
                { type: "db", x: 18, z: 7 },
                { type: "s3", x: 8, z: -7 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3], [3, 4], [2, 4], [2, 5]],
        },
        // Tuned by headless playthrough: the traffic is deliberately heavy
        // (UPLOAD/SEARCH weights) so the pre-built Tier-1 Compute sits ~10%
        // over its own throughput. That is enough to bury it inside ~30s —
        // long enough to read the panel, short enough that guessing loses.
        // Every other node here is far below its ceiling, which is the point:
        // the expensive DB is not the bottleneck, the cheap Compute is.
        trafficDistribution: { STATIC: 0.05, READ: 0.15, WRITE: 0.1, UPLOAD: 0.4, SEARCH: 0.2, MALICIOUS: 0.1 },
        rps: 4.6,
        allowedServices: ["monitor"],
        objectives: {
            primary: [
                { id: "deploy_monitoring", check: (s) => CampaignObjectives.hasService(s, "monitor") },
                { id: "serve_220", check: (s) => CampaignObjectives.totalCompleted(s) >= 220 },
            ],
            bonus: [
                { id: "nothing_hot", check: (s) => CampaignObjectives.busiestLoad(s) < 0.3 },
                { id: "fail_under_10_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.1 },
            ],
        },
        failConditions: { repBelow: 25, timeoutSec: 210 },
    },

    {
        id: 16, chapter: 4,
        icon: "🌊",
        diagramHighlights: { 2: "critical" },
        budget: 90,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: -2, z: 0 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        // Tuned by headless playthrough. Arrival sits a hair ABOVE one
        // instance's throughput: the backlog grows slowly enough that the
        // group scales out before the circuit breaker gives up on the node,
        // and the fleet then clears the queue. Push the rate higher and the
        // breaker trips first — which starves the node, cancels the warming
        // instance and the group can never catch up.
        trafficDistribution: { STATIC: 0, READ: 0.1, WRITE: 0, UPLOAD: 0, SEARCH: 0.8, MALICIOUS: 0.1 },
        rps: 3.2,
        allowedServices: ["monitor"],
        objectives: {
            primary: [
                { id: "fleet_scaled", check: (s) => CampaignObjectives.fleetScaledOut(s, "compute") },
                { id: "serve_150", check: (s) => CampaignObjectives.totalCompleted(s) >= 150 },
            ],
            bonus: [
                { id: "fail_under_25_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.25 },
                { id: "rep_above_40", check: (s) => s.reputation >= 40 },
            ],
        },
        // No survive-N objective: the goal is throughput, so a fixed fleet
        // fails by never getting there rather than by a stopwatch.
        failConditions: { repBelow: 15, timeoutSec: 150 },
    },

    {
        id: 17, chapter: 4,
        icon: "🔌",
        diagramHighlights: { 0: "critical" },
        // Roomy on purpose: a MALICIOUS leak costs $50, so a player who waits
        // for the outage before buying the spare Firewall must still be able
        // to afford it after the first wave of breaches.
        budget: 200,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: -2, z: 0 },
                { type: "cache", x: 8, z: 7 },
                { type: "db", x: 18, z: 7 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3], [3, 4], [2, 4]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.5, WRITE: 0.15, UPLOAD: 0, SEARCH: 0.1, MALICIOUS: 0.25 },
        rps: 4,
        forceOutageAtSec: 30,
        allowedServices: ["waf"],
        objectives: {
            primary: [
                { id: "survived_outage", check: (s) => CampaignObjectives.survivedNodeFailure(s, 75) },
                { id: "survive_70s", check: (s) => s.elapsedGameTime >= 70 },
            ],
            bonus: [
                { id: "no_leaks", check: (s) => (s.failures.MALICIOUS || 0) === 0 },
                { id: "rep_above_90", check: (s) => s.reputation >= 90 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 270 },
    },

    {
        id: 18, chapter: 4,
        icon: "📥",
        diagramHighlights: { 2: "critical", 3: "critical" },
        budget: 120,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: -2, z: 7 },
                { type: "compute", x: -2, z: -7 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [1, 3], [2, 4], [3, 4]],
        },
        // Tuned by headless playthrough: the baseline is comfortable for two
        // Tier-1 Compute nodes and every burst overruns them. That produces
        // ~1.5 final failures per second — just inside what one DLQ can drain
        // (drainIntervalSec 0.6) and just outside what reputation can absorb
        // without one.
        trafficDistribution: { STATIC: 0, READ: 0.45, WRITE: 0.35, UPLOAD: 0, SEARCH: 0.1, MALICIOUS: 0.1 },
        rps: 4,
        burstPattern: { enabled: true, intervalSec: 8, burstSize: 14 },
        allowedServices: ["dlq"],
        objectives: {
            primary: [
                { id: "deploy_dlq", check: (s) => CampaignObjectives.hasService(s, "dlq") },
                { id: "survive_70s", check: (s) => s.elapsedGameTime >= 70 },
            ],
            bonus: [
                { id: "retries_worked", check: (s) => CampaignObjectives.retriedRequests(s) >= 15 },
                { id: "nothing_lost", check: (s) => CampaignObjectives.totalFailures(s) === 0 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 270 },
    },

    {
        id: 19, chapter: 4,
        icon: "📡",
        diagramHighlights: { 4: "critical" },
        budget: 150,
        durationSec: 60,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: 2, z: 7 },
                { type: "db", x: 14, z: 7 },
                { type: "notify", x: 2, z: -9 },
            ],
            connections: [["internet", 0], [0, 1], [2, 3]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.25, WRITE: 0.6, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.15 },
        rps: 5,
        allowedServices: ["pubsub"],
        objectives: {
            primary: [
                { id: "notifications_sent", check: (s) => CampaignObjectives.completedByService(s, "notify") >= 180 },
                { id: "orders_stored", check: (s) => CampaignObjectives.completedByService(s, "db") >= 180 },
            ],
            bonus: [
                { id: "fail_under_5_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.05 },
                { id: "rep_above_90", check: (s) => s.reputation >= 90 },
            ],
        },
        // Deliberately NOT the usual 3x durationSec. The tight deadline is what
        // rules out the sequential shortcut (wire the balancer to both consumers
        // and it round-robins, so each gets half the events and neither target
        // lands in time). Fan-out delivers a copy to BOTH, which is the lesson.
        failConditions: { repBelow: 40, timeoutSec: 75 },
    },

    // ===== Chapter 4 (cont.): Multi-region failover (#221) =====
    // The mechanics already existed — GeoDNS round-robins across its routable
    // front doors (#198) — so this level's job is to make the player USE them:
    // build the second region before the announced kill, watch traffic shift
    // away, and watch it shift back when the region returns.
    {
        id: 20, chapter: 4,
        icon: "🌐",
        diagramHighlights: { 1: "critical" },
        // Region B costs exactly $150 (WAF 40 + ALB 50 + Compute 60); the rest
        // is slack for a late reaction, not for a second Compute upgrade —
        // duplicating the stack, not gold-plating one region, is the lesson.
        budget: 190,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "dns", x: -30, z: 0 },
                { type: "waf", x: -20, z: 7 },
                { type: "alb", x: -10, z: 7 },
                { type: "compute", x: 0, z: 7 },
                { type: "db", x: 12, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3], [3, 4]],
        },
        // Tuned by headless playthrough: non-MALICIOUS arrival (~4.7 rps) sits
        // just under ONE Tier-1 Compute's throughput (~5.2 rps for this mix),
        // so a single region carries the BASELINE cleanly — the level must be
        // lost to the outage, not to background overload — and the surviving
        // region alone carries the outage strained but alive. At rps 6 the
        // lone region started drowning at ~22s, before the announced kill.
        trafficDistribution: { STATIC: 0, READ: 0.55, WRITE: 0.2, UPLOAD: 0, SEARCH: 0.1, MALICIOUS: 0.15 },
        rps: 5.5,
        forceRegionOutageAtSec: 35,
        regionOutageDurationSec: 25,
        allowedServices: ["waf", "alb", "compute"],
        objectives: {
            primary: [
                { id: "survived_region", check: (s) => CampaignObjectives.survivedNodeFailure(s, 70) },
                { id: "serve_300", check: (s) => CampaignObjectives.totalCompleted(s) >= 300 },
            ],
            bonus: [
                { id: "outage_throughput", check: (s) => CampaignObjectives.completedDuringRegionOutage(s) >= 60 },
                { id: "rep_above_85", check: (s) => s.reputation >= 85 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 270 },
    },

    // ===== Chapter 5: The AI Wave (#87) =====
    // GPU inference serving — the batch engine, model cold starts, quality
    // tiers, the SLO deadline queue and the power wall. Levels 1-20 are
    // deliberately untouched (the same rule every chapter has shipped under):
    // new mechanics get new levels. Spec:
    // docs/superpowers/specs/2026-07-30-ai-wave-design.md §5.
    {
        id: 21, chapter: 5,
        icon: "🤖",
        diagramHighlights: { 2: "critical" },
        // Tuned by headless playthrough (5 consecutive runs, all three
        // directions). The arithmetic the knobs encode: INFERENCE arrives at
        // 3.0 × 0.6 = 1.8/s and every unserved one is −1 rep, so a model
        // (re)load is a rep hole — 12s tier-1 cold start ≈ −21, 20s tier-2
        // reload ≈ −34. The winning play buys the GPU AND upgrades it before
        // pressing Play: the upgrade re-triggers the load, so the two holes
        // collapse into ONE 20s reload (trough 63-74, recovery ≈ +0.25/s,
        // rep 75-90 at the win, t≈60-71). Upgrading at the 45s surge instead
        // pays BOTH holes plus the burst's losses — measured rep 46-65 at
        // the 90s timeout, the win objectives still unmet. Budget 560 = GPU
        // 300 + tier-2 200 + enough slack that the mid-surge upgrade still
        // fires after 45s of upkeep (a silently unaffordable upgrade would
        // turn the ignore-run into an accidental tier-1 win). Two prebuilt
        // Computes because the burst funnels through them into the GPU: one
        // Tier-1 Compute made the shared chokepoint, not the GPU, the
        // dominant loss in EVERY run. Staying on tier 1 survives the primaries
        // (rep 81-96) — the 10% bad-answer rate is what the bonus star
        // punishes (tier-1 accrues ~8 by the win, tier-2 0-6, threshold 6;
        // note the quality tax itself never LOWERS rep — −0.5 against +0.1
        // per success only halves recovery, see QUALITY_RISK_REPUTATION).
        budget: 560,
        durationSec: 90,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 6 },
                { type: "compute", x: 0, z: -6 },
                { type: "db", x: 10, z: 0 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [1, 3], [2, 4], [3, 4]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.25, WRITE: 0.1, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05, INFERENCE: 0.6 },
        rps: 3.0,
        burstPattern: { enabled: true, intervalSec: 45, burstSize: 14 },
        allowedServices: ["gpu"],
        objectives: {
            primary: [
                { id: "serve_80_inference", check: (s) => CampaignObjectives.completedOfType(s, "INFERENCE") >= 80 },
                { id: "rep_above_65", check: (s) => s.reputation >= 65 },
            ],
            bonus: [
                { id: "few_bad_answers", check: (s) => CampaignObjectives.totalBadAnswers(s) < 6 },
                { id: "rep_above_80", check: (s) => s.reputation >= 80 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 90 },
    },

    {
        id: 22, chapter: 5,
        icon: "📦",
        diagramHighlights: { 1: "critical" },
        // Tuned by headless playthrough. INFERENCE arrives at 3.5 × 0.7 =
        // 2.45/s against a tier-1 GPU's saturated ceiling of ~2.98/s — ONE
        // GPU runs ~82% full (above the ~50% break-even fill), TWO behind the
        // gateway's least-loaded dispatch run ~41% each (below it). The whole
        // stack bleeds ~$0.48/s either way (upkeep + DDoS mitigation exceed
        // this reward mix), so the profit objective is a floor, level-10
        // style: one GPU + gateway = $370 of purchases lands at netProfit
        // −$399..−429 when serve-120 completes (t≈55-60) — inside −$500 —
        // while the $670 two-GPU build runs out the 150s timeout at
        // −$900..−916: ~$400 past the floor, and latched, because purchases
        // never refund into netProfit (demolishing the extra GPU pays back
        // money, not P&L). The substation is PREBUILT so the second-GPU trap is
        // actually placeable — the power gate would otherwise refuse it and
        // defuse the lesson (and level 24 owns the watts).
        budget: 750,
        durationSec: 100,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 0 },
                { type: "db", x: 10, z: 0 },
                { type: "power", x: -10, z: -10 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.15, WRITE: 0.05, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.1, INFERENCE: 0.7 },
        rps: 3.5,
        allowedServices: ["gpu", "infgw"],
        objectives: {
            primary: [
                { id: "serve_120_inference", check: (s) => CampaignObjectives.completedOfType(s, "INFERENCE") >= 120 },
                { id: "profit_floor", check: (s) => CampaignObjectives.netProfit(s) >= -500 },
            ],
            bonus: [
                { id: "rep_above_85", check: (s) => s.reputation >= 85 },
                { id: "few_bad_answers", check: (s) => CampaignObjectives.totalBadAnswers(s) < 20 },
            ],
        },
        failConditions: { repBelow: 40, timeoutSec: 150 },
    },

    {
        id: 23, chapter: 5,
        icon: "⏱️",
        diagramHighlights: { 4: "critical", 5: "critical" },
        // Tuned by headless playthrough. Demand: 3.0 base + 15-per-6s bursts
        // ≈ 5.5 rps, 80% INFERENCE ≈ 4.4/s — permanently ABOVE one tier-1
        // GPU's ~2.98/s ceiling and comfortably under two (~5.95/s), so the
        // fix is a second GPU (budget 400 = 300 + slack; the prebuilt
        // substation raises the cap to 14 kW, exactly two — the power lesson
        // is deliberately defused here). INFERENCE bypasses the compute tier
        // (alb → infgw prebuilt), so the bursts land on the deadline queue,
        // which is the point. Do nothing and the ~1.4/s deficit dies at the
        // deadline queue: the gateway's warmup grace covers the 12s cold
        // start, then expiries plus held-20 overflow drops drain rep through
        // the 30% floor at t≈45-81, 19-32 already on the expiry counter and
        // climbing ~1/s toward the 30-expiry primary at the loss. Delete
        // the gateway and direct-wire instead, and the same deficit dies as
        // NO_ROUTE/QUEUE_FULL at the GPU's 8-slot intake with ZERO expiries
        // — which is exactly what the failure-rate leg is for: measured
        // 0.85-0.88 against the 0.12 ceiling, dead in ~22s. The winning
        // fleet rides the grace through the cold start with ZERO expiries
        // (both models load together, then the fleet drains the backlog),
        // wins at t≈67-70 — the 20-expiry bonus star included.
        budget: 400,
        durationSec: 100,
        preBuilt: {
            services: [
                { type: "waf", x: -22, z: 0 },
                { type: "alb", x: -12, z: 0 },
                { type: "compute", x: -2, z: 8 },
                { type: "db", x: 10, z: 8 },
                { type: "infgw", x: -2, z: -6 },
                { type: "gpu", x: 10, z: -6 },
                { type: "power", x: -22, z: -10 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3], [1, 4], [4, 5]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.12, WRITE: 0.03, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05, INFERENCE: 0.8 },
        rps: 3.0,
        burstPattern: { enabled: true, intervalSec: 6, burstSize: 15 },
        allowedServices: ["gpu"],
        objectives: {
            primary: [
                { id: "serve_250_inference", check: (s) => CampaignObjectives.completedOfType(s, "INFERENCE") >= 250 },
                { id: "fail_under_12_pct", check: (s) => CampaignObjectives.failureRate(s) < 0.12 },
                { id: "few_expiries", check: (s) => CampaignObjectives.expiredRequests(s) < 30 },
            ],
            bonus: [
                { id: "rep_above_75", check: (s) => s.reputation >= 75 },
                { id: "expiries_under_20", check: (s) => CampaignObjectives.expiredRequests(s) < 20 },
            ],
        },
        failConditions: { repBelow: 30, timeoutSec: 240 },
    },

    {
        id: 24, chapter: 5,
        icon: "🔋",
        diagramHighlights: { 1: "critical" },
        // Tuned by headless playthrough (8 runs per direction). INFERENCE
        // arrives at 8.5 × 0.85 ≈ 7.2/s — nearly double a maxed tier-3
        // single GPU (~3.8/s) and, crucially, DECISIVELY above two tier-1s
        // (~5.95/s): the ~1.26/s deficit bleeds −1 rep each, more than the
        // +0.60/s the served traffic earns back, so the one-substation
        // two-GPU cheese provably loses (0/16, rep through the 25% floor at
        // t≈33-71 — chapter5.test pins the inequality). Three tier-1 GPUs
        // (~8.9/s ceiling, ~81% fill each — above break-even) need 18 kW:
        // base 8 + TWO substations, the marginal-watts decision the whole
        // level exists for. Budget 1400 = 2×150 + 3×300 + 70 gateway + $130
        // slack — money is deliberately NOT the constraint. The gateway's
        // warmup grace holds the 12s cold-start flood expiry-free (measured
        // 0; the overflow past its held-20 dies as QUEUE_FULL): rep bottoms
        // 38-51 and recovers to the 55% objective, serve-300 lands t≈54-58
        // at rep 57-72 (16/16 wins). Without a substation the grid caps the
        // fleet at ONE GPU (6 of 8 kW): a ~4.2/s deficit bleeds −1 rep each
        // through the 25% floor in ~18-20s. The 240s timeout is sized for a
        // player who detours through tier-3 first (a 30s reload per
        // experiment, spec §5).
        budget: 1400,
        durationSec: 100,
        preBuilt: {
            services: [
                { type: "waf", x: -20, z: 0 },
                { type: "alb", x: -10, z: 0 },
                { type: "compute", x: 0, z: 8 },
                { type: "db", x: 10, z: 8 },
            ],
            connections: [["internet", 0], [0, 1], [1, 2], [2, 3]],
        },
        trafficDistribution: { STATIC: 0, READ: 0.1, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0.05, INFERENCE: 0.85 },
        rps: 8.5,
        allowedServices: ["gpu", "power", "infgw"],
        objectives: {
            primary: [
                { id: "serve_300_inference", check: (s) => CampaignObjectives.completedOfType(s, "INFERENCE") >= 300 },
                { id: "rep_above_55", check: (s) => s.reputation >= 55 },
            ],
            bonus: [
                { id: "rep_above_65", check: (s) => s.reputation >= 65 },
                { id: "three_gpus", check: (s) => CampaignObjectives.countServices(s, "gpu") >= 3 },
            ],
        },
        failConditions: { repBelow: 25, timeoutSec: 240 },
    },

    {
        id: 25, chapter: 5,
        icon: "🧠",
        diagramHighlights: { 3: "critical", 4: "critical" },
        // Tuned by headless playthrough. The classic stack is PREBUILT and
        // serverless on purpose: netProfit counts purchases, and under
        // survival-shift economics (a DDoS spike every 45s halves income and
        // quintuples mitigation for 12s) the whole board only nets
        // ~+$1.5-2/s — a greenfield build could never buy itself back inside
        // the timeout, and a Compute tier dies outright to the ×3
        // traffic-burst event (30 rps vs ~66/s of serverless headroom).
        // Everything is doubled (ALBs, DBs, storage) because the random
        // SERVICE_OUTAGE event disables one node for 30s — routing fails
        // over to the wired twin instead of bleeding −1/s. The player's job
        // is the AI layer: GPU ($300) + the tier-2 upgrade ($200) in a LULL
        // — deferring the reload past a live hype wave is the difference
        // between 12/12 wins (t≈158-280, netProfit 0..+748 at the win) and
        // an upgrade-into-the-wave rep collapse; the harness scripts exactly
        // that patience. The serve-150 leg is what makes the no-GPU run
        // provably lose: the classic traffic shifts carry no INFERENCE
        // share, so the 12% base bleed pauses during every shift and rep
        // stabilizes in the 80s-90s — rep alone cannot condemn the run
        // inside the 450s timeout, zero INFERENCE served can (measured 8/8
        // timeouts, serve leg unmet, rep 88-97). Bonus: tier-2's 4% risk
        // accrues 4-9 bad answers by the win against 20; tier-1's 10%
        // crosses ~28.
        budget: 900,
        durationSec: 300,
        preBuilt: {
            services: [
                { type: "waf", x: -26, z: 0 },
                { type: "alb", x: -18, z: 6 },
                { type: "alb", x: -18, z: -6 },
                { type: "serverless", x: -8, z: 6 },
                { type: "serverless", x: -8, z: -6 },
                { type: "db", x: 4, z: 10 },
                { type: "db", x: 12, z: 10 },
                { type: "s3", x: 4, z: -10 },
                { type: "s3", x: 12, z: -10 },
            ],
            connections: [
                ["internet", 0], [0, 1], [0, 2],
                [1, 3], [1, 4], [2, 3], [2, 4],
                [3, 5], [4, 5], [3, 6], [4, 6],
                [3, 7], [4, 7], [3, 8], [4, 8],
            ],
        },
        trafficDistribution: { STATIC: 0.2, READ: 0.24, WRITE: 0.14, UPLOAD: 0.06, SEARCH: 0.14, MALICIOUS: 0.1, INFERENCE: 0.12 },
        rps: 10,
        enableSurvivalShifts: true,
        allowedServices: [],
        objectives: {
            primary: [
                { id: "survive_120s", check: (s) => s.elapsedGameTime >= 120 },
                { id: "serve_150_inference", check: (s) => CampaignObjectives.completedOfType(s, "INFERENCE") >= 150 },
                { id: "rep_above_55", check: (s) => s.reputation >= 55 },
                { id: "net_profit", check: (s) => CampaignObjectives.netProfit(s) >= 0 },
            ],
            bonus: [
                { id: "few_bad_answers", check: (s) => CampaignObjectives.totalBadAnswers(s) < 20 },
                { id: "rep_above_75", check: (s) => s.reputation >= 75 },
            ],
        },
        failConditions: { repBelow: 20, moneyBelow: -500, timeoutSec: 450 },
    },
];
