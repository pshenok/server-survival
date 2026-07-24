// Simulation-core request lifecycle (#155 PR 4): spawn -> route -> score ->
// finish/fail/throttle/remove, plus the load/upkeep helpers Service.js and
// Request.js consume. Code moved verbatim from game.js.

import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
// Cyclic import (actions.js <-> Request.js) is safe: Request is only
// constructed at runtime (spawnRequest), long after both modules evaluate.
import { Request } from "../entities/Request.js";
// Observability attribution (#194): error/success/latency counters feed the
// metrics ring buffers. Runtime-only cycle (actions.js -> metrics.js ->
// events.js -> game.js -> actions.js) — established pattern, hoisted
// function declarations only dereferenced at runtime.
import { recordServiceError, recordServiceSuccess } from "./metrics.js";
// Resilience (#196): routing skips tripped nodes exactly like disabled ones.
// The breaker's counters are NOT fed from here — see the note on failRequest.
import { isRoutable } from "../sim/circuit-breaker.js";
// Dead-Letter Queue (#197): a final failure at a node wired to a DLQ is parked
// there instead of dropped. Runtime-only cycle (actions.js ⇄ dlq.js) — hoisted
// declarations, dereferenced long after both modules evaluate.
import { parkInDLQ } from "../sim/dlq.js";

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
    // Filter for live nodes of the requested type.
    // Type "any" means "any live entry node" (last-resort path).
    const ofType = entryNodes.filter((s) => {
        if (!s || s.isDisabled) return false;
        return type === "any" ? true : s.type === type;
    });
    // Resilience (#196): prefer entry points whose breaker is closed, so two
    // firewalls fail over for each other. But if EVERY entry point of the type
    // is tripped we fall back to the plain live set instead of returning null:
    // the front door has no alternative path, and black-holing all traffic
    // there would punish the player far harder than the overload the breaker
    // was trying to shed. A breaker only helps where there is somewhere else
    // to go.
    const routable = ofType.filter(isRoutable);
    const candidates = routable.length > 0 ? routable : ofType;
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

// `service` (optional third param, #194) is the finishing Service instance —
// every handler has it in scope and passes it, so completions and their
// latency (wall-clock since the request's spawnedAt stamp) are attributed
// per-instance. Callers without a service ref just skip attribution.
function finishRequest(req, viaServiceType, service) {
    STATE.requestsProcessed++;
    if (service) {
        const latency =
            typeof req.spawnedAt === "number"
                ? performance.now() - req.spawnedAt
                : null;
        recordServiceSuccess(service, latency);
    }
    updateScore(req, "COMPLETED");
    if (window.campaign?.active) {
        window.campaign.onRequestCompleted(req, viaServiceType);
    }
    removeRequest(req);
}

function failRequest(req) {
    // Observability (#194): attribute the failure to the service the request
    // was headed to / sitting on. Entry-routing failures with no target (no
    // Internet connections at all) stay unattributed by design. `failed` marks
    // the request so Service.update() does not count this job as a breaker
    // success.
    //
    // The CIRCUIT BREAKER (#196) is deliberately NOT fed from here. Most
    // failRequest calls are routing verdicts — "no path to this destination",
    // "a Replica cannot serve a WRITE", "MALICIOUS has nowhere to go" — and
    // those say nothing about the node's health: an identical peer would fail
    // them identically, so tripping only takes the node away from the traffic
    // it CAN still serve. The breaker is fed from the two sites where a node
    // genuinely drops work it should have handled: the load/health failure
    // roll in Service.update() and the queue-overflow drop in Request.update().
    req.failed = true;
    if (req.target && req.target.id && req.target.id !== "internet") {
        recordServiceError(req.target);
    }
    const failType =
        req.type === TRAFFIC_TYPES.MALICIOUS ? "MALICIOUS_PASSED" : "FAILED";
    updateScore(req, failType);
    STATE.sound.playFail();
    req.mesh.material.color.setHex(CONFIG.colors.requestFail);
    setTimeout(() => removeRequest(req), 500);
}

// Dead-Letter Queue interception (#197). The single choke point every "this
// request finally failed AT a node" site funnels through: if the failing
// service has a connected DLQ with room, the request is PARKED there (recovered
// later at a cost) instead of failed. Otherwise it fails normally. `service` is
// the node that ran out of options — handlers pass themselves, and
// Service.update()'s load-failure roll passes `this`. Failure sites with no
// service context (entry routing with no Internet link, queue overflow in
// Request.update) keep calling failRequest directly: there is no node to hang a
// DLQ off. MALICIOUS is never parked (see parkInDLQ).
function failOrPark(req, service) {
    if (parkInDLQ(req, service)) return;
    failRequest(req);
}

// Notification silent failure (#197). A Notification node's overload drops are
// SILENT: no fail sound, only a fraction of the normal reputation hit accrued
// as "dissatisfaction", and NOT counted as a scored failure. The request still
// terminates, and the drop still feeds the metrics error rate so the dashboard
// reflects a struggling Notification node. `req.failed` keeps Service.update()
// from scoring this dispatch as a breaker success.
function notifySilentFail(req, service) {
    req.failed = true;
    if (service && service.id) recordServiceError(service);
    STATE.reputation -= service?.config?.dissatisfaction || 0;
    if (service) {
        service.dissatisfactionCount = (service.dissatisfactionCount || 0) + 1;
    }
    removeRequest(req);
}

function throttleRequest(req) {
    // Throttling is load shedding working as designed, not a service error:
    // it feeds neither the metrics error rate nor the breaker window. The flag
    // keeps Service.update() from scoring it as a breaker success either.
    req.throttled = true;
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
    failOrPark,
    failRequest,
    finishRequest,
    flashMoney,
    getUpkeepMultiplier,
    notifySilentFail,
    removeRequest,
    routeRequestToEntry,
    spawnRequest,
    throttleRequest,
    updateScore,
    updateScoreUI,
};
