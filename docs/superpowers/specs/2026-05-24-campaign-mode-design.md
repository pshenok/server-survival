# Campaign Mode Design Spec

**Date:** 2026-05-24
**Status:** Approved (pending user review of written spec)

## Summary

Add a new **Campaign Mode** to the game, alongside existing **Survival** and **Sandbox**. The campaign teaches one cloud-infrastructure concept per level through a linear sequence of 14 hand-crafted scenarios. Each level pairs a short narrative ("your e-commerce DB is melting") with a concrete win condition that forces the player to use a specific service, then immediately shows the effect (load drops, throughput rises).

The primary goal is **teaching, not difficulty** — players walk away understanding *why* each service exists and *when* to reach for it.

## Goals & Non-Goals

### Goals
- Teach all 13 services through scenario-driven play
- Make the educational arc obvious: problem → solution → visible effect
- Bite-sized commitment per level (2–5 min) so players progress without fatigue
- Persist progress and star ratings across sessions
- Reuse existing game systems (Service, Request, traffic shifts, smart hints) — no new simulation engine

### Non-Goals
- Multiplayer / leaderboards (no backend)
- Procedurally generated levels (everything hand-crafted)
- Replacing Survival or Sandbox modes — Campaign is additive
- Translating levels into all 7 languages on first release (English only initially; locale keys exist as fallback)

## Architecture & High-Level Flow

```
Main Menu
  └── [Campaign ★★★ N/14] button (new, alongside Survival/Sandbox)
        └── Level Select Screen (modal)
              ├── Chapter 1: Basics (#1–3)
              ├── Chapter 2: Optimization (#4–10)
              └── Chapter 3: Defense & Mastery (#11–14)
                    └── Briefing Modal (per level)
                          └── In-Game Level
                                ├── Reuses Survival rendering / Service / Request systems
                                ├── Custom traffic distribution & RPS from level config
                                ├── Optional pre-placed services (level starting state)
                                ├── Optional service whitelist/blacklist (forced learning)
                                └── Real-time objective tracker (uses existing objectivesPanel)
                                      └── Debrief Modal (win or lose)
                                            ├── Win: stars, time, tip → [Replay] [Next]
                                            └── Lose: failure reason, tip → [Retry] [Map]
```

### Reused Systems
- `Service` / `Request` classes — no changes
- Traffic spawn loop, scoring, finances — same as Survival, configured by level
- Smart hints — disabled during Campaign (briefing/objectives serve same role)
- DDoS spikes / traffic shifts — driven from level config rather than survival defaults

### New Systems
1. **Level registry** (`src/campaign/levels.js`) — declarative array of all 14 level configs
2. **Campaign controller** (`src/campaign/campaign.js`) — loads level, tracks objectives, evaluates win/lose, persists progress
3. **UI overlays** (Level Select, Briefing, Debrief modals — added to `index.html`)

## Level Format (data shape)

Each level is a declarative object. Example:

```js
{
  id: 4,
  chapter: 2,
  title: "Cache the DB",
  scenario: "Your e-commerce DB is melting under READ traffic. Players add the same items to cart over and over.",
  learn: "Memory Cache reduces DB load by serving repeated READ requests from RAM.",
  icon: "🛒",
  // Optional visual highlight for the briefing diagram (which is auto-generated
  // from `preBuilt`). Maps service indices to a visual state.
  diagramHighlights: { 3: "critical" }, // db (index 3) shown in red/flames
  budget: 200,
  upkeepEnabled: true,
  durationSec: 60,
  // Initial pre-placed services & connections
  preBuilt: {
    services: [
      { type: "waf", x: -20, z: 0 },
      { type: "alb", x: -10, z: 0 },
      { type: "compute", x: 0, z: 0 },
      { type: "db", x: 10, z: 0 },
    ],
    connections: [
      ["internet", 0], [0, 1], [1, 2], [2, 3],
    ],
  },
  // Force specific traffic mix
  trafficDistribution: {
    STATIC: 0.05, READ: 0.75, WRITE: 0.1, UPLOAD: 0, SEARCH: 0.05, MALICIOUS: 0.05,
  },
  rps: 6, // overrides survival ramp-up
  // Which services are allowed in toolbar
  allowedServices: ["cache"], // empty array = all allowed; specific list = only these
  // Objectives
  objectives: {
    primary: [
      { id: "db_load", label: "DB load <70%", check: (state) => dbLoadBelow(state, 70) },
      { id: "survive", label: "Survive 60s", check: (state) => state.elapsedGameTime >= 60 },
    ],
    bonus: [
      { id: "hit_rate", label: "Cache hit rate >35%", check: (state) => cacheHitRate(state) > 0.35 },
      { id: "no_drops", label: "Zero failures", check: (state) => totalFailures(state) === 0 },
    ],
  },
  failConditions: {
    repBelow: 30,
    moneyBelow: -100,
  },
  debriefTip: "Cache works best for traffic you READ many times. Hit rate degrades when keys are unique (e.g. SEARCH).",
}
```

