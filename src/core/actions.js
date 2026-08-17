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
// hasTrippedDownstream is the fail-fast attribution for the badges (#156).
import { hasTrippedDownstream, isRoutable } from "../sim/circuit-breaker.js";
// Educational failure badges (#156). The `reason` argument threaded through
// failRequest / failOrPark / throttleRequest is pure attribution: it is read
// only here, only to draw a label, and never influences control flow. See the
// contract note in core/failure-reasons.js.
import { FAIL_REASONS, SOFT_BADGES } from "./failure-reasons.js";
import { spawnFailureBadge, spawnServiceBadge } from "../ui/failure-badges.js";
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
        failRequest(req, FAIL_REASONS.NO_ROUTE);
        return;
    }
    const entryNodes = conns.map((id) =>
        STATE.services.find((s) => s.id === id)
    );

    let target;

    // 1. Prefer CDN for STATIC traffic (edge cache sits even in front of DNS
    //    for static content).
    if (type === "STATIC") {
        target = pickEntryNode(entryNodes, "cdn");
    }

    // 2. GeoDNS (#198) is the front-most distributor: if one is wired to the
    //    Internet, everything else enters through it and it fans the record out
    //    across its own independent regional stacks (see the dns handler). This
    //    sits ABOVE WAF/API-GW on purpose — DNS resolves before any single
    //    stack's front door is reached.
    if (!target) {
        target = pickEntryNode(entryNodes, "dns");
    }

    // 3. Fallback to WAF (Security Best Practice)
    if (!target) {
        target = pickEntryNode(entryNodes, "waf");
    }

    // 4. Fallback to API Gateway (Rate Limiting)
    if (!target) {
        target = pickEntryNode(entryNodes, "apigw");
    }

    // 5. Last Resort: any live entry point (also round-robin)
    if (!target) {
        target = pickEntryNode(entryNodes, "any");
    }

    if (target) req.flyTo(target);
    else failRequest(req, FAIL_REASONS.NO_ROUTE);
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

        // LATENESS HAS A PRICE (#248). A completion past its traffic class's
        // SLO still completes — it is not a failure and never touches
        // failRequest — but it is worth less, exactly like the GPU's bad
        // answer. Without this a queue is a FREE win: the reference board
        // with an SQS in front of a saturated Compute scores 0 failures and
        // reputation 100 while requests stand 12 seconds in the pipe, and
        // hints.js actively recommends that move. Survival only: campaign
        // levels are balanced against the old arithmetic and their objectives
        // count completions, so their play stays byte-identical.
        // The COUNT is taken in every mode. It is read by exactly one thing,
        // getRunReport() for the debrief, and by nothing the simulation feeds
        // back — so counting it in a campaign level cannot move that level's
        // balance, while NOT counting it made the debrief claim 100% on time
        // for a board where every request stood in a queue past its SLO.
        // The PRICE below stays survival-only, because req.wasLate is read
        // back by reputation and by the SLOW badge.
        if (req.sloSec && req.age > req.sloSec) {
            STATE.lateCompletions = (STATE.lateCompletions || 0) + 1;
        }
        if (STATE.gameMode === "survival" && req.sloSec && req.age > req.sloSec) {
            // Decay toward a floor over one further SLO of lateness, so the
            // penalty is a gradient rather than a cliff: 1 SLO late ~ the
            // floor, and everything between scales smoothly.
            const floor = points.LATE_REWARD_FLOOR ?? 0.25;
            const overdue = Math.min(1, (req.age - req.sloSec) / req.sloSec);
            reward *= 1 - (1 - floor) * overdue;
            req.wasLate = true;
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
        // A late completion earns the late tax INSTEAD of the success bonus,
        // so a board serving everything late bleeds slowly while its failure
        // counter reads zero — the production experience of a full queue.
        STATE.reputation += req.wasLate
            ? (points.LATE_REPUTATION ?? -0.3)
            : (points.SUCCESS_REPUTATION || 0.5);
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
        // GAME-time latency (#248). This used to read the wall clock, which
        // made every latency sample wrong at any timeScale but 1 and unusable
        // in a headless run — the metric the Monitoring node sells.
        const latency = typeof req.age === "number" ? req.age * 1000 : null;
        recordServiceSuccess(service, latency);
    }
    updateScore(req, "COMPLETED");
    // The badge is spawned AFTER scoring and reads the flag updateScore set,
    // so it can never change which requests are late — it only tells the
    // player which node made them wait (#156 inertness contract).
    if (req.wasLate && service) {
        spawnServiceBadge(service, SOFT_BADGES.SLOW);
    }
    if (window.campaign?.active) {
        window.campaign.onRequestCompleted(req, viaServiceType);
    }
    removeRequest(req);
}

// `reason` (optional second param, #156) is a FAIL_REASONS value describing WHY
// this request died, purely so the badge over the node can teach it. It is
// read once, at the very end, to spawn a label — it touches no counter, no
// score and no branch, so passing one can never change which requests fail.
// Defaults to null (no badge) for callers with nothing to say.
function failRequest(req, reason = null) {
    // Tally the cause for the debrief's run report (#252). This is the ONE
    // place a reason is counted; it still touches no branch, no score and no
    // other counter, so the #156 contract ("passing a reason can never change
    // which requests fail") holds — a tally is an observation, not a verdict.
    if (reason) {
        STATE.failuresByReason[reason] = (STATE.failuresByReason[reason] || 0) + 1;
    }
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
    // A MALICIOUS request that reaches here got through — whatever routing
    // verdict actually dropped it, the lesson is the breach, which is also
    // exactly what updateScore just charged the player for.
    spawnFailureBadge(
        req,
        req.type === TRAFFIC_TYPES.MALICIOUS ? FAIL_REASONS.BREACH : reason
    );
    setTimeout(() => removeRequest(req), 500);
}

// Fail-fast attribution (#156). A node that found no candidate downstream
// normally means the player forgot a wire — but if the only downstream is
// there and merely TRIPPED, the request is being shed by the circuit breaker,
// which is a completely different lesson. Resolving it here (rather than at
// every routing site) keeps the handlers' one-liners intact, and it is pure
// relabelling: NO_ROUTE and CIRCUIT_OPEN both fail the request identically.
function routingReason(service, reason) {
    if (reason !== FAIL_REASONS.NO_ROUTE) return reason;
    return hasTrippedDownstream(service) ? FAIL_REASONS.CIRCUIT_OPEN : reason;
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
function failOrPark(req, service, reason = null) {
    if (parkInDLQ(req, service)) return;
    failRequest(req, routingReason(service, reason));
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

function throttleRequest(req, reason = null) {
    // Throttling is load shedding working as designed, not a service error:
    // it feeds neither the metrics error rate nor the breaker window. The flag
    // keeps Service.update() from scoring it as a breaker success either.
    req.throttled = true;
    updateScore(req, "THROTTLED");
    STATE.sound.playFail();
    req.mesh.material.color.setHex(CONFIG.colors.apigw); // Pink flash for throttled
    // Soft fail (#156): the badge paints this one amber, not red — the
    // gateway did its job, the player just hit the rate limit.
    spawnFailureBadge(req, reason);
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
