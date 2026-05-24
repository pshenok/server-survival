# Campaign Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 14-level Campaign Mode that teaches one cloud-infrastructure concept per level through hand-crafted scenarios with briefing, real-time objectives, and debrief.

**Architecture:** New `src/campaign/` directory with four small modules (levels registry, objectives library, SVG diagram generator, controller). Hooks into existing `STATE`, `Service`, `Request`, and the animate loop via a new `gameMode === "campaign"` branch in `resetGame()`. Three new modals in `index.html` (Level Select, Briefing, Debrief). All EN-only on first release.

**Tech Stack:** Vanilla JS (ES6+), Three.js (existing), Tailwind CDN (existing). No build step. No automated test framework — verification is manual browser checks per task.

**Spec:** `docs/superpowers/specs/2026-05-24-campaign-mode-design.md`

**Branch:** `feat/campaign-mode` (cut from current `main`)

**Note for executor:** This project has no test runner. Each "verify" step opens the game in a browser (`python3 -m http.server`) and runs a checklist. Be explicit with the user about what was clicked and what was observed. Never claim a step passes without actually clicking through it.

---

## File Map (locked-in decomposition)

**Created:**
- `src/campaign/levels.js` — `CAMPAIGN_LEVELS` array, all 14 level configs (data only)
- `src/campaign/objectives.js` — pure functions for objective checks (`dbLoadBelow`, `cacheHitRate`, `totalFailures`, etc.)
- `src/campaign/diagram.js` — `renderArchitectureSVG(preBuilt, highlights)` returning SVG string
- `src/campaign/campaign.js` — `CampaignController` (load, tick, win/lose, persistence). Exposes `window.campaign`.

**Modified:**
- `index.html` — script tags for new files, Campaign button in main menu, three new modal divs
- `game.js` — `gameMode === "campaign"` branch in `resetGame()`, `animate()` calls `campaign.tick()`, toolbar gating, new top-level `startCampaign()`, `startCampaignLevel(id)`, `exitCampaignToMap()`
- `src/state.js` — add `STATE.campaign` initial structure
- `src/locales/en.js` — all EN i18n keys for campaign UI (other locales get same keys as fallback)
- `src/locales/{zh,pt-BR,de,fr,ko,nep}.js` — fallback keys

**Untouched:** `Service.js`, `Request.js`, `SoundService.js`, `tutorial.js`, `config.js`, `style.css`.

---

## Task 1: Branch scaffold + empty modules + script wiring

**Files:**
- Create: `src/campaign/levels.js`
- Create: `src/campaign/objectives.js`
- Create: `src/campaign/diagram.js`
- Create: `src/campaign/campaign.js`
- Modify: `index.html` (script tags)
- Modify: `src/state.js` (campaign state)

- [ ] **Step 1: Create feature branch from latest main**

```bash
cd /Users/kp/Projects/my/server-survival
git checkout main
git pull origin main
git checkout -b feat/campaign-mode
```

- [ ] **Step 2: Create empty module files with placeholder exports**

`src/campaign/levels.js`:
```js
// Campaign level definitions.
// Each level is a declarative config consumed by CampaignController.
// See docs/superpowers/specs/2026-05-24-campaign-mode-design.md for schema.
const CAMPAIGN_LEVELS = []; // Populated in Task 2
```

`src/campaign/objectives.js`:
```js
// Pure objective-check helpers. Each takes the live STATE and returns boolean.
// All checks are stateless and side-effect free.
const CampaignObjectives = {};
```

`src/campaign/diagram.js`:
```js
// SVG architecture diagram generator for Briefing modal.
// Renders a horizontal flow of service icons from a level's preBuilt array.
function renderArchitectureSVG(preBuilt, highlights) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"></svg>';
}
```

`src/campaign/campaign.js`:
```js
// Campaign mode controller. Single instance assigned to window.campaign.
class CampaignController {
  constructor() {
    this.active = false;
  }
  tick() {} // called from animate loop, no-op until Task 5
}
window.campaign = new CampaignController();
```

- [ ] **Step 3: Wire script tags in `index.html`**

