// Retry with backoff (#196, Wave 1 of #193). A request that hits a transient
// service-level failure gets ONE more chance (CONFIG.resilience.maxRetries)
// via a healthy peer before it is counted as failed — the transient-fault
// lesson, and, if the knobs are ever loosened, the retry-storm lesson.
//
// WHY THIS IS THE ONLY RETRY SITE: the single unambiguous "transient" failure
// in the sim is the load/health failure roll in Service.update(). Every other
// failRequest() call is a topology verdict ("no route to the destination", "a
// Replica cannot serve a WRITE", "the queue is full") — retrying those would
// just burn the same dead end again. Keeping the hook to one site is also what
// keeps THE CARDINAL INVARIANT provable: a retried request is still owned by
// exactly one terminator.
//
// FLIGHT MODEL, NOT setTimeout: the backoff is a countdown on the request,
// ticked by Request.update(dt) with the same game-scaled dt as everything else
// (pause freezes it, fast-forward speeds it up, and a reset that drops
// STATE.requests takes the pending retry with it — a raw setTimeout would
// outlive the reset, which is the #183 class of bug). When the countdown ends
// the request either flies to a still-valid peer or is failed on the spot, so
// it always terminates.
//
// COUNTING: a retried request is neither completed nor failed at retry time —
// it is still in flight. It is counted exactly once, when it finally reaches
// finishRequest / failRequest / removeRequest. The FAILED SERVICE is still
// charged the error (metrics + breaker) at the moment of the failure, because
// the error genuinely happened there.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { recordServiceError } from "../core/metrics.js";
// Runtime-only cycle (retry.js -> actions.js -> Request.js -> retry.js) —
// established pattern: failRequest is a hoisted function declaration, only
// dereferenced when a backoff actually expires.
import { failRequest } from "../core/actions.js";
import { isRoutable } from "./circuit-breaker.js";

// A conservative "alternate path exists" test: another routable service of the
// SAME type that the failing node's own upstream can also reach (or that the
// Internet can reach, when the failing node is an entry point). If we cannot
// prove an alternate exists, we do NOT retry — a retry with nowhere to go is
// just a delayed failure plus a leak risk.
function findRetryPeer(service) {
    const peers = STATE.services.filter(
        (s) => s !== service && s.type === service.type && isRoutable(s)
    );
    if (peers.length === 0) return null;

    const upstreams = STATE.services.filter(
        (s) => s !== service && s.connections.includes(service.id) && isRoutable(s)
    );
    const fromInternet = STATE.internetNode.connections.includes(service.id);

    for (const peer of peers) {
        if (upstreams.some((u) => u.connections.includes(peer.id))) return peer;
        if (fromInternet && STATE.internetNode.connections.includes(peer.id)) return peer;
    }
    return null;
}

// Called from Service.update()'s failure roll INSTEAD of failRequest().
// Returns true when the request was taken over by the retry path (the caller
// must then leave it alone), false when the caller must fail it normally.
function retryRequest(req, service) {
    const cfg = CONFIG.resilience;
    if (!cfg.retryEnabled) return false;
    if ((req.retries || 0) >= cfg.maxRetries) return false;

    const peer = findRetryPeer(service);
    if (!peer) return false;

    // Metrics attribution (#194): failRequest() would have done this for us on
    // the non-retry path, so recording it here keeps the error rate identical
    // whichever path the request takes. The BREAKER event is recorded by the
    // caller (Service.update), which fires it on both paths.
    recordServiceError(service);

    req.retries = (req.retries || 0) + 1;
    req.retryTarget = peer;
    req.retryDelay = cfg.retryBackoffSec;
    if (STATE.resilience) STATE.resilience.retries++;
    return true;
}

// Ticked from Request.update(). Returns true while the request is still
// waiting out its backoff (the caller then skips its normal flight step).
// Termination: the countdown is strictly decreasing, and when it ends the
// request either flies again (normal lifecycle) or fails immediately — the
// peer is re-validated because it may have been deleted, disabled or tripped
// during the backoff.
function tickRetry(req, dt) {
    if (!req.retryDelay || req.retryDelay <= 0) return false;

    req.retryDelay -= dt;
    if (req.retryDelay > 0) return true;

    const peer = req.retryTarget;
    req.retryDelay = 0;
    req.retryTarget = null;

    if (peer && STATE.services.includes(peer) && isRoutable(peer)) {
        req.flyTo(peer);
    } else {
        failRequest(req);
    }
    return true;
}

export { findRetryPeer, retryRequest, tickRetry };
