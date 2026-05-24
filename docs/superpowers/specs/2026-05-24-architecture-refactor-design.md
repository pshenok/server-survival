# Architecture Refactor Design Spec

**Date:** 2026-05-24
**Status:** Approved (pending user review)

## Summary

Refactor `server-survival` from a single-file 3850-line `game.js` + global-script monolith into a focused module tree backed by native ES modules. **Hard constraint: the `main` branch must remain directly deployable to GitHub Pages without a build step.** Dev tools (Vitest, ESLint, Prettier) live in `package.json` for contributors who want to lint and test, but the deployed game runs the same source files contributors edit.

## Goals & Non-Goals

### Goals
- Cut `game.js` from 3850 lines to ~25 focused modules (each ≤ 250 lines)
- Make adding a new service type a single-file change instead of editing 5 places
- Replace 8 manually-synced locale JS files with JSON + automated validator
- Provide automated tests for routing, scoring, economy, save/load, campaign objectives so contributors can verify changes without 5 minutes of browser clicking per PR
- Wire CI on PRs (lint + tests + locale check)

### Non-Goals
- No bundler / no build output committed to repo — game is hosted as raw source
- No TypeScript (optional JSDoc + `tsc --checkJs` in later phase if wanted)
- No React/Vue/Svelte rewrite — game UI is fine
- No state management library (Redux/Zustand) — current STATE pattern works once mutations are centralized
- No ECS / entity-component-system — 13 service types don't warrant it
- No behavior changes — gameplay, balance, UI all stay identical through every PR

## Hard Constraints