In `index.html`, find the existing locale script block (around `<script src="src/i18n.js"></script>`). Add immediately after `<script src="src/tutorial.js"></script>` (or after `i18n.js` if `tutorial.js` isn't loaded there):

```html
<script src="src/campaign/objectives.js"></script>
<script src="src/campaign/diagram.js"></script>
<script src="src/campaign/levels.js"></script>
<script src="src/campaign/campaign.js"></script>
```

**Order matters:** `campaign.js` depends on the other three.

- [ ] **Step 4: Add campaign state to `src/state.js`**

Inside the `STATE` object literal, after the existing `intervention: { ... }` block, add:

```js
,
// Campaign mode runtime state. Populated by CampaignController when active.
campaign: {
    active: false,
    currentLevelId: null,
    level: null,            // level config object
    objectiveResults: {},   // { objectiveId: boolean }
    bonusResults: {},
    startedAt: 0,
    ended: false,
    outcome: null,          // "win" | "lose" | null
    failureReason: null,
}
```

- [ ] **Step 5: Verify game still loads (manual)**

Run `python3 -m http.server 8091 &` from project root. Open `http://localhost:8091/index.html`. Confirm:
- Main menu renders
- Browser console has zero errors
- `window.campaign` exists in console
- `CAMPAIGN_LEVELS` exists (returns `[]`)

- [ ] **Step 6: Commit**

```bash
git add src/campaign/ src/state.js index.html
git commit -m "feat(campaign): scaffold campaign module + state + script wiring"
```

---

## Task 2: Define all 14 levels in `levels.js`

**Files:**
- Modify: `src/campaign/levels.js` (replace placeholder with full data)

- [ ] **Step 1: Replace `CAMPAIGN_LEVELS` with the full 14-level array**

Open `src/campaign/levels.js`. Replace its entire contents with the block below.

**Note on the schema:** every level has the same shape so the controller can treat them uniformly. Objective `check` functions receive `(STATE)` and return boolean. They reference helpers from `CampaignObjectives` (defined in Task 3) — these are not yet implemented but the references will resolve at call time because `objectives.js` loads before `levels.js`.

```js
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

const CAMPAIGN_LEVELS = [
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
    failConditions: { repBelow: 50 },
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
    failConditions: { repBelow: 50 },
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
    failConditions: { repBelow: 30 },
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
    trafficDistribution: { STATIC: 0.05, READ: 0.75, WRITE: 0.1, UPLOAD: 0, SEARCH: 0.05, MALICIOUS: 0.05 },
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
    failConditions: { repBelow: 30 },
    debriefTip: "Cache hit rate degrades for unique keys (e.g. SEARCH with random queries). Use it for repeated READs.",
  },

  {
    id: 5, chapter: 2,
    title: "Buffer the Spikes",
    scenario: "Your traffic is bursty — quiet for 5 seconds, then 20 requests at once. Compute can't keep up and requests drop.",
    learn: "Message Queue (max 200) buffers bursts so Compute processes them at its own pace. Prevents drops during spikes.",
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
    trafficDistribution: { STATIC: 0, READ: 0.5, WRITE: 0.35, UPLOAD: 0.05, SEARCH: 0.05, MALICIOUS: 0.05 },
    rps: 5,
    burstPattern: { enabled: true, intervalSec: 5, burstSize: 15 }, // honored by campaign-aware spawn
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
    failConditions: { repBelow: 40 },
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
    trafficDistribution: { STATIC: 0.1, READ: 0.45, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.15, MALICIOUS: 0.1 },
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
    failConditions: { repBelow: 40 },
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
    trafficDistribution: { STATIC: 0.05, READ: 0.2, WRITE: 0.1, UPLOAD: 0.05, SEARCH: 0.5, MALICIOUS: 0.1 },
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
    failConditions: { repBelow: 40 },
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
    trafficDistribution: { STATIC: 0.05, READ: 0.4, WRITE: 0.3, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.1 },
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
    failConditions: { repBelow: 40 },
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
    trafficDistribution: { STATIC: 0.1, READ: 0.4, WRITE: 0.2, UPLOAD: 0.05, SEARCH: 0.15, MALICIOUS: 0.1 },
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
    failConditions: { repBelow: 30 },
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
    allowedServices: [], // all allowed — choice is the lesson
    objectives: {
      primary: [
        { id: "profit_100", label: "Net profit ≥ $100 in 90s", check: (s) => CampaignObjectives.netProfit(s) >= 100 },
        { id: "rep_above_70", label: "Reputation above 70%", check: (s) => s.reputation >= 70 },
      ],
      bonus: [
        { id: "uses_serverless", label: "Used Serverless Function (no Compute)", check: (s) => CampaignObjectives.usesOnly(s, "serverless", ["compute"]) },
        { id: "speedrun", label: "Complete under 72s", check: (s) => s.elapsedGameTime <= 72 },
      ],
    },
    failConditions: { moneyBelow: -50, repBelow: 30 },
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
    trafficDistribution: { STATIC: 0.05, READ: 0.1, WRITE: 0.05, UPLOAD: 0.05, SEARCH: 0.05, MALICIOUS: 0.7 },
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
    failConditions: { repBelow: 20 },
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
    trafficDistribution: { STATIC: 0.1, READ: 0.4, WRITE: 0.2, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.15 },
    rps: 6,
    forceOutageAtSec: 30, // honored by campaign tick: disables service index 0 (first WAF) at this mark
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
    failConditions: { repBelow: 20 },
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
    allowedServices: [], // all allowed; choice is what to delete
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
    failConditions: { moneyBelow: -200 },
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
    enableSurvivalShifts: true, // honored by campaign tick: turn on survival's traffic shifts + DDoS spikes
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
    failConditions: { repBelow: 20, moneyBelow: -500 },
    debriefTip: "Congratulations, Architect. You've mastered the basics of cloud system design. Now try Survival mode for the real grind.",
  },
];
```

- [ ] **Step 2: Reload browser, verify 14 levels parsed**

Open `http://localhost:8091/index.html` and in console:
```js
CAMPAIGN_LEVELS.length        // 14
CAMPAIGN_LEVELS[0].title      // "The First Server"
CAMPAIGN_LEVELS[13].title     // "Black Friday"
```
All three should match. No console errors.

- [ ] **Step 3: Commit**

```bash
git add src/campaign/levels.js
git commit -m "feat(campaign): define all 14 level configs"
```

---

## Task 3: Implement objective check helpers in `objectives.js`

**Files:**
- Modify: `src/campaign/objectives.js`

These are referenced by level configs in Task 2. They must all be present.

- [ ] **Step 1: Replace `objectives.js` with full implementation**

```js
// Pure objective-check helpers. All take live STATE and return boolean or number.
// Stateless and side-effect free.

const CampaignObjectives = {
  // ---- counters tracked via STATE.campaign.completedByType (populated in Task 5) ----

  completedOfType(state, type) {
    return state.campaign?.completedByType?.[type] || 0;
  },

  totalCompleted(state) {
    const c = state.campaign?.completedByType || {};
    return Object.values(c).reduce((a, b) => a + b, 0);
  },

  totalFailures(state) {
    return Object.values(state.failures || {}).reduce((a, b) => a + b, 0);
  },

  failureRate(state) {
    const completed = CampaignObjectives.totalCompleted(state);
    const failed = CampaignObjectives.totalFailures(state);
    const total = completed + failed;
    return total === 0 ? 0 : failed / total;
  },

  // ---- service introspection ----

  hasService(state, type) {
    return (state.services || []).some((s) => s.type === type);
  },

  countServices(state, type) {
    return (state.services || []).filter((s) => s.type === type).length;
  },

  /** Returns true if state.services contains `requiredType` and none of `forbiddenTypes`. */
  usesOnly(state, requiredType, forbiddenTypes) {
    const types = new Set((state.services || []).map((s) => s.type));
    if (!types.has(requiredType)) return false;
    return forbiddenTypes.every((t) => !types.has(t));
  },

  // ---- load checks (uses Service.totalLoad getter, range 0..1) ----

  maxLoadOfType(state, type) {
    const services = (state.services || []).filter((s) => s.type === type);
    if (services.length === 0) return 0;
    return Math.max(...services.map((s) => s.totalLoad || 0));
  },

  // ---- finance ----

  netProfit(state) {
    const inc = state.finances?.income?.total || 0;
    const exp = state.finances?.expenses || {};
    const expTotal =
      (exp.services || 0) + (exp.upkeep || 0) + (exp.repairs || 0) +
      (exp.autoRepair || 0) + (exp.mitigation || 0) + (exp.breach || 0);
    return inc - expTotal;
  },

  totalUpkeepPerSec(state) {
    return (state.services || []).reduce((sum, s) => sum + (s.config.upkeep || 0) / 60, 0);
  },

  // ---- request-type counters (need campaign.tick() to bump these — see Task 5) ----

  replicaShareOfReads(state) {
    const reads = state.campaign?.completedByType?.READ || 0;
    const viaReplica = state.campaign?.completedByService?.replica || 0;
    return reads === 0 ? 0 : viaReplica / reads;
  },

  nosqlShareOfWrites(state) {
    const writes = state.campaign?.completedByType?.WRITE || 0;
    const viaNosql = state.campaign?.completedByService?.nosql || 0;
    return writes === 0 ? 0 : viaNosql / writes;
  },
};
```

- [ ] **Step 2: Reload browser, smoke test**

In console:
```js
CampaignObjectives.totalFailures(STATE);   // 0 (no failures yet)
CampaignObjectives.hasService(STATE, "waf"); // false (no services)
typeof CampaignObjectives.netProfit         // "function"
```

- [ ] **Step 3: Commit**

```bash
git add src/campaign/objectives.js
git commit -m "feat(campaign): objective check helper library"
```

---

## Task 4: SVG diagram generator in `diagram.js`

**Files:**
- Modify: `src/campaign/diagram.js`

- [ ] **Step 1: Replace `diagram.js` with implementation**

```js
// Generates an SVG architecture diagram for the Briefing modal,
// based on a level's preBuilt.services + connections.
//
// Each service is drawn as a colored circle with its type label.
// "internet" is drawn as a dark globe on the left.
// Connections are simple lines between centers.
// `highlights[index] === "critical"` renders the node red with a flame.

const DIAGRAM_SERVICE_COLORS = {
  waf:        "#a855f7",
  alb:        "#3b82f6",
  compute:    "#f97316",
  serverless: "#fbbf24",
  db:         "#dc2626",
  nosql:      "#7c3aed",
  s3:         "#10b981",
  cdn:        "#4ade80",
  cache:      "#dc382d",
  sqs:        "#ff9900",
  apigw:      "#e879f9",
  search:     "#06b6d4",
  replica:    "#f472b6",
};

const DIAGRAM_SERVICE_LABELS = {
  waf: "FW", alb: "LB", compute: "CPU", serverless: "λ",
  db: "SQL", nosql: "NoSQL", s3: "S3", cdn: "CDN",
  cache: "Cache", sqs: "Queue", apigw: "API GW",
  search: "Search", replica: "Replica",
};

/**
 * @param {{services:{type:string,x:number,z:number}[], connections:Array<[string|number,number]>}} preBuilt
 * @param {Object<number,string>} highlights e.g. { 3: "critical" }
 * @returns {string} SVG markup
 */
function renderArchitectureSVG(preBuilt, highlights = {}) {
  const services = preBuilt.services || [];
  const connections = preBuilt.connections || [];

  // Layout: spread Internet on the far left, services in a horizontal flow
  // ordered by their original x coordinate.
  const positions = {};
  positions.internet = { x: 40, y: 80 };

  const sorted = services
    .map((s, i) => ({ idx: i, x: s.x, z: s.z, type: s.type }))
    .sort((a, b) => a.x - b.x);

  // Spread services evenly across width 120..560 (image area)
  const spread = sorted.length === 0 ? 0 : (520 - 120) / Math.max(1, sorted.length - 1);
  sorted.forEach((s, i) => {
    positions[s.idx] = {
      x: 120 + i * (sorted.length === 1 ? 200 : spread),
      y: 80 + s.z * 4, // small vertical offset by z
    };
  });

  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160" width="100%" height="160">';

  // Background grid lines for visual interest
  svg += '<defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">';
  svg += '<path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1f2937" stroke-width="0.5"/>';
  svg += '</pattern></defs>';
  svg += '<rect width="600" height="160" fill="#0b1220"/>';
  svg += '<rect width="600" height="160" fill="url(#grid)"/>';

  // Connections first (so they sit under nodes)
  for (const [from, to] of connections) {
    const a = positions[from];
    const b = positions[to];
    if (!a || !b) continue;
    svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#00FF85" stroke-width="2" opacity="0.6"/>`;
  }

  // Internet node
  svg += `<circle cx="${positions.internet.x}" cy="${positions.internet.y}" r="18" fill="#111111" stroke="#00ffff" stroke-width="2"/>`;
  svg += `<text x="${positions.internet.x}" y="${positions.internet.y + 4}" text-anchor="middle" fill="#00ffff" font-size="10" font-family="monospace">WWW</text>`;

  // Service nodes
  for (const s of sorted) {
    const p = positions[s.idx];
    const color = DIAGRAM_SERVICE_COLORS[s.type] || "#9ca3af";
    const label = DIAGRAM_SERVICE_LABELS[s.type] || s.type.toUpperCase();
    const isCritical = highlights[s.idx] === "critical";

    if (isCritical) {
      // red glow background
      svg += `<circle cx="${p.x}" cy="${p.y}" r="24" fill="#ef4444" opacity="0.3"><animate attributeName="r" values="20;28;20" dur="1.5s" repeatCount="indefinite"/></circle>`;
    }
    svg += `<circle cx="${p.x}" cy="${p.y}" r="18" fill="${color}" stroke="${isCritical ? "#ef4444" : "#1f2937"}" stroke-width="2"/>`;
    svg += `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" fill="#0b1220" font-size="9" font-weight="bold" font-family="monospace">${label}</text>`;
    if (isCritical) {
      svg += `<text x="${p.x}" y="${p.y - 22}" text-anchor="middle" font-size="14">🔥</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}
```

- [ ] **Step 2: Smoke test in console**

```js
const lvl = CAMPAIGN_LEVELS[3]; // "Cache the DB"
const svg = renderArchitectureSVG(lvl.preBuilt, lvl.diagramHighlights);
document.body.insertAdjacentHTML('beforeend', svg);
```
Confirm an SVG appears at the bottom of the page: shows WWW → WAF → LB → CPU → SQL with the SQL node pulsing red. Remove the inserted SVG (refresh page) before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/campaign/diagram.js
git commit -m "feat(campaign): SVG architecture diagram generator"
```

---

## Task 5: Campaign controller in `campaign.js`

**Files:**
- Modify: `src/campaign/campaign.js`

This is the largest task. It owns: loading a level, tracking per-type/per-service completed counts, evaluating objectives every tick, win/lose detection, and progress persistence.

- [ ] **Step 1: Replace `campaign.js` with full controller**

```js
// Campaign mode controller. Owns level lifecycle, objective evaluation,
// win/lose detection, and progress persistence.
//
// Persistence schema (localStorage key "serverSurvivalCampaignProgress"):
//   {
//     version: 1,
//     completed: { [levelId]: { stars: 1..3, bestTimeSec: number, lastPlayed: ms } },
//     highestUnlocked: number
//   }

const CAMPAIGN_STORAGE_KEY = "serverSurvivalCampaignProgress";
const CAMPAIGN_PROGRESS_VERSION = 1;

class CampaignController {
  constructor() {
    this.active = false;
    this._tickCounter = 0;
  }

  // ---- Persistence ----

  loadProgress() {
    try {
      const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
      if (!raw) return this._emptyProgress();
      const parsed = JSON.parse(raw);
      if (parsed.version !== CAMPAIGN_PROGRESS_VERSION) return this._emptyProgress();
      return parsed;
    } catch (e) {
      console.warn("Campaign: failed to load progress, resetting", e);
      return this._emptyProgress();
    }
  }

  saveProgress(progress) {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(progress));
  }

  _emptyProgress() {
    return { version: CAMPAIGN_PROGRESS_VERSION, completed: {}, highestUnlocked: 1 };
  }

  isUnlocked(levelId) {
    return levelId <= this.loadProgress().highestUnlocked;
  }

  getStarsFor(levelId) {
    return this.loadProgress().completed[levelId]?.stars || 0;
  }

  totalStars() {
    const p = this.loadProgress();
    return Object.values(p.completed).reduce((sum, e) => sum + (e.stars || 0), 0);
  }

  completedCount() {
    return Object.keys(this.loadProgress().completed).length;
  }

  // ---- Level lifecycle ----

  loadLevel(levelId) {
    const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
    if (!level) {
      console.error("Campaign: unknown level", levelId);
      return false;
    }
    if (!this.isUnlocked(levelId)) {
      console.warn("Campaign: level locked", levelId);
      return false;
    }

    this.active = true;
    STATE.campaign.active = true;
    STATE.campaign.currentLevelId = levelId;
    STATE.campaign.level = level;
    STATE.campaign.objectiveResults = {};
    STATE.campaign.bonusResults = {};
    STATE.campaign.startedAt = performance.now();
    STATE.campaign.ended = false;
    STATE.campaign.outcome = null;
    STATE.campaign.failureReason = null;
    STATE.campaign.completedByType = { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 };
    STATE.campaign.completedByService = {};
    STATE.campaign.burstTimer = 0;
    STATE.campaign.outageFired = false;
    this._tickCounter = 0;
    return true;
  }

  // ---- Per-frame hook (called from animate loop) ----

  tick(dt) {
    if (!this.active || STATE.campaign.ended) return;

    // 1) Forced burst pattern (level config: burstPattern)
    const bp = STATE.campaign.level?.burstPattern;
    if (bp?.enabled) {
      STATE.campaign.burstTimer += dt;
      if (STATE.campaign.burstTimer >= bp.intervalSec) {
        STATE.campaign.burstTimer = 0;
        for (let i = 0; i < bp.burstSize; i++) {
          // Spawn helper exists in game.js; defer scheduling so they don't all hit same frame
          setTimeout(() => { if (typeof spawnRequest === "function") spawnRequest(); }, i * 20);
        }
      }
    }

    // 2) Forced service outage (level config: forceOutageAtSec)
    const outageAt = STATE.campaign.level?.forceOutageAtSec;
    if (outageAt && !STATE.campaign.outageFired && STATE.elapsedGameTime >= outageAt) {
      STATE.campaign.outageFired = true;
      // Disable the first WAF (index 0 in preBuilt). Find by chronological order.
      const target = (STATE.services || []).find((s) => s.type === "waf");
      if (target) {
        target.isDisabled = true;
        target.mesh.material.opacity = 0.3;
        target.mesh.material.transparent = true;
        if (typeof addInterventionWarning === "function") {
          addInterventionWarning(`Service outage: ${target.config.name} offline!`, "danger", 5000);
        }
      }
    }

    // 3) Re-evaluate objectives at 2 Hz
    this._tickCounter += dt;
    if (this._tickCounter >= 0.5) {
      this._tickCounter = 0;
      this._evaluateObjectives();
      this._checkEndConditions();
    }
  }

  // ---- Hooks called from finishRequest / failRequest in game.js (wired in Task 9) ----

  onRequestCompleted(req, viaServiceType) {
    if (!this.active) return;
    if (!STATE.campaign.completedByType[req.type]) STATE.campaign.completedByType[req.type] = 0;
    STATE.campaign.completedByType[req.type]++;
    if (viaServiceType) {
      STATE.campaign.completedByService[viaServiceType] =
        (STATE.campaign.completedByService[viaServiceType] || 0) + 1;
    }
  }

  // ---- Internal ----

  _evaluateObjectives() {
    const level = STATE.campaign.level;
    if (!level) return;

    for (const o of level.objectives.primary) {
      STATE.campaign.objectiveResults[o.id] = !!o.check(STATE);
    }
    for (const o of level.objectives.bonus) {
      STATE.campaign.bonusResults[o.id] = !!o.check(STATE);
    }

    // Notify UI (if listener registered)
    if (typeof renderCampaignObjectives === "function") {
      renderCampaignObjectives(level, STATE.campaign.objectiveResults, STATE.campaign.bonusResults);
    }
  }

  _checkEndConditions() {
    const level = STATE.campaign.level;
    if (!level) return;

    // FAIL conditions take priority
    const fc = level.failConditions || {};
    if (typeof fc.repBelow === "number" && STATE.reputation < fc.repBelow) {
      return this._end("lose", `Reputation dropped below ${fc.repBelow}%`);
    }
    if (typeof fc.moneyBelow === "number" && STATE.money < fc.moneyBelow) {
      return this._end("lose", `Money dropped below $${fc.moneyBelow}`);
    }
    if (typeof fc.timeoutSec === "number" && STATE.elapsedGameTime >= fc.timeoutSec) {
      // Treat as lose if primary objectives not met yet
      const allPrimary = level.objectives.primary.every((o) => STATE.campaign.objectiveResults[o.id]);
      if (!allPrimary) return this._end("lose", "Ran out of time");
    }

    // WIN: all primary objectives met
    const allPrimary = level.objectives.primary.every((o) => STATE.campaign.objectiveResults[o.id]);
    if (allPrimary) {
      return this._end("win");
    }
  }

  _end(outcome, reason) {
    STATE.campaign.ended = true;
    STATE.campaign.outcome = outcome;
    STATE.campaign.failureReason = reason || null;
    STATE.timeScale = 0; // freeze game

    if (outcome === "win") {
      const stars = this._calculateStars();
      const elapsed = STATE.elapsedGameTime;
      this._persistWin(STATE.campaign.currentLevelId, stars, elapsed);
    }

    // Notify UI (defined in Task 11)
    if (typeof showCampaignDebrief === "function") {
      showCampaignDebrief(outcome, reason, STATE.campaign.level);
    }
  }

  _calculateStars() {
    const level = STATE.campaign.level;
    let stars = 1; // base for completion

    // +1 if any bonus objective met
    const anyBonus = level.objectives.bonus.some((o) => STATE.campaign.bonusResults[o.id]);
    if (anyBonus) stars++;

    // +1 if speedrun (finished under durationSec * 0.8)
    if (STATE.elapsedGameTime <= level.durationSec * 0.8) stars++;

    return Math.min(3, stars);
  }

  _persistWin(levelId, stars, elapsed) {
    const progress = this.loadProgress();
    const existing = progress.completed[levelId] || { stars: 0, bestTimeSec: Infinity };
    progress.completed[levelId] = {
      stars: Math.max(existing.stars, stars),
      bestTimeSec: Math.min(existing.bestTimeSec, elapsed),
      lastPlayed: Date.now(),
    };
    progress.highestUnlocked = Math.max(progress.highestUnlocked, levelId + 1);
    this.saveProgress(progress);
  }

  exit() {
    this.active = false;
    STATE.campaign.active = false;
  }
}

window.campaign = new CampaignController();
```

- [ ] **Step 2: Smoke test in console**

```js
campaign.loadProgress()        // { version:1, completed:{}, highestUnlocked:1 }
campaign.isUnlocked(1)         // true
campaign.isUnlocked(2)         // false
campaign.totalStars()          // 0
campaign.completedCount()      // 0
```

- [ ] **Step 3: Commit**

```bash
git add src/campaign/campaign.js
git commit -m "feat(campaign): controller with lifecycle, objectives, persistence"
```

---

## Task 6: HTML markup for the three Campaign modals

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the three modals before the closing `</body>` tag**

Find the existing `</body>` tag in `index.html`. Immediately before it, insert:

```html
<!-- Campaign: Level Select Modal -->
<div id="campaign-select-modal"
  class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm hidden overflow-y-auto">
  <div class="min-h-screen flex items-start justify-center p-6">
    <div class="glass-panel rounded-2xl p-8 max-w-2xl w-full border border-yellow-500/30">
      <div class="flex justify-between items-center mb-6 border-b border-gray-700 pb-4">
        <h2 class="text-3xl font-bold text-yellow-400" data-i18n="campaign_select_title">CAMPAIGN</h2>
        <button onclick="exitCampaignToMenu()"
          class="text-gray-400 hover:text-white text-2xl">×</button>
      </div>
      <div id="campaign-levels-list" class="space-y-6">
        <!-- populated by renderCampaignLevels() -->
      </div>
    </div>
  </div>
</div>

<!-- Campaign: Briefing Modal -->
<div id="campaign-briefing-modal"
  class="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm hidden overflow-y-auto">
  <div class="min-h-screen flex items-center justify-center p-6">
    <div class="glass-panel rounded-2xl p-8 max-w-3xl w-full border border-cyan-500/30">
      <div class="flex items-center gap-4 mb-4">
        <div id="campaign-briefing-icon" class="text-5xl"></div>
        <div>
          <div class="text-xs text-gray-500 font-mono" id="campaign-briefing-chapter"></div>
          <h2 id="campaign-briefing-title" class="text-2xl font-bold text-white"></h2>
        </div>
      </div>

      <div id="campaign-briefing-diagram" class="my-4 rounded-lg overflow-hidden border border-gray-700"></div>

      <p id="campaign-briefing-scenario" class="text-gray-300 mb-4 leading-relaxed"></p>

      <div class="bg-blue-900/30 border border-blue-500/40 rounded-lg p-3 mb-3">
        <div class="text-blue-400 text-xs font-bold uppercase mb-1">📚 Learn</div>
        <p id="campaign-briefing-learn" class="text-gray-200 text-sm"></p>
      </div>

      <div class="bg-green-900/30 border border-green-500/40 rounded-lg p-3 mb-3">
        <div class="text-green-400 text-xs font-bold uppercase mb-1">🎯 Goals</div>
        <ul id="campaign-briefing-goals" class="text-gray-200 text-sm space-y-1"></ul>
      </div>

      <div class="bg-yellow-900/30 border border-yellow-500/40 rounded-lg p-3 mb-4">
        <div class="text-yellow-400 text-xs font-bold uppercase mb-1">⭐ Bonus</div>
        <ul id="campaign-briefing-bonus" class="text-gray-200 text-sm space-y-1"></ul>
      </div>

      <div class="flex justify-between gap-4">
        <button onclick="exitCampaignToMap()"
          class="bg-gray-700 hover:bg-gray-600 text-white py-3 px-6 rounded-lg font-mono uppercase text-sm">
          ← Back
        </button>
        <button onclick="campaignStartCurrentLevel()"
          class="bg-cyan-600 hover:bg-cyan-500 text-white py-3 px-8 rounded-lg font-mono uppercase text-sm font-bold">
          Start Level →
        </button>
      </div>
    </div>
  </div>
</div>

<!-- Campaign: Debrief Modal -->
<div id="campaign-debrief-modal"
  class="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm hidden">
  <div class="min-h-screen flex items-center justify-center p-6">
    <div class="glass-panel rounded-2xl p-8 max-w-md w-full text-center border border-gray-600">
      <div id="campaign-debrief-icon" class="text-6xl mb-2"></div>
      <h2 id="campaign-debrief-title" class="text-3xl font-bold mb-2 text-white"></h2>
      <div id="campaign-debrief-stars" class="text-3xl mb-4"></div>
      <p id="campaign-debrief-reason" class="text-gray-400 mb-3 text-sm"></p>
      <div class="bg-blue-900/30 border border-blue-500/40 rounded-lg p-3 mb-6 text-left">
        <div class="text-blue-400 text-xs font-bold uppercase mb-1">💡 Tip</div>
        <p id="campaign-debrief-tip" class="text-gray-200 text-sm"></p>
      </div>
      <div class="flex justify-center gap-3">
        <button onclick="campaignRetryLevel()"
          class="bg-yellow-600 hover:bg-yellow-500 text-white py-3 px-6 rounded-lg font-mono uppercase text-sm">
          Retry
        </button>
        <button id="campaign-debrief-next-btn" onclick="campaignNextLevel()"
          class="bg-green-600 hover:bg-green-500 text-white py-3 px-6 rounded-lg font-mono uppercase text-sm hidden">
          Next →
        </button>
        <button onclick="exitCampaignToMap()"
          class="bg-gray-700 hover:bg-gray-600 text-white py-3 px-6 rounded-lg font-mono uppercase text-sm">
          Map
        </button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Reload, verify modals exist but stay hidden**

In console:
```js
document.getElementById("campaign-select-modal").classList.contains("hidden")    // true
document.getElementById("campaign-briefing-modal").classList.contains("hidden")  // true
document.getElementById("campaign-debrief-modal").classList.contains("hidden")   // true
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(campaign): add Level Select, Briefing, Debrief modal markup"
```

---

## Task 7: Campaign button in main menu + render functions

**Files:**
- Modify: `index.html` (button)
- Modify: `game.js` (render and navigation functions)

- [ ] **Step 1: Add Campaign button between Start Survival and Sandbox**

In `index.html`, find the existing `<button onclick="startGame()" ...>` (Start Survival). Immediately AFTER its closing `</button>`, add:

```html
<button onclick="openCampaignSelect()"
  class="w-full bg-yellow-600 hover:bg-yellow-500 text-white font-bold py-4 px-8 rounded-lg shadow-lg transform transition hover:scale-105 font-mono uppercase text-lg border border-yellow-400/50 flex justify-between items-center">
  <span data-i18n="campaign_mode">Campaign</span>
  <span id="campaign-progress-label" class="text-xs opacity-75 font-normal">0/14 ★0</span>
</button>
```

- [ ] **Step 2: Add navigation + render functions in `game.js`**

In `game.js`, after the existing `window.startSandbox = ...` block, add:

```js
// ===================== CAMPAIGN MODE =====================

window.openCampaignSelect = () => {
  document.getElementById("main-menu-modal").classList.add("hidden");
  document.getElementById("campaign-select-modal").classList.remove("hidden");
  renderCampaignLevels();
};

window.exitCampaignToMenu = () => {
  document.getElementById("campaign-select-modal").classList.add("hidden");
  document.getElementById("campaign-briefing-modal").classList.add("hidden");
  document.getElementById("campaign-debrief-modal").classList.add("hidden");
  document.getElementById("main-menu-modal").classList.remove("hidden");
};

window.exitCampaignToMap = () => {
  document.getElementById("campaign-briefing-modal").classList.add("hidden");
  document.getElementById("campaign-debrief-modal").classList.add("hidden");
  document.getElementById("campaign-select-modal").classList.remove("hidden");
  renderCampaignLevels();
  if (window.campaign?.active) window.campaign.exit();
};

function renderCampaignLevels() {
  const list = document.getElementById("campaign-levels-list");
  if (!list) return;
  const progress = window.campaign.loadProgress();
  const chapters = { 1: "Chapter 1: Basics", 2: "Chapter 2: Optimization", 3: "Chapter 3: Defense & Mastery" };
  let html = "";
  let lastChapter = -1;
  for (const lvl of CAMPAIGN_LEVELS) {
    if (lvl.chapter !== lastChapter) {
      if (lastChapter !== -1) html += "</div>";
      html += `<div class="text-yellow-400 text-sm font-bold uppercase tracking-wider mt-4 mb-2">${chapters[lvl.chapter]}</div>`;
      html += `<div class="space-y-2">`;
      lastChapter = lvl.chapter;
    }
    const unlocked = lvl.id <= progress.highestUnlocked;
    const entry = progress.completed[lvl.id];
    const stars = entry?.stars || 0;
    const starStr = unlocked ? ("★".repeat(stars) + "☆".repeat(3 - stars)) : "🔒";
    const time = entry ? ` · ${Math.round(entry.bestTimeSec)}s` : "";
    const clickHandler = unlocked ? `onclick="openCampaignBriefing(${lvl.id})"` : "";
    const cursor = unlocked ? "cursor-pointer hover:bg-gray-800/60" : "opacity-50 cursor-not-allowed";
    html += `
      <div ${clickHandler}
        class="border border-gray-700 rounded-lg p-3 ${cursor} transition flex items-center gap-3">
        <div class="text-3xl">${lvl.icon}</div>
        <div class="flex-1">
          <div class="text-white font-bold">${lvl.id}. ${lvl.title}</div>
          <div class="text-gray-400 text-xs">${lvl.scenario.slice(0, 80)}${lvl.scenario.length > 80 ? "…" : ""}</div>
        </div>
        <div class="text-yellow-400 font-mono text-sm">${starStr}${time}</div>
      </div>`;
  }
  html += "</div>";
  list.innerHTML = html;
  updateCampaignProgressLabel();
}

function updateCampaignProgressLabel() {
  const el = document.getElementById("campaign-progress-label");
  if (!el) return;
  const c = window.campaign;
  el.textContent = `${c.completedCount()}/${CAMPAIGN_LEVELS.length} ★${c.totalStars()}`;
}
```

- [ ] **Step 3: Verify in browser**

Hard-reload. Click `Campaign` in main menu. Level Select modal should appear with:
- 3 chapter headers
- Level 1 unlocked (clickable, has ☆☆☆), levels 2-14 with 🔒
- `×` button closes back to main menu

Click level 1 — should error (no `openCampaignBriefing` yet). That's expected — wired in Task 8.

- [ ] **Step 4: Commit**

```bash
git add index.html game.js
git commit -m "feat(campaign): main menu button + level select renderer"
```

---

## Task 8: Briefing modal renderer

**Files:**
- Modify: `game.js`

- [ ] **Step 1: Add briefing functions in `game.js`**

Append after the `updateCampaignProgressLabel` function:

```js
let _pendingCampaignLevelId = null;

window.openCampaignBriefing = (levelId) => {
  const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
  if (!level) return;
  _pendingCampaignLevelId = levelId;

  document.getElementById("campaign-select-modal").classList.add("hidden");
  document.getElementById("campaign-briefing-modal").classList.remove("hidden");

  document.getElementById("campaign-briefing-icon").textContent = level.icon;
  document.getElementById("campaign-briefing-chapter").textContent =
    `Chapter ${level.chapter} · Level ${level.id}`;
  document.getElementById("campaign-briefing-title").textContent = level.title.toUpperCase();
  document.getElementById("campaign-briefing-scenario").textContent = level.scenario;
  document.getElementById("campaign-briefing-learn").textContent = level.learn;

  document.getElementById("campaign-briefing-diagram").innerHTML =
    renderArchitectureSVG(level.preBuilt, level.diagramHighlights);

  document.getElementById("campaign-briefing-goals").innerHTML =
    level.objectives.primary.map((o) => `<li>• ${o.label}</li>`).join("");
  document.getElementById("campaign-briefing-bonus").innerHTML =
    level.objectives.bonus.map((o) => `<li>• ${o.label}</li>`).join("");
};

window.campaignStartCurrentLevel = () => {
  const id = _pendingCampaignLevelId;
  if (!id) return;
  document.getElementById("campaign-briefing-modal").classList.add("hidden");
  startCampaignLevel(id);
};
```

`startCampaignLevel` is wired in Task 9. For now this will error on click — expected.

- [ ] **Step 2: Verify in browser**

Open game → Campaign → click Level 1.
- Briefing modal opens
- Icon (🚀), chapter/level header, title `THE FIRST SERVER`, scenario text all visible
- SVG diagram renders (empty for level 1 since `preBuilt.services = []`)
- Goals list and Bonus list shown
- `← Back` returns to Level Select
- `Start Level →` errors in console (`startCampaignLevel not defined`) — expected, Task 9 fixes this

- [ ] **Step 3: Commit**

```bash
git add game.js
git commit -m "feat(campaign): briefing modal renderer"
```

---

## Task 9: In-game integration — `resetGame` campaign branch + pre-build + toolbar gating

**Files:**
- Modify: `game.js`

- [ ] **Step 1: Add `startCampaignLevel` function in `game.js`**

Append after `campaignStartCurrentLevel`:

```js
window.startCampaignLevel = (levelId) => {
  const level = CAMPAIGN_LEVELS.find((l) => l.id === levelId);
  if (!level) return;

  if (!window.campaign.loadLevel(levelId)) return;

  resetGame("campaign");

  // Pre-place services using survival's existing creation path (bypasses cost check)
  const placed = [];
  for (const s of level.preBuilt.services) {
    const pos = new THREE.Vector3(s.x, 0, s.z);
    const svc = new Service(s.type, pos);
    STATE.services.push(svc);
    placed.push(svc);
    if (STATE.finances) {
      STATE.finances.expenses.countByService[s.type] =
        (STATE.finances.expenses.countByService[s.type] || 0) + 1;
    }
  }
  // Pre-place connections (no cost validation, direct push)
  for (const [from, to] of level.preBuilt.connections) {
    const fromId = from === "internet" ? "internet" : placed[from].id;
    const toId = placed[to].id;
    createConnection(fromId, toId);
  }
  updateRepairCostTable();

  // Apply level-specific forced settings
  STATE.trafficDistribution = { ...level.trafficDistribution };
  STATE.currentRPS = level.rps;
  STATE.money = level.budget;

  // Toolbar gating
  applyCampaignToolbarGating(level.allowedServices, level.forbiddenServices);

  // Auto-start at 1× — no need to press Play
  setTimeScale(1);
};

function applyCampaignToolbarGating(allowed, forbidden) {
  // Map service config keys to their toolbar button IDs.
  // (matches the toolbar typeMap in mousedown handler)
  const toolMap = {
    waf: "tool-waf", apigw: "tool-apigw", sqs: "tool-sqs", alb: "tool-alb",
    lambda: "tool-lambda", serverless: "tool-serverless",
    db: "tool-db", nosql: "tool-nosql", cache: "tool-cache",
    cdn: "tool-cdn", s3: "tool-s3", search: "tool-search", replica: "tool-replica",
  };

  // First clear any prior gating
  Object.values(toolMap).forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.remove("opacity-30", "pointer-events-none");
    btn.removeAttribute("data-campaign-blocked");
  });

  const allowSet = allowed && allowed.length ? new Set(allowed) : null;
  const blockSet = new Set(forbidden || []);

  // The "lambda" tool is a button for compute service.
  // Normalize: allowSet uses CONFIG keys, but toolMap key for compute is "lambda".
  // To gate compute, accept both "compute" and "lambda" in allowed/forbidden lists.
  const isAllowed = (toolKey) => {
    if (!allowSet) return !blockSet.has(toolKey) && !blockSet.has(toolKey === "lambda" ? "compute" : toolKey);
    if (allowSet.has(toolKey)) return true;
    if (toolKey === "lambda" && allowSet.has("compute")) return true;
    return false;
  };

  Object.entries(toolMap).forEach(([k, id]) => {
    if (!isAllowed(k)) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.add("opacity-30", "pointer-events-none");
      btn.setAttribute("data-campaign-blocked", "true");
    }
  });
}
```

- [ ] **Step 2: Add `gameMode === "campaign"` branch in `resetGame`**

Find `function resetGame(mode = "survival")` in `game.js`. After the existing `if (mode === "sandbox") { ... } else { ... }` block, modify so campaign also uses survival defaults but with the level-set values applied later. The simplest change: at the very top of `resetGame`, treat `"campaign"` like `"survival"` for default initialization (rep=100, fresh state, etc.) but skip the survival traffic distribution / startBudget since the level overrides them.

Locate the `if (mode === "sandbox") {` block. Just before it, insert:

```js
if (mode === "campaign") {
    STATE.money = 0; // will be set by startCampaignLevel from level.budget
    STATE.upkeepEnabled = true;
    STATE.trafficDistribution = { STATIC: 0.3, READ: 0.2, WRITE: 0.15, UPLOAD: 0.05, SEARCH: 0.1, MALICIOUS: 0.2 };
    STATE.currentRPS = 1; // overridden by level.rps
} else if (mode === "sandbox") {
```

…and change the existing `if (mode === "sandbox") {` to `} else if (mode === "sandbox") {` — i.e. weave the campaign branch into the existing if/else.

Verify the resulting flow looks like:
```js
if (mode === "campaign") { ... }
else if (mode === "sandbox") { ... }
else { /* survival defaults */ }
```

- [ ] **Step 3: Disable survival's smart hints + ramp-up during campaign**

Two spots:

(a) In `animate()`, find the existing block that ramps RPS up for survival:
```js
if (STATE.gameMode === "survival") {
    const gameTime = STATE.elapsedGameTime;
    const targetRPS = calculateTargetRPS(gameTime);
    STATE.currentRPS += (targetRPS - STATE.currentRPS) * 0.01;
    ...
}
```
This already gates on `survival` only — no change needed. ✅

(b) `checkSmartHints` already starts with `if (STATE.gameMode !== "survival") return;` — also no change needed. ✅

(c) `updateMaliciousSpike`, `updateTrafficShift`, `updateRandomEvents` all gate on `survival`. ✅

EXCEPT: level 14 has `enableSurvivalShifts: true`. To honor it, in `updateTrafficShift` change the early-return to also allow campaign when the level opts in:

```js
function updateTrafficShift(dt) {
    if (STATE.gameMode === "campaign") {
        if (!STATE.campaign?.level?.enableSurvivalShifts) return;
    } else if (STATE.gameMode !== "survival") {
        return;
    }
    // ... rest unchanged
}
```

Apply the same pattern to `updateMaliciousSpike` and `updateRandomEvents`.

- [ ] **Step 4: Hide / show campaign-relevant UI panels**

Find the existing block in `resetGame()` that toggles `sandboxPanel` / `objectivesPanel` visibility based on mode. Add a campaign branch:

```js
if (mode === "campaign") {
    if (sandboxPanel) sandboxPanel.classList.add("hidden");
    if (objectivesPanel) objectivesPanel.classList.remove("hidden");
} else if (mode === "sandbox") {
    // ... existing sandbox branch
} else {
    // ... existing survival branch
}
```

- [ ] **Step 5: Verify in browser**

Open game → Campaign → Level 1 → `Start Level →`.
- Game canvas renders
- Money shows $300
- Toolbar: WAF, ALB, Compute, SQL DB, S3 fully colored; everything else faded
- Game is at 1× (running)
- Console: no errors
- `STATE.gameMode === "campaign"` and `STATE.campaign.active === true`

Try clicking a grayed-out tool (e.g. Cache) — nothing happens (pointer events blocked). ✅

- [ ] **Step 6: Commit**

```bash
git add game.js
git commit -m "feat(campaign): in-game integration, pre-built services, toolbar gating"
```

---

## Task 10: Wire `onRequestCompleted` hook for per-service tracking

**Files:**
- Modify: `game.js`

The objective `replicaShareOfReads` and `nosqlShareOfWrites` need to know which service ultimately completed each request. We bump these counters from `finishRequest`.

- [ ] **Step 1: Update `finishRequest` in `game.js` to notify campaign**

Find `function finishRequest(req)`. Replace it with:

```js
function finishRequest(req, viaServiceType) {
    STATE.requestsProcessed++;
    updateScore(req, "COMPLETED");
    if (window.campaign?.active) {
        window.campaign.onRequestCompleted(req, viaServiceType);
    }
    removeRequest(req);
}
```

- [ ] **Step 2: Pass `viaServiceType` from `Service.js` call sites**

This is a delicate change — `Service.update()` calls `finishRequest(job.req)` in several places. Each call site already knows `this.type`. Update each call to pass `this.type` as the second argument.

Open `src/entities/Service.js`. Search for every `finishRequest(job.req)` occurrence (there are roughly 8 — one each for `db`, `nosql`, `s3`, `cache` (hit branch), `cdn` (hit branch), `search`, `replica`, plus any `flyTo` chains that eventually settle). For each, change:

```js
finishRequest(job.req);
```
to:
```js
finishRequest(job.req, this.type);
```

Do NOT change `failRequest` or `throttleRequest` calls — those are for failures.

- [ ] **Step 3: Verify in browser**

Reload, start Campaign Level 6 ("Scale Reads") which has pre-built Cache + DB. Place a Read Replica, connect Compute→Replica, Replica→DB. Let traffic flow for ~10s. In console:
```js
STATE.campaign.completedByService   // { db: N, cache: M, replica: K }
STATE.campaign.completedByType      // { READ: X, WRITE: Y, ... }
CampaignObjectives.replicaShareOfReads(STATE)  // should be > 0
```

- [ ] **Step 4: Commit**

```bash
git add game.js src/entities/Service.js
git commit -m "feat(campaign): per-service completion tracking for objective evaluation"
```

---

## Task 11: Objectives panel rendering + animate loop hook

**Files:**
- Modify: `game.js`

- [ ] **Step 1: Add `renderCampaignObjectives` function in `game.js`**

Append after `applyCampaignToolbarGating`:

```js
function renderCampaignObjectives(level, primaryResults, bonusResults) {
  const panel = document.getElementById("objectivesPanel");
  if (!panel) return;
  // Hide the static survival objectives, render campaign list instead
  panel.classList.remove("hidden");

  const primaryHtml = level.objectives.primary.map((o) => {
    const done = primaryResults[o.id];
    const icon = done ? "☑" : "☐";
    const color = done ? "text-green-400" : "text-gray-400";
    return `<li class="${color}"><span class="font-mono">${icon}</span> ${o.label}</li>`;
  }).join("");

  const bonusHtml = level.objectives.bonus.map((o) => {
    const done = bonusResults[o.id];
    const icon = done ? "⭐" : "☆";
    const color = done ? "text-yellow-300" : "text-gray-500";
    return `<li class="${color}"><span class="font-mono">${icon}</span> ${o.label}</li>`;
  }).join("");

  panel.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <h3 class="text-xs font-bold text-yellow-400 uppercase tracking-wider">
        Level ${level.id}: ${level.title}
      </h3>
      <span class="text-[10px] bg-yellow-900/50 px-2 py-0.5 rounded text-yellow-400 border border-yellow-800">${Math.round(STATE.elapsedGameTime)}s / ${level.durationSec}s</span>
    </div>
    <ul class="text-xs space-y-1 font-mono mb-2">${primaryHtml}</ul>
    <div class="text-[10px] text-yellow-500 uppercase mt-2 mb-1">Bonus</div>
    <ul class="text-[11px] space-y-1 font-mono">${bonusHtml}</ul>`;
}
```

- [ ] **Step 2: Hook `campaign.tick(dt)` into `animate` loop**

In `animate()`, find where `STATE.elapsedGameTime += dt;` happens. After it, add:

```js
if (window.campaign?.active) window.campaign.tick(dt);
```

- [ ] **Step 3: Verify in browser**

Start any campaign level. Watch the bottom-left objectives panel — it should now show level objectives with live checkmarks updating every 0.5s. Timer counts up.

- [ ] **Step 4: Commit**

```bash
git add game.js
git commit -m "feat(campaign): live objective rendering and animate-loop tick"
```

---

## Task 12: Debrief modal + win/lose flow

**Files:**
- Modify: `game.js`

- [ ] **Step 1: Add `showCampaignDebrief` + nav functions**

Append in `game.js`:

```js
function showCampaignDebrief(outcome, reason, level) {
  document.getElementById("campaign-debrief-modal").classList.remove("hidden");

  const titleEl = document.getElementById("campaign-debrief-title");
  const iconEl = document.getElementById("campaign-debrief-icon");
  const starsEl = document.getElementById("campaign-debrief-stars");
  const reasonEl = document.getElementById("campaign-debrief-reason");
  const tipEl = document.getElementById("campaign-debrief-tip");
  const nextBtn = document.getElementById("campaign-debrief-next-btn");

  if (outcome === "win") {
    const stars = window.campaign._calculateStars();
    iconEl.textContent = "🎉";
    titleEl.textContent = "LEVEL COMPLETE";
    titleEl.className = "text-3xl font-bold mb-2 text-green-400";
    starsEl.textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
    reasonEl.textContent = `Completed in ${Math.round(STATE.elapsedGameTime)}s`;
    tipEl.textContent = level.debriefTip;

    const hasNext = CAMPAIGN_LEVELS.some((l) => l.id === level.id + 1);
    nextBtn.classList.toggle("hidden", !hasNext);
    if (typeof STATE.sound?.playSuccess === "function") STATE.sound.playSuccess();
  } else {
    iconEl.textContent = "❌";
    titleEl.textContent = "LEVEL FAILED";
    titleEl.className = "text-3xl font-bold mb-2 text-red-400";
    starsEl.textContent = "";
    reasonEl.textContent = reason || "Objectives not met";
    tipEl.textContent = level.debriefTip;
    nextBtn.classList.add("hidden");
    if (typeof STATE.sound?.playGameOver === "function") STATE.sound.playGameOver();
  }
  updateCampaignProgressLabel();
}

