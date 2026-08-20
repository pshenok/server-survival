// Campaign mode controller. Owns level lifecycle, objective evaluation,
// win/lose detection, and progress persistence.
//
// Persistence schema (localStorage key "serverSurvivalCampaignProgress"):
//   {
//     version: 1,
//     completed: { [levelId]: { stars: 1..3, bestTimeSec: number, lastPlayed: ms } },
//     highestUnlocked: number
//   }

import { STATE } from "../state.js";
import { CAMPAIGN_LEVELS } from "./levels.js";
// Cyclic imports (game.js / core modules ⇄ campaign.js) are safe: hoisted
// function declarations, only called at runtime. Under classic scripts the
// `typeof x === "function"` guards below tolerated load-order gaps; as imports
// the names are always bound, so the guards simply always pass now.
import { spawnRequest } from "../core/actions.js";
import {
    addInterventionWarning,
    triggerRegionOutage,
    updateRegionOutage,
} from "../core/events.js";
import {
    renderCampaignObjectives,
    showCampaignDebrief,
} from "../ui/campaign-ui.js";
// Achievements (#158): observation-only hook, fired as the LAST statement of
// _persistWin so the freshly persisted progress (including the level just
// won) is what chapter/completionist defs read — no off-by-one on a
// chapter's final level.
import { achievements } from "../achievements/achievements.js";

const CAMPAIGN_STORAGE_KEY = "serverSurvivalCampaignProgress";
const CAMPAIGN_PROGRESS_VERSION = 1;

