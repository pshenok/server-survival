// Simulation-core request lifecycle (#155 PR 4): spawn -> route -> score ->
// finish/fail/throttle/remove, plus the load/upkeep helpers Service.js and
// Request.js consume. Code moved verbatim from game.js.

import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
// Cyclic import (actions.js <-> Request.js) is safe: Request is only
// constructed at runtime (spawnRequest), long after both modules evaluate.
import { Request } from "../entities/Request.js";

function getUpkeepMultiplier() {
    if (STATE.gameMode !== "survival") return 1.0;
    if (!CONFIG.survival.upkeepScaling.enabled) return 1.0;

    const gameTime =
        STATE.elapsedGameTime ?? (performance.now() - STATE.gameStartTime) / 1000;
    const progress = Math.min(
        gameTime / CONFIG.survival.upkeepScaling.scaleTime,
        1.0
    );

    const base = CONFIG.survival.upkeepScaling.baseMultiplier;
    const max = CONFIG.survival.upkeepScaling.maxMultiplier;

    let multiplier = base + (max - base) * progress;

    if (STATE.intervention?.costMultiplier) {
        multiplier *= STATE.intervention.costMultiplier;
    }

    return multiplier;
}

function getTrafficType() {
    const dist = STATE.trafficDistribution;
    const types = Object.keys(dist);
    const total = types.reduce((sum, type) => sum + (dist[type] || 0), 0);
    // All types at 0% means "no traffic", not "default to STATIC" (#174).
    if (total === 0) return null;

    const r = Math.random() * total;
    let cumulative = 0;

    for (const type of types) {
        cumulative += dist[type] || 0;
        if (r < cumulative) {
            return TRAFFIC_TYPES[type] || type;
        }
    }

    return TRAFFIC_TYPES.STATIC;
}

// Round-robin counters for entry-point load splitting across
// multiple services of the same type (e.g. two WAFs on the Internet).
// Keyed by service type ("waf", "cdn", "apigw", "any").
const entryRRIndex = {};