window.campaignRetryLevel = () => {
  const id = STATE.campaign.currentLevelId;
  document.getElementById("campaign-debrief-modal").classList.add("hidden");
  if (id) startCampaignLevel(id);
};

window.campaignNextLevel = () => {
  const id = STATE.campaign.currentLevelId;
  document.getElementById("campaign-debrief-modal").classList.add("hidden");
  if (id) {
    const next = CAMPAIGN_LEVELS.find((l) => l.id === id + 1);
    if (next) openCampaignBriefing(next.id);
    else exitCampaignToMap();
  }
};
```

- [ ] **Step 2: Verify in browser**

Start Campaign Level 1. Build the required pipeline (Internet→WAF→ALB→Compute→DB). Let traffic process. When you hit 50 READ + rep>=80%, Debrief modal opens with `🎉 LEVEL COMPLETE`, star rating, tip, and `Next →` button.

Refresh page. Open Campaign menu — Level 1 should show ★ count, Level 2 should now be unlocked (clickable, not 🔒). Progress label shows `1/14 ★N`.

Test failure: start Level 1 again, do nothing, wait until rep drops below 50 (DDoS leaks). Debrief shows `❌ LEVEL FAILED` with reason.

- [ ] **Step 3: Commit**

```bash
git add game.js
git commit -m "feat(campaign): debrief modal + win/lose persistence flow"
```

---

## Task 13: EN i18n keys + locale fallback

**Files:**
- Modify: `src/locales/en.js`
- Modify: `src/locales/{zh,pt-BR,de,fr,ko,nep}.js` (fallback only)

- [ ] **Step 1: Add keys to `en.js`**

Find the closing `};` of `EN_TRANSLATIONS`. Before it, add a trailing comma on the previous line if needed and insert:

```js
"campaign_mode": "Campaign",
"campaign_select_title": "CAMPAIGN",
"campaign_briefing_start": "Start Level",
"campaign_briefing_back": "Back",
"campaign_complete": "LEVEL COMPLETE",
"campaign_failed": "LEVEL FAILED",
"campaign_retry": "Retry",
"campaign_next": "Next",
"campaign_map": "Map",
"campaign_chapter_1": "Chapter 1: Basics",
"campaign_chapter_2": "Chapter 2: Optimization",
"campaign_chapter_3": "Chapter 3: Defense & Mastery",
"campaign_locked": "Locked",
```

- [ ] **Step 2: Add the same keys with English values to all other locale files**

Repeat the same block in each of `zh.js`, `pt-BR.js`, `de.js`, `fr.js`, `ko.js`, `nep.js`. Use the English values verbatim — they serve as fallback. Future contributors translate.

- [ ] **Step 3: Verify in browser**

Switch language to e.g. German via the language dropdown. Open Campaign menu — labels still show in English (correct fallback). No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/locales/
git commit -m "feat(campaign): i18n keys (EN with fallback in other locales)"
```

