// Circuit breaker (#196, Wave 1 of #193) — the resilience flagship. An
// upstream stops sending traffic to a downstream that is failing, so requests
// fail FAST (or reroute to a healthy peer) instead of piling onto a dying
// node:
//
//   closed     normal. Every job outcome on the service is recorded in a small
//              rolling window; error rate > tripErrorRate over at least
//              tripMinEvents events -> open.
//   open       routing skips the service exactly like isDisabled does. After
//              openSec of game time -> half-open.
//   half-open  a limited number of probes (probeCount) is let through. Every
//              probe outcome is recorded: one failure sends it straight back
//              to open (timer reset), probeCount successes close it.
//
// State lives ON the service (initBreaker seeds it for every type, so the
// isRoutable() predicate never has to null-check):
//   breakerState     'closed' | 'open' | 'half-open'
//   breakerOpenedAt  STATE.elapsedGameTime of the last trip (display only)
//   breakerOpenSince seconds of game time accumulated in 'open'
//   breakerProbes    probes still allowed in 'half-open'
//   breakerEvents    rolling window of 0 (ok) / 1 (error), newest last
//
// COUNTERS: the breaker keeps its OWN window instead of reading the ring
// buffers in core/metrics.js. Deliberate — resilience must not depend on
// observability: the breaker has to work whether or not the player bought a
// Monitoring service, and metrics' 0.5 s sampling is the wrong granularity
// for an event-count threshold. The two counters are fed from the same call
// sites and agree; they are simply not the same mechanism.
//
// Timers accumulate the game-scaled dt Service.update() receives (same
// semantics as metrics.js / autoscaling.js), so pause freezes the breaker and
// fast-forward runs it faster — no wall clock anywhere.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
// Runtime-only cycle (circuit-breaker.js -> metrics.js -> events.js ->
// game.js -> ... -> circuit-breaker.js) — established pattern: hoisted
// function declarations, only dereferenced long after every module evaluates.
// fireAlert is reused (rather than re-implemented) so breaker alerts share the
// per-service cooldown with the #194 threshold alerts. Note fireAlert itself
// is NOT gated on hasMonitoring() — only checkAlerts() is — which is exactly
// what we want: a trip is a routing event, not a dashboard reading.
import { fireAlert } from "../core/metrics.js";

// Seeded from the Service constructor for EVERY type: a closed breaker is
// invisible, and it keeps isRoutable() a two-line predicate.
function initBreaker(service) {
    service.breakerState = "closed";
    service.breakerOpenedAt = 0;
    service.breakerOpenSince = 0;
    service.breakerProbes = 0;
    service.breakerEvents = [];
}

// THE routing predicate. Every candidate filter in the sim funnels through
// this: Service.findConnectedService, the handler registry's genericForward,
// the apigw / cdn / sqs handlers, Compute's SQS-pull filter and the entry
// picker in core/actions.js. An open breaker is skipped exactly like a
// disabled node, which is what makes redundancy fail over automatically —
// and what makes a request with no healthy alternative fail immediately
// instead of queueing on a node that is already drowning.
function isRoutable(service) {
    if (!service || service.isDisabled) return false;
    if (service.breakerState === "open") return false;
    if (service.breakerState === "half-open") return service.breakerProbes > 0;
    return true;
}

function isBreakerOpen(service) {
    return service?.breakerState === "open";
}

function errorRate(service) {
    const events = service.breakerEvents;
    if (!events || events.length === 0) return 0;
    let errors = 0;
    for (const e of events) errors += e;
    return errors / events.length;
}

function trip(service) {
    service.breakerState = "open";
    service.breakerOpenSince = 0;
    service.breakerOpenedAt = STATE.elapsedGameTime || 0;
    service.breakerProbes = 0;
    service.breakerEvents = [];
    if (STATE.resilience) STATE.resilience.trips++;
    fireAlert(service, "breaker_open", "alert_breaker_open", "danger");
}

function close(service) {
    service.breakerState = "closed";
    service.breakerOpenSince = 0;
    service.breakerProbes = 0;
    service.breakerEvents = [];
    fireAlert(service, "breaker_closed", "alert_breaker_closed", "info");
}

// One recorded job outcome. Three call sites, all documented where they live:
//   failure  Service.update()'s load/health failure roll, and Request.update()
//            when a node's queue is too full to accept an arrival. Both mean
//            "this node dropped work it should have handled". Routing dead
//            ends (no path to the destination, wrong service for the traffic
//            type) are NOT failures here — see the note on failRequest().
//   success  Service.update()'s dispatch loop, once a job left the node
//            without being failed or throttled.
function recordOutcome(service, isError) {
    // Guards: the Internet node and any plain test double have no breaker.
    if (!service || !service.breakerState) return;
    const cfg = CONFIG.resilience;

    if (service.breakerState === "half-open") {
        // Probe result. One failure is enough to re-open — a half-open
        // breaker is a question, not a second chance per request.
        if (isError) {
            trip(service);
            return;
        }
        service.breakerProbes--;
        if (service.breakerProbes <= 0) close(service);
        return;
    }

    // Open: nothing is routed here, and the stragglers already in flight say
    // nothing about recovery. Ignore them.
    if (service.breakerState === "open") return;

    service.breakerEvents.push(isError ? 1 : 0);
    while (service.breakerEvents.length > cfg.windowSize) {
        service.breakerEvents.shift();
    }

    if (
        service.breakerEvents.length >= cfg.tripMinEvents &&
        errorRate(service) > cfg.tripErrorRate
    ) {
        trip(service);
    }
}

function recordBreakerFailure(service) {
    recordOutcome(service, true);
}

function recordBreakerSuccess(service) {
    recordOutcome(service, false);
}

// The single call site is Service.update(); the gate lives here so the caller
// stays one unconditional line.
function updateBreaker(service, dt) {
    if (service.breakerState !== "open") return;
    // Paused: freeze like metrics/ASG do. dt is already 0 at timeScale 0, but
    // the explicit guard stops a future unscaled caller from healing a
    // breaker while the game is stopped.
    if (STATE.timeScale === 0) return;

    service.breakerOpenSince += dt;
    if (service.breakerOpenSince >= CONFIG.resilience.openSec) {
        service.breakerState = "half-open";
        service.breakerOpenSince = 0;
        service.breakerProbes = CONFIG.resilience.probeCount;
    }
}

// Cleared from resetGame() alongside resetMetrics(). The per-service state
// dies with the services themselves; only the session counters live here.
function resetResilience() {
    STATE.resilience = { trips: 0, retries: 0, outages: 0 };
}

export {
    errorRate,
    initBreaker,
    isBreakerOpen,
    isRoutable,
    recordBreakerFailure,
    recordBreakerSuccess,
    resetResilience,
    updateBreaker,
};