## The 14 Levels

### Chapter 1: Basics (clean slate, learn the pipeline)
1. **The First Server** — Internet→WAF→ALB→Compute→DB. Process 50 READ. Budget $300.
2. **Store the Files** — Add Storage for UPLOAD. Process 30 UPLOAD.
3. **Edge with CDN** — 80% STATIC traffic. Add CDN, survive 60s with DB load <50%.

### Chapter 2: Optimization (broken architecture, fix it)
4. **Cache the DB** — DB melts under READ. Add Cache. DB load <70%.
5. **Buffer the Spikes** — Bursty traffic. Add Queue. 0 drops in 90s.
6. **Scale Reads** — "API Heavy" shift active. Add Read Replica. DB load <60%.
7. **Search Done Right** — "Search Storm" (50% SEARCH). Add Search Engine. SQL DB load <40%.
8. **NoSQL for Speed** — SQL DB overloaded. Add NoSQL, route READ/WRITE there. Keep SQL only for SEARCH.
9. **Rate Limit Gateway** — Spikes kill DB. Add API Gateway. <10% failed.
10. **Serverless or Compute?** — Low RPS (1.5), $500 budget. Build profitable architecture. Profit >$100 in 90s. Bonus: use Serverless, not Compute.

### Chapter 3: Defense & Mastery
11. **Defense in Depth** — DDoS wave (70% MALICIOUS). Add WAF + API GW. 0 leaks.
12. **High Availability** — 1 WAF given, Service Outage simulated. Add 2nd WAF. Round-robin handles outage.
13. **Cost Crunch** — Over-engineered architecture (12+ services bleeding money). Reduce upkeep 30%, keep throughput. Net profit >0 in 60s.
14. **Black Friday** — Finale. Clean slate, $1000 budget. Survive 90s of endgame conditions (×4 RPS, DDoS, traffic shifts). Bonus: rep >70%, 0 leaks.

## Progress Persistence

Stored in `localStorage` under key `serverSurvivalCampaignProgress`:

```js
{
  version: 1,
  completed: {
    "1": { stars: 3, bestTimeSec: 42, lastPlayed: 1748000000 },
    "2": { stars: 2, bestTimeSec: 51, lastPlayed: 1748001234 },
    ...
  },
  highestUnlocked: 5, // level N+1 unlocks when N is completed (any stars)
}
```

- Stars: 1 for completion, +1 for bonus objectives met, +1 for finishing under target time (target = `durationSec * 0.8`)
- Linear unlock: completing N unlocks N+1 (no skipping)
- Replay any unlocked level for better stars

## UI Components

### 1. Main Menu — new button

Between `Start Survival` and `Sandbox Mode`:
```html
<button onclick="startCampaign()" class="... bg-yellow-600 ...">
  <span data-i18n="campaign_mode">Campaign</span>
  <span class="text-xs opacity-75" id="campaign-progress">★★★ 0/14</span>
</button>
```

### 2. Level Select Modal

Full-screen modal showing all 14 levels grouped by chapter. Each level card:
- Number + title + chapter chip
- Short scenario (1 sentence)
- Stars earned (★★★ / ★★☆ / ★☆☆) or 🔒 if locked
- Best time if completed
- Click → open Briefing Modal (or unlock message if locked)

### 3. Briefing Modal