---

## Task 14: Final integration test + PR

**Files:** none modified — verification only.

- [ ] **Step 1: Full playthrough checklist**

Open game in browser. Run through each item, ticking only after literally observing it:

- [ ] Main menu shows `Campaign 0/14 ★0`
- [ ] Click Campaign — Level Select opens, 3 chapter headers visible, level 1 unlocked, levels 2-14 locked
- [ ] Click Level 1 → Briefing opens, SVG diagram visible (empty for level 1), Goals list & Bonus list correct
- [ ] Start Level — game runs at 1×, money = $300, toolbar grays out cache/sqs/cdn/etc.
- [ ] Build pipeline, hit objectives → Debrief shows ★★★ (or ★★☆/★☆☆), tip, Next button
- [ ] Refresh page → progress persists, level 2 unlocked, badge shows `1/14 ★1` (or higher)
- [ ] Start Level 2 → Briefing shows pre-built pipeline in diagram, game loads with 4 services placed and connected
- [ ] Start Level 4 ("Cache the DB") → SQL DB pulses red in diagram, pre-built pipeline visible in-game
- [ ] Start Level 12 ("High Availability") → after ~30s a WAF goes offline (transparent), warning shown
- [ ] Start Level 14 → traffic shifts fire (e.g. "Read Heavy" warning appears)
- [ ] Failure: start Level 11, do nothing, watch reputation crash → Debrief `❌` with reason
- [ ] Survival mode (separate test) still works unchanged
- [ ] Sandbox mode still works unchanged
- [ ] Switch language to non-EN, Campaign UI shows English fallback, no console errors