export class CampaignController {
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
        // Monotonic session id: distinguishes "this level attempt" from a
        // later retry/next that reuses the controller. Stale burst callbacks
        // scheduled by a previous attempt compare against this and bail.
        this._session = (this._session || 0) + 1;
        // Attempt number on THIS level (#252). The run report is withheld on a
        // first loss — level 15's busiestLoad objective is type-blind so the
        // player cannot name the hottest node without buying the Monitoring
        // dashboard, and naming it immediately would hand over that lesson.
        // Retrying the same level increments; moving to another resets.
        STATE.campaign.attempt =
            STATE.campaign.currentLevelId === levelId
                ? (STATE.campaign.attempt || 0) + 1
                : 1;
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
        // Achievements (#158): per-level upgrade counter for no_upgrades.
        // Incremented in Service.upgrade() strictly after the affordability
        // check passes; read by achievements.onLevelWin.
        STATE.campaign.upgradesPerformed = 0;
        STATE.campaign.burstTimer = 0;
        STATE.campaign.outageFired = false;
        STATE.campaign.regionOutageFired = false;
        STATE.campaign.regionOutage = null;
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
                const session = this._session;
                for (let i = 0; i < bp.burstSize; i++) {
                    setTimeout(() => {
                        // Bail if the level ended, campaign exited, or a different
                        // level session started (retry/next) while this burst was in flight.
                        if (session !== this._session || !this.active || STATE.campaign.ended) return;
                        if (typeof spawnRequest === "function") spawnRequest();
                    }, i * 20);
                }
            }
        }

        // 2) Forced service outage (level config: forceOutageAtSec)
        const outageAt = STATE.campaign.level?.forceOutageAtSec;
        if (outageAt && !STATE.campaign.outageFired && STATE.elapsedGameTime >= outageAt) {
            STATE.campaign.outageFired = true;
            const target = (STATE.services || []).find((s) => s.type === "waf");
            if (target) {
                // Resilience (#196): same session counter the random outage
                // event bumps — a forced outage is still a node failure.
                if (STATE.resilience) STATE.resilience.outages++;
                target.isDisabled = true;
                target.mesh.material.opacity = 0.3;
                target.mesh.material.transparent = true;
                if (typeof addInterventionWarning === "function") {
                    addInterventionWarning(`Service outage: ${target.config.name} offline!`, "danger", 5000);
                }
            }
        }

        // 2b) Forced region outage (level config: forceRegionOutageAtSec, #221).
        // The whole stack behind the DNS's first-wired front door goes dark at
        // T and comes back regionOutageDurationSec later, so the player sees
        // GeoDNS shift traffic away AND back — active-active in both
        // directions. updateRegionOutage re-asserts the disable every frame
        // (a paused random outage's cleanup re-enables everything) and runs
        // the game-time restore clock, so pause freezes the whole event.
        const regionAt = STATE.campaign.level?.forceRegionOutageAtSec;
        if (regionAt && !STATE.campaign.regionOutageFired && STATE.elapsedGameTime >= regionAt) {
            STATE.campaign.regionOutageFired = true;
            triggerRegionOutage(STATE.campaign.level.regionOutageDurationSec ?? 25);
        }
        if (STATE.campaign.regionOutage?.active) updateRegionOutage();

        // 3) Re-evaluate objectives at 2 Hz
        this._tickCounter += dt;
        if (this._tickCounter >= 0.5) {
            this._tickCounter = 0;
            this._evaluateObjectives();
            this._checkEndConditions();
        }
    }

    // ---- Hooks called from finishRequest in game.js (wired in Task 10) ----

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

        // A win additionally requires the level to have actually been PLAYED:
        // at least one completed request this attempt (#158 verification).
        // Level 10's primaries (netProfit >= -210, rep >= 70) are vacuously
        // true on an untouched board, so the very first 2 Hz check used to
        // declare a 3-star win at t=0.5s — farming first_win / speed_demon /
        // minimalist / no_upgrades (plus pacifist_run with one idle
        // serverless) with zero play. completedByType is reset per attempt in
        // loadLevel and fed only by onRequestCompleted (the finishRequest
        // site), and campaign state is never restored from save files, so the
        // gate cannot be pre-satisfied. Zero completions can never win; a
        // timeout with zero completions is a loss.
        const played = Object.values(STATE.campaign.completedByType || {})
            .some((n) => n > 0);
        const allPrimary = level.objectives.primary.every((o) => STATE.campaign.objectiveResults[o.id]);

        // FAIL conditions take priority
        const fc = level.failConditions || {};
        // Reasons are { key, vars } — this module owns no display text (#238);
        // the debrief translates them in the player's CURRENT locale.
        if (typeof fc.repBelow === "number" && STATE.reputation < fc.repBelow) {
            return this._end("lose", { key: "campaign_fail_rep", vars: { n: fc.repBelow } });
        }
        if (typeof fc.moneyBelow === "number" && STATE.money < fc.moneyBelow) {
            return this._end("lose", { key: "campaign_fail_money", vars: { n: fc.moneyBelow } });
        }
        if (typeof fc.timeoutSec === "number" && STATE.elapsedGameTime >= fc.timeoutSec) {
            // Treat as lose if the win gate is not met yet — including the
            // zero-completions case, so a gated level still terminates.
            if (!allPrimary || !played) return this._end("lose", { key: "campaign_fail_timeout" });
        }

        // WIN: all primary objectives met on a level that served traffic
        if (allPrimary && played) {
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

        // Notify UI (defined in Task 12)
        if (typeof showCampaignDebrief === "function") {
            showCampaignDebrief(outcome, reason, STATE.campaign.level);
        }
    }

    _calculateStars() {
        const level = STATE.campaign.level;
        let stars = 1; // base for completion

        const bonuses = level.objectives.bonus || [];
        const met = bonuses.filter((o) => STATE.campaign.bonusResults[o.id]).length;

        // +1 if any bonus objective met
        if (met > 0) stars++;

        // +1 for doing MORE than finishing — by speed, or by completeness.
        //
        // Speed alone could not carry this star (#256). A level ends the
        // instant its primaries all pass, so on the eleven levels whose
        // primary is `survive_Ns` the earliest possible win is exactly N and
        // the star wanted 0.8N: unreachable by any play, however perfect, and
        // with it went cache_master, replica_master, search_master and
        // completionist. "Hold the line for sixty seconds" cannot be rushed,
        // so on those levels the third star has to mean something else.
        //
        // Every bonus met is that something else, and it costs nothing to
        // read: both bonus objectives are already listed on screen. It also
        // gives the second bonus a purpose for the first time — under the old
        // rule the first bonus bought a star and the second bought nothing.
        //
        // Strictly additive: this only ever adds a path, so no run that
        // scored three stars before scores fewer now, and no saved star is
        // revoked (_persistWin keeps the max).
        //
        // The `>= 2` guard is what keeps the star earned. With a single bonus,
        // "any" and "every" are the same condition and the third star would
        // fall out with the second. A future level that has one bonus AND a
        // time-gated primary must grow a second bonus instead — the
        // reachability walk in campaign-stars.test.mjs fails until it does.
        const fast = STATE.elapsedGameTime <= level.durationSec * 0.8;
        const flawless = bonuses.length >= 2 && met === bonuses.length;
        if (fast || flawless) stars++;

        return Math.min(3, stars);
    }

    _persistWin(levelId, stars, elapsed) {
        const progress = this.loadProgress();
        const existing = progress.completed[levelId] || { stars: 0, bestTimeSec: Infinity };
        // Guard against a malformed/hand-edited entry missing bestTimeSec —
        // Math.min(undefined, elapsed) is NaN and would poison the best time forever.
        const prevBest = Number.isFinite(existing.bestTimeSec) ? existing.bestTimeSec : Infinity;
        progress.completed[levelId] = {
            stars: Math.max(existing.stars || 0, stars),
            bestTimeSec: Math.min(prevBest, elapsed),
            lastPlayed: Date.now(),
        };
        progress.highestUnlocked = Math.max(progress.highestUnlocked, levelId + 1);
        this.saveProgress(progress);
        // MUST stay the last statement (after saveProgress): the hook passes
        // the updated progress object, so winning a chapter's final level
        // grants the chapter achievement in this very call.
        achievements.onLevelWin(levelId, stars, elapsed, { progress });
    }

    exit() {
        this.active = false;
        STATE.campaign.active = false;
    }
}

window.campaign = new CampaignController();
