// Achievements engine (#158). Owns persistence, session state, the 2 Hz poll
// tick and the event hooks. Definitions are data in definitions.js; toasts and
// the Trophies panel are DOM in ui.js.
//
// THE CARDINAL RULE, restated for this module: achievements OBSERVE the
// simulation and NEVER mutate it. Nothing here writes to STATE beyond reading
// it, and nothing in the game reads achievement state to make a decision.
//
// Persistence: localStorage["serverSurvivalAchievements"] =
//   { version: 1, unlocked: { [id]: epochMs }, seen: { localeSet: [...] } }
// Meta-progress — deliberately NOT in save files and NOT reset by resetGame.
// Corrupt or unknown-version stores reset to empty (the campaign-progress
// precedent).
//
// Session boundaries (the critique's central amendment): onSessionStart() is
// called from BOTH resetGame() and loadGameState(). It clears all armed/edge
// state and captures per-session baselines, so poll defs measure LIVE play:
//   - baselineElapsed: time benchmarks are deltas from here — a restored save
//     with elapsedGameTime 300 grants nothing until 60/300 NEW seconds pass.
//   - clean-window tracking: the engine watches the failure tally for
//     INCREASES only. The failures-panel clear-all button zeroes the raw
//     counters mid-run; a decrease updates the watermark without ever moving
//     the clean-window start backward, so clearing the panel cannot fake
//     clean_two_minutes.
//   - spikeArmed: fortress arms on the spike-start event and is cleared here,
//     so a session that dies (or resets) mid-spike can never grant on the
//     next session's first sample.
//
// The 3s toast guard is COSMETICS ONLY (anti-spam on load): unlock
// correctness never depends on it — unlocks land immediately, only the toast
// display waits. See msUntilToastsAllowed / ui.js.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { CAMPAIGN_LEVELS } from "../campaign/levels.js";
import { CampaignObjectives } from "../campaign/objectives.js";
import { isRoutable } from "../sim/circuit-breaker.js";
import { ACHIEVEMENT_DEFS, POLL_DEFS, eventDefs } from "./definitions.js";
// Runtime-only cycle (achievements.js ⇄ ui.js) — established pattern: hoisted
// function declarations, dereferenced only when an unlock actually fires.
import { enqueueToast, refreshTrophiesBadge } from "./ui.js";

const STORAGE_KEY = "serverSurvivalAchievements";
const STORE_VERSION = 1;
const POLL_INTERVAL_SEC = 0.5; // 2 Hz, the campaign-tick cadence
const TOAST_QUIET_MS = 3000;

function emptyStore() {
    return { version: STORE_VERSION, unlocked: {}, seen: { localeSet: [] } };
}

let store = null;

function loadStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return emptyStore();
        const parsed = JSON.parse(raw);
        if (parsed.version !== STORE_VERSION) return emptyStore();
        // Shape-harden the two fields the engine dereferences.
        if (typeof parsed.unlocked !== "object" || parsed.unlocked === null) {
            parsed.unlocked = {};
        }
        if (!Array.isArray(parsed.seen?.localeSet)) {
            parsed.seen = { localeSet: [] };
        }
        return parsed;
    } catch (e) {
        console.warn("Achievements: failed to load store, resetting", e);
        return emptyStore();
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
        // Quota/privacy-mode failures must never break the game loop.
        console.warn("Achievements: failed to persist store", e);
    }
}

function getStore() {
    if (!store) {
        store = loadStore();
        refreshLockedPolls();
    }
    return store;
}

// ---- Session state (cleared by onSessionStart) ----

const session = {
    baselineElapsed: 0,
    cleanSince: 0,      // game time of the last observed failure increase
    lastFailTotal: 0,   // watermark over the (player-resettable) raw counters
    spikeArmed: false,
    startedAtMs: 0,
    pollAcc: 0,
    // Wave 2 (#234): resilience-counter baselines. resetGame zeroes the raw
    // counters anyway, but a LOADED save keeps whatever the previous session
    // accumulated in memory — the same restored-save rule as baselineElapsed,
    // so the resilience defs only ever see live-play deltas.
    baseTrips: 0,
    baseOutages: 0,
    baseRetries: 0,
    baseDrained: 0,
    breakerTripped: false, // armed by onBreakerTrip, dies with the session
};

function totalFailures() {
    const f = STATE.failures || {};
    let t = 0;
    for (const k in f) t += f[k] || 0;
    return t;
}

// ---- Poll hot path: reused objects, zero per-frame allocation ----

// Locked poll defs, rebuilt on load and after each unlock so the 2 Hz loop
// only ever touches what is still winnable — and skips entirely at 0.
let lockedPolls = [];

function refreshLockedPolls() {
    lockedPolls = POLL_DEFS.filter((d) => !store.unlocked[d.id]);
}