Full-screen modal shown before level starts:
- Large icon/emoji
- Title (`LEVEL 4: CACHE THE DB`)
- Inline SVG diagram of starting architecture (auto-generated from `preBuilt`)
- Scenario text (2–3 sentences)
- "📚 LEARN:" callout with educational text
- "🎯 GOAL:" primary objectives
- "⭐ BONUS:" bonus objectives
- Buttons: `[Cancel]` `[Start Level →]`

The diagram is generated client-side: each service is a colored circle (matching `CONFIG.colors`) connected by lines. ~50 lines of SVG-generating JS — no external assets.

### 4. In-Game Objectives Panel (existing `objectivesPanel`, repurposed)

Replace static survival objectives with level objectives, real-time checkmarks:
```
🎯 Cache the DB
  ☑ DB load <70%     (currently 64%)
  ☐ Survive 60s      (12s elapsed)
  ⭐ Hit rate >35%   (currently 42%)
```
Check function runs ~1×/sec from animate loop.

### 5. Service Toolbar (existing, modified)

If `allowedServices` is set, gray out buttons NOT in the list. Click on grayed button shows tooltip "Not available in this level".

If `allowedServices` is empty/missing → behave as today (all allowed).

### 6. Debrief Modal

- **Win:** `🎉 LEVEL COMPLETE` + stars earned + time + debrief tip + `[Replay]` `[Next Level →]`
- **Lose:** `❌ FAILED: <reason>` + tip + `[Retry]` `[Back to Map]`

## State Management

New STATE fields:
```js
STATE.campaign = {
  active: false,
  currentLevelId: null,
  level: null,           // current level config object
  objectiveResults: {},  // { db_load: true, survive: false, ... }
  bonusResults: {},
  startedAt: 0,
  ended: false,
  outcome: null,         // "win" | "lose"
};
```

Existing game systems unchanged. Campaign hooks into `animate()` loop:
1. Each tick: call `campaign.checkObjectives()` if `STATE.campaign.active`
2. On win: pause game, show Debrief, persist stars
3. On lose: pause game, show Debrief

Survival's auto-degradation and random-events systems are conditioned on `STATE.gameMode === "survival"` — they naturally won't fire in Campaign because we'll use `STATE.gameMode = "campaign"`. Smart hints also gated by gameMode and will skip Campaign.

## File Layout

```
src/
  campaign/
    levels.js          # exports CAMPAIGN_LEVELS array (declarative configs for all 14)
    campaign.js        # controller: load, checkObjectives, win/lose, persistence
    objectives.js      # reusable objective check helpers (dbLoadBelow, cacheHitRate, etc.)
    diagram.js         # SVG diagram generator for briefings (~50 lines)
```

`game.js` gets:
- `startCampaign()`, `startCampaignLevel(id)`, `exitToLevelSelect()` window-level functions
- A `gameMode === "campaign"` branch in `resetGame()` to bootstrap from level config

`index.html` gets:
- Campaign button in main menu
- Level Select modal
- Briefing modal
- Debrief modal

## Out of Scope (for first release)

- Full translations of level scenarios into 7 languages — English only, with locale keys present for future contribution
- Custom 3D assets per level — using emoji/SVG illustrations only
- Adaptive difficulty / hints during level — players Retry as needed
- Tutorial integration — Campaign IS the new tutorial path; existing 16-step tutorial stays as quick onboarding for Survival

## Testing Strategy

No automated tests (project has none). Manual test plan per level:
1. Open level briefing — verify content renders correctly
2. Pre-built architecture loads correctly
3. Forced traffic mix applies
4. Allowed services list grays out the rest
5. Objectives update in real-time
6. Win condition triggers Debrief with correct stars
7. Lose condition triggers correct failure message
8. Progress persists across page reloads
9. Linear unlock works (level N+1 locked until N completed)

## Open Questions

None at this time — all major design points were settled during brainstorming.

## Implementation Notes for the Planner

- Levels 1–3 (Chapter 1) are the safest starting point — clean slate, no `preBuilt` complexity. Build these first to validate the framework.
- Diagram generator should be data-driven so adding new levels doesn't require new SVG code.
- Objective check functions should be pure (`(state) => boolean`) for testability and reusability.
- Each modal should be self-contained CSS/HTML — avoid coupling to existing modal logic.
- Use existing `glass-panel` Tailwind classes for visual consistency with current UI.