function pickEntryNode(entryNodes, type) {
    // Filter for live (non-disabled) nodes of the requested type.
    // Type "any" means "any live entry node" (last-resort path).
    const candidates = entryNodes.filter((s) => {
        if (!s || s.isDisabled) return false;
        return type === "any" ? true : s.type === type;
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Round robin: each subsequent call rotates to the next candidate,
    // splitting load evenly across identical entry points.
    const idx = (entryRRIndex[type] || 0) % candidates.length;
    entryRRIndex[type] = idx + 1;
    return candidates[idx];
}

function spawnRequest() {
    const type = getTrafficType();
    // No traffic mix configured (all sliders at 0%) — nothing to spawn (#174).
    if (type === null) return;
    const req = new Request(type);
    STATE.requests.push(req);
    routeRequestToEntry(req, type);
}

// Shared entry routing for spawned traffic (regular spawns AND sandbox bursts).
// Round-robin aware so multiple firewalls / CDNs / gateways share the load.
function routeRequestToEntry(req, type) {
    const conns = STATE.internetNode.connections;
    if (conns.length === 0) {
        failRequest(req);
        return;
    }
    const entryNodes = conns.map((id) =>
        STATE.services.find((s) => s.id === id)
    );

    let target;

    // 1. Prefer CDN for STATIC traffic
    if (type === "STATIC") {
        target = pickEntryNode(entryNodes, "cdn");
    }

    // 2. Fallback to WAF (Security Best Practice)
    if (!target) {
        target = pickEntryNode(entryNodes, "waf");
    }

    // 3. Fallback to API Gateway (Rate Limiting)
    if (!target) {
        target = pickEntryNode(entryNodes, "apigw");
    }

    // 4. Last Resort: any live entry point (also round-robin)
    if (!target) {
        target = pickEntryNode(entryNodes, "any");
    }

    if (target) req.flyTo(target);
    else failRequest(req);
}

function updateScore(req, outcome) {
    const points = CONFIG.survival.SCORE_POINTS;
    const typeConfig = req.typeConfig || CONFIG.trafficTypes[req.type];

    if (outcome === "MALICIOUS_BLOCKED") {
        STATE.score.maliciousBlocked += points.MALICIOUS_BLOCKED_SCORE;
        STATE.score.total += points.MALICIOUS_BLOCKED_SCORE;

        // Mitigation cost for blocking attacks
        const mitigationCost = CONFIG.survival.SCORE_POINTS.MALICIOUS_MITIGATION_COST || 1.0;
        STATE.money -= mitigationCost;
        if (STATE.finances) {
            STATE.finances.expenses.mitigation = (STATE.finances.expenses.mitigation || 0) + mitigationCost;
        }
        STATE.sound.playFraudBlocked();
    } else if (
        req.type === TRAFFIC_TYPES.MALICIOUS &&
        outcome === "MALICIOUS_PASSED"
    ) {
        STATE.reputation += points.MALICIOUS_PASSED_REPUTATION;
        STATE.failures.MALICIOUS++;

        // Breach penalty
        const breachPenalty = CONFIG.survival.SCORE_POINTS.MALICIOUS_BREACH_PENALTY || 50.0;
        STATE.money -= breachPenalty;
        if (STATE.finances) {
            STATE.finances.expenses.breach = (STATE.finances.expenses.breach || 0) + breachPenalty;
        }

        console.warn(
            `MALICIOUS PASSED: ${points.MALICIOUS_PASSED_REPUTATION} Rep. (Critical Failure)`
        );
    } else if (outcome === "COMPLETED") {
        let reward = typeConfig.reward;
        const score = typeConfig.score;

        if (req.cached) {
            reward *= 1 + points.CACHE_HIT_BONUS;
        }

        if (typeConfig.destination === "s3" || typeConfig.destination === "cdn") {
            STATE.score.storage += score;
        } else if (typeConfig.destination === "db") {
            STATE.score.database += score;
        }

        STATE.score.total += score;
        STATE.money += reward;
        if (STATE.finances) {
            STATE.finances.income.requests += reward;
            STATE.finances.income.total += reward;
            // Track by request type
            const reqType = req.type || "STATIC";
            STATE.finances.income.byType[reqType] =
                (STATE.finances.income.byType[reqType] || 0) + reward;
            STATE.finances.income.countByType[reqType] =
                (STATE.finances.income.countByType[reqType] || 0) + 1;
        }
        STATE.reputation += points.SUCCESS_REPUTATION || 0.5; // Gain reputation on success
    } else if (outcome === "THROTTLED") {
        // Soft fail from API Gateway rate limiting — much less reputation loss
        STATE.reputation += points.THROTTLED_REPUTATION || -0.2;
    } else if (outcome === "FAILED") {
        STATE.reputation += points.FAIL_REPUTATION;
        STATE.score.total -= (typeConfig.score || 5) / 2;
        if (STATE.failures[req.type] !== undefined) {
            STATE.failures[req.type]++;
        }
    }

    updateScoreUI();
}

function finishRequest(req, viaServiceType) {
    STATE.requestsProcessed++;
    updateScore(req, "COMPLETED");
    if (window.campaign?.active) {
        window.campaign.onRequestCompleted(req, viaServiceType);
    }
    removeRequest(req);
}

function failRequest(req) {
    const failType =
        req.type === TRAFFIC_TYPES.MALICIOUS ? "MALICIOUS_PASSED" : "FAILED";
    updateScore(req, failType);
    STATE.sound.playFail();
    req.mesh.material.color.setHex(CONFIG.colors.requestFail);
    setTimeout(() => removeRequest(req), 500);
}

function throttleRequest(req) {
    updateScore(req, "THROTTLED");
    STATE.sound.playFail();
    req.mesh.material.color.setHex(CONFIG.colors.apigw); // Pink flash for throttled
    setTimeout(() => removeRequest(req), 500);
}

function removeRequest(req) {
    req.destroy();
    STATE.requests = STATE.requests.filter((r) => r !== req);
}

function updateScoreUI() {
    document.getElementById("total-score-display").innerText = STATE.score.total;
    document.getElementById("score-storage").innerText = STATE.score.storage;
    document.getElementById("score-database").innerText = STATE.score.database;
    document.getElementById("score-malicious").innerText =
        STATE.score.maliciousBlocked;
}

function flashMoney() {
    const el = document.getElementById("money-display");
    el.classList.add("text-red-500");
    setTimeout(() => el.classList.remove("text-red-500"), 300);
}

/**
 * Calculates the percentage if failure based on the load of the node.
 * @param {number} load fractions of 1 (0 to 1) of how loaded the node is
 * @returns {number} chance of failure (0 to 1)
 */
function calculateFailChanceBasedOnLoad(load) {
    if (load <= 0.5) return 0;
    return 2 * (load - 0.5);
}

export {
    calculateFailChanceBasedOnLoad,
    failRequest,
    finishRequest,
    flashMoney,
    getUpkeepMultiplier,
    removeRequest,
    routeRequestToEntry,
    spawnRequest,
    throttleRequest,
    updateScore,
    updateScoreUI,
};