1. **No build step in deploy path.** `main` branch HTML+JS+JSON files are served verbatim by GitHub Pages.
2. **No npm to play.** A user/contributor can clone the repo, open `index.html` via any HTTP server (Python's `http.server`, `npx serve`, etc.), and play immediately.
3. **`package.json` is optional.** Contributors who want tests/lint run `npm install && npm test`. Those who don't, edit source and reload browser.

## Browser Targets

Modern evergreen browsers (Chrome/Edge/Firefox/Safari 15+). Same as today — the game already uses Tailwind CDN, Three.js r128, and ES2017+ syntax.

## High-Level Architecture

Replace all `<script src="...">` tags in `index.html` with a single `<script type="module" src="src/main.js">`. The module graph is resolved by the browser. `THREE` and `tailwindcss` continue to load from CDN as globals.

```
index.html
  └─ <script type="module" src="src/main.js">
       └─ imports core/loop, scene/three-setup, ui/i18n, modes/survival, ...
            └─ each module imports its concrete deps with explicit paths
```

### Module dependency rules
- `core/` may not import from `ui/`, `modes/`, `sim/`, `scene/`, `input/`
- `entities/` and `sim/` may not import from `ui/`, `modes/`, `input/`
- `ui/` may import from `core/`, `entities/`, `sim/`
- `modes/` is top-level glue — may import from anywhere
- `main.js` is bootstrap only

Enforced informally; an ESLint rule (`eslint-plugin-import` `no-restricted-paths`) can lock this down if drift becomes a problem.

## File Layout

```
server-survival/
  index.html                        # ~600 lines (modals extracted to template tags)
  src/
    main.js                         # bootstrap: init i18n, scene, loop, menu
    
    core/
      state.js                      # STATE object + read API
      actions.js                    # spendMoney, addReputation — centralized mutators
      events.js                     # tiny EventEmitter: emit("request:completed", req)
      loop.js                       # animate(), dt, timeScale, requestAnimationFrame
      config.js                     # moved from src/config.js
    
    scene/
      three-setup.js                # scene, camera, renderer, lights, grid
      internet-node.js              # the Internet plate + ring
    
    sim/
      spawn.js                      # spawnRequest, getTrafficType, traffic distribution
      routing.js                    # entry-point round-robin, top-level routing decisions
      scoring.js                    # finishRequest, failRequest, throttleRequest, updateScore
      economy.js                    # upkeep deduction, finances tracking, multiplier
      events.js                     # random events, traffic shifts, malicious spikes
      smart-hints.js                # contextual hint engine
      handlers/                     # one file per service type
        index.js                    # registry { waf, alb, ... }
        waf.js
        alb.js
        compute.js
        serverless.js
        db.js
        nosql.js
        cache.js
        cdn.js
        sqs.js
        apigw.js
        search.js
        replica.js
        storage.js
    
    entities/
      Service.js                    # mesh + lifecycle only, ~200 lines
      Request.js
    
    input/
      mouse.js                      # click, drag, pan, zoom, tool placement
      keyboard.js                   # WASD/arrows/R/T/H/Esc
      tools.js                      # setTool(), active tool state
    
    ui/
      i18n.js
      hud.js                        # top-bar stats updates
      finances-panel.js
      health-panel.js
      objectives-panel.js
      hints-overlay.js
      tooltip.js                    # generic tooltip used by canvas + level cards
      toolbar-gating.js             # campaign-specific tool disabling
      upgrade-indicator.js          # ⬆️ hover indicator
      modals/
        main-menu.js
        save.js
        faq.js
        level-select.js
        briefing.js
        debrief.js
        tutorial.js                 # moved from src/tutorial.js
    
    persistence/
      save.js
      load.js
      migrate.js                    # migrateOldSave logic
    
    modes/
      survival.js                   # start survival, RPS ramping, milestones
      sandbox.js                    # burst spawning, sliders, clearAll
      campaign/
        controller.js               # moved from src/campaign/campaign.js
        levels.js                   # moved from src/campaign/levels.js
        objectives.js               # moved from src/campaign/objectives.js
        diagram.js                  # moved from src/campaign/diagram.js
    
    services/
      SoundService.js               # moved from src/services/
    
    locales/
      _check.js                     # dev script: validates locale parity
      en.json                       # source of truth
      ru.json
      zh.json
      pt-BR.json
      de.json
      fr.json
      ko.json
      nep.json
  
  tests/                            # Vitest, dev-only, never shipped
    sim/
      routing.test.js
      scoring.test.js
      economy.test.js
      handlers/
        db.test.js
        replica.test.js
        cache.test.js
    modes/
      campaign/
        objectives.test.js
        levels.test.js              # validity: traffic sums to 1, checks resolve, etc.
    persistence/
      save-load.test.js
      migrate.test.js
  
  package.json                      # devDependencies only
  vitest.config.js
  .eslintrc.json
  .prettierrc.json
  .github/workflows/ci.yml
```

**Target:** each source file ≤ 250 lines. `Service.js` shrinks from 981 → ~200. `game.js` deleted entirely; behavior absorbed by ~25 focused modules.

## Service Handler Pattern (kills the giant switch)

Today `Service.update()` is a ~500-line switch over `this.type`. Each handler becomes its own file:

```js
// src/sim/handlers/db.js
import { CONFIG } from "../../core/config.js";
import { finishRequest, failRequest } from "../scoring.js";

export const dbHandler = {
  type: "db",
  
  createMesh() {
    return {
      geometry: new THREE.CylinderGeometry(2, 2, 2, 6),
      material: new THREE.MeshStandardMaterial({
        color: CONFIG.colors.db,
        roughness: 0.3,
      }),
      yOffset: 1,
    };
  },
  
  onJobComplete(svc, job) {
    if (job.req.destination === "db") {
      finishRequest(job.req, "db");
    } else {
      failRequest(job.req);
    }
  },
  
  onUpgrade(svc, nextTier) {
    return { ringSize: 2.2, ringColor: 0xff0000 };
  },
};
```

```js
// src/sim/handlers/index.js
import { wafHandler } from "./waf.js";
import { dbHandler } from "./db.js";
// ... 13 imports
export const SERVICE_HANDLERS = {
  waf: wafHandler,
  db: dbHandler,
  // ...
};
```

```js
// src/entities/Service.js (~200 lines)
import { SERVICE_HANDLERS } from "../sim/handlers/index.js";

export class Service {
  constructor(type, pos) {
    this.type = type;
    this.handler = SERVICE_HANDLERS[type];
    if (!this.handler) throw new Error(`Unknown service type: ${type}`);
    const { geometry, material, yOffset } = this.handler.createMesh();
    // ... common mesh setup
  }
  
  update(dt) {
    // ... common queue + processing loop
    for (const job of completed) {
      this.handler.onJobComplete(this, job);
    }
  }
}
```

Adding a new service = create `handlers/myservice.js` + register in `handlers/index.js`. No other file edits.

## Locales: JSON + validator

Convert all 8 locale JS files to JSON. Single source of truth: `en.json`. Other locales contain the same keys (English values as fallback until translated).

```json
// src/locales/en.json
{
  "title": "SERVER: Survival Protocol",
  "campaign_mode": "Campaign",
  "...": "..."
}
```

Load via fetch in `ui/i18n.js`:
```js
const locale = await fetch(`./locales/${name}.json`).then(r => r.json());
```

Validator (`src/locales/_check.js`) runs in CI:
- Every non-`en` locale must contain exactly the keys present in `en.json`
- No extra keys (catches typos and stale keys)
- No empty string values (catches half-translations)

Contributors editing JSON get syntax highlighting, validation, and Git diffs that focus on actual content changes.

## Testing Strategy

Vitest, fast unit-tests on pure logic. **No DOM tests. No e2e.**

### Coverage targets
- `sim/routing.js` — given (services, traffic mix), routing decisions are deterministic
- `sim/scoring.js` — `applyOutcome(state, req, outcome)` produces correct money/rep deltas
- `sim/economy.js` — `calculateUpkeep(services, multiplier)` correctness
- `sim/handlers/*.js` — each handler's `onJobComplete` exercises happy + sad paths
- `modes/campaign/objectives.js` — already pure; tests are trivial
- `modes/campaign/levels.js` — validity: every level's traffic distribution sums to ~1.0, all `check` functions return bool when called with empty STATE, allowed services exist in CONFIG
- `persistence/{save,load,migrate}.js` — round-trip preserves all fields; old v1/v2 saves load correctly

### Anti-tests
- DOM rendering — slow, brittle, low value
- Three.js mesh output — snapshots provide little signal
- Full game sessions — keep these as manual smoke tests after major changes

Target: ~80 tests running in < 2s. Contributors run `npm test` before pushing; CI gates PRs.

## Tooling

```json
// package.json
{
  "name": "server-survival",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ tests/",
    "format": "prettier --write src/ tests/",
    "check-locales": "node src/locales/_check.js"
  },
  "devDependencies": {
    "vitest": "^1.6.0",
    "eslint": "^8.57.0",
    "prettier": "^3.2.5"
  }
}
```

ESLint config: standard recommended rules + `no-restricted-paths` to enforce layer boundaries.
Prettier config: 4-space indent (matches project), 100-char line, trailing commas.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run check-locales
      - run: npm test
```

`pages-build-deployment` workflow stays as-is — Pages serves the raw `main` content, unaffected by the npm tooling.

## Migration Plan (sequence of 10 PRs)

Each PR is small, deployable, and behavior-preserving.

| # | PR | Scope | Risk |
|---|----|-------|------|
| 1 | dev tooling baseline | `package.json` + ESLint + Prettier + Vitest + CI workflow. No source changes. | very low |
| 2 | native ESM conversion | All `<script>` tags → single `<script type="module">`. `import`/`export` everywhere. Behavior unchanged. | medium |
| 3 | locales → JSON | 8 `.js` locale files → 8 `.json` + validator + CI check. | low |
| 4 | split game.js part 1 | Extract `core/{state,actions,events,loop,config}.js`. ~500 lines out of game.js. | medium |
| 5 | split game.js part 2 | Extract `sim/{spawn,scoring,economy,events,smart-hints,routing}.js`. ~800 lines out. | medium |
| 6 | split game.js part 3 | Extract `ui/{hud,finances-panel,health-panel,objectives-panel,tooltip,toolbar-gating,upgrade-indicator,hints-overlay}.js`. ~700 lines out. | medium |
| 7 | modals → files | `ui/modals/*.js` modules + `<template>` tags in index.html. | low |
| 8 | service handlers | Extract per-type handlers. Service.js → ~200 lines. | medium |
| 9 | modes split | `modes/{survival,sandbox,campaign}.js`. Campaign is already mostly self-contained. | low |
| 10 | tests for critical paths | ~80 Vitest tests on routing, scoring, economy, objectives, save/load. | low |

**Manual smoke after each PR:** Run all 3 game modes, place every service type, click through main menu and one campaign level. Takes ~5 min.

**Total effort estimate:** 15-20 hours.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| ESM module graph breaks something Three.js / Tailwind related | Keep them as CDN globals; only convert project source to ESM |
| Circular imports during split | Enforce layer rules; split state from actions early |
| Save format breaks on extraction | Lock save schema in PR #1's first test; never break round-trip |
| Performance regression from many small modules | Modern browsers + HTTP/2 = negligible. Measure if concerns arise (Lighthouse) |
| Contributor confusion during migration | Each PR has a `CHANGELOG.md` entry explaining what moved where |
| Tests become a maintenance burden | Keep tests focused on pure logic; no DOM, no Three.js mocking |

## Out of Scope (for this refactor; possible future work)

- JSDoc types + `tsc --checkJs` in CI
- React/Vue/Svelte UI layer
- ECS architecture for entities
- Pre-built `dist/` artifact for offline play
- IndexedDB-backed save with versioning
- Replay system / observability