- [ ] **Step 2: Push and open PR**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/campaign-mode

gh pr create \
  --title "feat: Campaign Mode — 14-level scenario-based learning (#151)" \
  --body "$(cat <<'EOF'
## Summary
Closes #151. Adds **Campaign Mode** alongside Survival and Sandbox — 14 hand-crafted levels teaching one cloud-infrastructure concept each.

## What's included
- 3 chapters: Basics (1–3), Optimization (4–10), Defense & Mastery (11–14)
- Linear unlock, ★/3 rating (completion + bonus + speedrun)
- Briefing modal with auto-generated SVG architecture diagram
- Real-time objectives panel with live checkmarks
- Debrief modal with tip and Next button
- Toolbar gating: only allowed services per level
- Pre-built starting architectures for Chapters 2 & 3
- Per-service completion tracking for bonus objectives (e.g. "Replica handles ≥50% of READ")
- localStorage persistence (`serverSurvivalCampaignProgress`)
- EN i18n with fallback in 6 other locales

## Architecture
New `src/campaign/` directory with 4 modules:
- `levels.js` — 14 declarative level configs
- `objectives.js` — pure check helpers
- `diagram.js` — SVG generator
- `campaign.js` — `CampaignController` (lifecycle + persistence)

Reuses existing `Service`, `Request`, spawn loop, scoring, finances — no new simulation engine. `gameMode === "campaign"` branch in `resetGame()`.