const counts = {
    placed: 0,
    wafRoutable: 0,
    db: 0,
    nosql: 0,
    search: 0,
    replica: 0,
    gpu: 0,
    infgw: 0,
    power: 0,
};

const pollCtx = {
    survival: false,
    liveElapsed: 0,
    cleanElapsed: 0,
    score: 0,
    counts,
    // Wave 2 (#234): sanitized session deltas + live readings. Predicates
    // never touch the raw counters — restored-save baselines live here.
    reputation: 0,
    nodeFailures: 0,     // (outages + trips) since session start
    retries: 0,          // retries since session start
    drained: 0,          // DLQ drains since session start
    outageCompletions: 0, // completions during the (campaign) region outage
    gpuKw: 0,            // player-placed GPUs × gpuDrawKw
    maxFleet: 0,         // largest READY ASG fleet among player-placed nodes
};

function evaluatePolls() {
    // Failure watermark: only INCREASES start a new clean window. A decrease
    // (the failures-panel clear-all button) moves the watermark down without
    // touching cleanSince — the dirt already happened.
    const ft = totalFailures();
    if (ft > session.lastFailTotal) session.cleanSince = STATE.elapsedGameTime || 0;
    if (ft !== session.lastFailTotal) session.lastFailTotal = ft;

    counts.placed = 0;
    counts.wafRoutable = 0;
    counts.db = 0;
    counts.nosql = 0;
    counts.search = 0;
    counts.replica = 0;
    counts.gpu = 0;
    counts.infgw = 0;
    counts.power = 0;
    let maxFleet = 0;
    const services = STATE.services || [];
    for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!s.playerPlaced) continue; // pre-built / restored: no freebies
        counts.placed++;
        const t = s.type;
        if (t === "waf") {
            if (isRoutable(s)) counts.wafRoutable++;
        } else if (t in counts) {
            counts[t]++;
        }
        // fleet_of_five (#234): READY instances only — a warming instance
        // carries no traffic and does not count, exactly like capacity math.
        if (s.asgEnabled && (s.instances || 1) > maxFleet) {
            maxFleet = s.instances || 1;
        }
    }

    const elapsed = STATE.elapsedGameTime || 0;
    const r = STATE.resilience || {};
    pollCtx.survival = STATE.gameMode === "survival";
    pollCtx.liveElapsed = elapsed - session.baselineElapsed;
    pollCtx.cleanElapsed = elapsed - Math.max(session.baselineElapsed, session.cleanSince);
    pollCtx.score = STATE.score?.total || 0;
    pollCtx.reputation = STATE.reputation || 0;
    pollCtx.nodeFailures =
        ((r.outages || 0) + (r.trips || 0)) - (session.baseOutages + session.baseTrips);
    pollCtx.retries = (r.retries || 0) - session.baseRetries;
    pollCtx.drained = (r.drained || 0) - session.baseDrained;
    pollCtx.outageCompletions = CampaignObjectives.completedDuringRegionOutage(STATE);
    pollCtx.gpuKw = counts.gpu * (CONFIG.power?.gpuDrawKw || 6);
    pollCtx.maxFleet = maxFleet;

    // Backwards: unlock() rebuilds lockedPolls, so never hold an index into it.
    for (let i = lockedPolls.length - 1; i >= 0; i--) {
        const def = lockedPolls[i];
        if (def.check(pollCtx)) unlock(def.id);
    }
}

// ---- Unlock flow ----

function unlock(id) {
    const st = getStore();
    if (st.unlocked[id]) return false; // exactly once
    st.unlocked[id] = Date.now();
    saveStore();
    refreshLockedPolls();
    enqueueToast(id);
    refreshTrophiesBadge();
    return true;
}

function runEventDefs(event, ctx) {
    const st = getStore();
    for (const def of eventDefs(event)) {
        if (st.unlocked[def.id]) continue;
        if (def.check(ctx)) unlock(def.id);
    }
}

function noteLocale(locale) {
    if (!locale) return;
    const st = getStore();
    if (st.unlocked.polyglot) return; // short-circuit: nothing left to track
    const set = st.seen.localeSet;
    if (!set.includes(locale)) {
        set.push(locale);
        saveStore();
    }
    runEventDefs("locale", { localeCount: set.length });
}

// ---- Public API ----

