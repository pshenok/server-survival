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
                    setTimeout(() => {
                        // Bail if the level ended or campaign exited while this burst was in flight.
                        if (!this.active || STATE.campaign.ended) return;
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

        // Notify UI (defined in Task 12)
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