## Spec
`docs/superpowers/specs/2026-05-24-campaign-mode-design.md`

## Test Plan
- [x] All 14 levels load via Level Select
- [x] Linear unlock enforced
- [x] Briefing renders icon, scenario, learn, goals, bonus, SVG diagram
- [x] Pre-built architectures load correctly
- [x] Toolbar gating works (allowed services only)
- [x] Objectives update real-time
- [x] Win triggers Debrief with stars
- [x] Lose triggers correct failure reason
- [x] Progress persists across reloads
- [x] Survival and Sandbox modes unchanged
- [x] Non-EN locales fall back to English without errors
EOF
)"
```

- [ ] **Step 3: Confirm PR URL with user**

PR opens in browser-visible URL. Done.

---

## Self-Review

**Spec coverage:**
- 14 levels in 3 chapters: ✅ Task 2
- Star rating (1 completion + bonus + speedrun): ✅ Task 5 (`_calculateStars`)
- Linear unlock: ✅ Task 5 (`isUnlocked`, `_persistWin`)
- Briefing with SVG diagram: ✅ Tasks 4, 8
- Real-time objectives: ✅ Task 11
- Debrief with tip: ✅ Task 12
- Toolbar gating per level: ✅ Task 9 (`applyCampaignToolbarGating`)
- Pre-built starting architectures: ✅ Task 9 (`startCampaignLevel`)
- localStorage persistence: ✅ Task 5
- EN-only with fallback: ✅ Task 13
- Reuses existing Service/Request systems: ✅ no new simulation
- Smart hints disabled in campaign: ✅ existing gate (`STATE.gameMode !== "survival"`)
- New STATE.campaign field: ✅ Task 1 Step 4
- New gameMode "campaign": ✅ Task 9 Step 2
- Burst patterns + forced outages: ✅ Task 5 (`tick`)
- Survival shifts in finale: ✅ Task 9 Step 3 (`enableSurvivalShifts` gate)

**Placeholder scan:** Re-read all tasks. No "TBD", "implement later", or "similar to Task N" placeholders. All code blocks contain real code. ✅

**Type/name consistency:**
- `CAMPAIGN_LEVELS` used in Tasks 2, 5, 7, 8, 9, 12 ✅
- `CampaignObjectives` used in Tasks 2 (refs), 3 (defs) ✅
- `renderArchitectureSVG` used in Tasks 4 (def), 8 (call) ✅
- `CampaignController.onRequestCompleted` used in Tasks 5 (def), 10 (call) ✅
- `renderCampaignObjectives` used in Tasks 5 (call via tick), 11 (def) — Task 11 must come before Task 5's first run; in practice Task 5 only calls it `if (typeof renderCampaignObjectives === "function")` so it's safe ✅
- `showCampaignDebrief` used in Tasks 5 (call), 12 (def) — same pattern, safe ✅
- localStorage key `serverSurvivalCampaignProgress` consistent ✅
- All level config field names (`durationSec`, `preBuilt`, `allowedServices`, `forbiddenServices`, `burstPattern`, `forceOutageAtSec`, `enableSurvivalShifts`, `diagramHighlights`, `failConditions`, `debriefTip`) appear identically in Task 2 (defs) and Task 5/9 (use) ✅