export const achievements = {
    // Called once from game.js's body, after the module graph evaluates.
    // Records the starting locale so polyglot counts it.
    init(currentLocale) {
        getStore();
        session.startedAtMs = Date.now();
        noteLocale(currentLocale);
        refreshTrophiesBadge();
    },

    // Engine hook (the critique's blocker #2): called from resetGame() AND
    // loadGameState(). Clears armed/edge state and captures the baselines the
    // poll defs measure deltas from.
    onSessionStart() {
        session.baselineElapsed = STATE.elapsedGameTime || 0;
        session.cleanSince = session.baselineElapsed;
        session.lastFailTotal = totalFailures();
        session.spikeArmed = false;
        session.startedAtMs = Date.now();
        session.pollAcc = 0;
        const r = STATE.resilience || {};
        session.baseTrips = r.trips || 0;
        session.baseOutages = r.outages || 0;
        session.baseRetries = r.retries || 0;
        session.baseDrained = r.drained || 0;
        session.breakerTripped = false;
    },

    // 2 Hz poll cadence, driven from animate() on game-scaled dt (frozen while
    // paused — the #183 timer class). Returns whether an evaluation ran, so
    // tests can pin the cadence; animate() ignores the return value.
    tick(dt) {
        getStore(); // no-op after the first call
        if (lockedPolls.length === 0) return false; // all polls unlocked: skip

        session.pollAcc += dt;
        if (session.pollAcc < POLL_INTERVAL_SEC) return false;
        session.pollAcc = 0;
        evaluatePolls();
        return true;
    },

    // Fired as the LAST statement of CampaignController._persistWin, after
    // saveProgress — ctx.progress therefore includes the level just won, so
    // chapter_*_done / completionist grant in the same call (no off-by-one).
    onLevelWin(levelId, stars, elapsed, ctx = {}) {
        // Wave 2 (#234): the AI-Wave feat readings, taken at the same win
        // tick as everything else. gpuMaxTier follows the minimalist
        // precedent — alive-at-win, pre-built included (L21/L22 pre-build no
        // GPU, so the fleet on the board is the fleet the player ran).
        const services = STATE.services || [];
        let gpuCount = 0;
        let gpuMaxTier = 0;
        for (const s of services) {
            if (s.type !== "gpu") continue;
            gpuCount++;
            if ((s.tier || 1) > gpuMaxTier) gpuMaxTier = s.tier || 1;
        }
        runEventDefs("levelWin", {
            levelId,
            stars,
            elapsed,
            progress: ctx.progress || null,
            level: CAMPAIGN_LEVELS.find((l) => l.id === levelId) || null,
            servicesCount: services.length,
            usesServerlessOnly: CampaignObjectives.usesOnly(STATE, "serverless", ["compute"]),
            upgradesPerformed: STATE.campaign?.upgradesPerformed || 0,
            expiredRequests: CampaignObjectives.expiredRequests(STATE),
            gpuCount,
            gpuMaxTier,
        });
    },

    // Fired from i18n.setLocale — the single locale-change site.
    onLocaleChange(locale) {
        noteLocale(locale);
    },

    // Fired from startMaliciousSpike, after the trafficShiftActive
    // early-return — a suppressed spike never arms. Never fired by resetGame.
    onSpikeStart() {
        session.spikeArmed = true;
    },

    // Fired from endMaliciousSpike — the only genuine end-of-spike site.
    // resetGame only flips the flag, so a reset can never reach here, and the
    // armed flag it left behind dies in onSessionStart.
    onSpikeEnd({ reputation }) {
        const armed = session.spikeArmed;
        session.spikeArmed = false;
        runEventDefs("spikeEnd", { armed, reputation });
    },

    // Fired from circuit-breaker trip() — arms breaker_comeback for this
    // session. Latched (NOT cleared by a close): any later genuine recovery
    // in the same session is still a comeback. Dies in onSessionStart, so a
    // save restored with a breaker mid-open can never fake one.
    onBreakerTrip() {
        session.breakerTripped = true;
    },

    // Fired from circuit-breaker close() — the only genuine "breaker
    // recovered" site: close is reachable exclusively via half-open probes
    // after a trip, so a doomed node that never heals never fires it.
    onBreakerClose({ reputation }) {
        runEventDefs("breakerClose", {
            armed: session.breakerTripped,
            reputation,
            survival: STATE.gameMode === "survival",
        });
    },

    // ---- Read API for the Trophies panel / tests ----

    defs: ACHIEVEMENT_DEFS,

    unlockedMap() {
        return getStore().unlocked;
    },

    unlockedCount() {
        return Object.keys(getStore().unlocked).length;
    },

    isUnlocked(id) {
        return !!getStore().unlocked[id];
    },

    // Cosmetic toast guard (ui.js): ms left in the quiet window after a
    // session start. NEVER consulted for unlock decisions.
    msUntilToastsAllowed() {
        const since = Date.now() - session.startedAtMs;
        return Math.max(0, TOAST_QUIET_MS - since);
    },

    // Test seam: drop the in-memory cache so the next access re-reads
    // localStorage (each sim test file shares one module registry).
    _reloadForTests() {
        store = null;
        lockedPolls = [];
        session.baselineElapsed = 0;
        session.cleanSince = 0;
        session.lastFailTotal = 0;
        session.spikeArmed = false;
        session.startedAtMs = 0;
        session.pollAcc = 0;
        session.baseTrips = 0;
        session.baseOutages = 0;
        session.baseRetries = 0;
        session.baseDrained = 0;
        session.breakerTripped = false;
    },
};
