// Dead-Letter Queue mechanic (#197, Sandbox archetypes batch 1). The DLQ is
// the only node that HOLDS already-failed requests instead of dropping them,
// turning a hard failure into a recoverable cost. It sits outside the normal
// job-dispatch pipeline entirely: nothing is ever routed INTO a DLQ's queue —
// a failing upstream parks its dead request directly via parkInDLQ(), and the
// DLQ drains itself from the update loop via tickDLQ(). So there is no handler
// registry entry for "dlq"; the wiring lives here + two call sites (the fail
// path in core/actions.js and the per-frame tick in Service.update()).
//
// Termination invariant (#191/#192): every parked request terminates. A parked
// request is inert (not moving, not queued, not a job) until the auto-drain
// removeRequest()s it — recovered, counted as neither success nor failure. If
// the DLQ is full, parkInDLQ() refuses and the caller fails the request
// normally, so nothing is ever stranded.

import { STATE } from "../state.js";
// Runtime-only cycle (actions.js ⇄ dlq.js): removeRequest is a hoisted
// function declaration, only dereferenced when a drain actually fires — long
// after both modules finish evaluating. Same established pattern as retry.js.
import { removeRequest } from "../core/actions.js";

// Find a routable Dead-Letter Queue wired to `service`, if any.
function connectedDLQ(service) {
    if (!service || !service.connections) return null;
    return (
        STATE.services.find(
            (s) =>
                service.connections.includes(s.id) &&
                s.type === "dlq" &&
                !s.isDisabled
        ) || null
    );
}

// Park a request that would otherwise finally fail. Returns true when the
// request was parked (caller must NOT failRequest it), false when there is no
// DLQ or it is full (caller fails it normally). MALICIOUS is never parked —
// otherwise a player could route attacks into a DLQ and drain them away to
// dodge the breach penalty entirely.
export function parkInDLQ(req, service) {
    if (!req || req.type === "MALICIOUS") return false;
    const dlq = connectedDLQ(service);
    if (!dlq) return false;

    if (!dlq.parked) dlq.parked = [];
    const cap = dlq.config.capacity || 25;
    if (dlq.parked.length >= cap) {
        // Overflow: an unmanaged DLQ is worse than none. Refuse the park (the
        // caller drops it normally) and accrue an extra reputation penalty.
        STATE.reputation -= dlq.config.overflowRepPenalty || 0;
        return false;
    }

    req.parked = true;
    req.isMoving = false;
    req.retryDelay = 0;
    dlq.parked.push(req);
    // Settle the request's marker onto the DLQ node so the player can see the
    // backlog piling up.
    if (req.mesh && dlq.position) {
        req.mesh.position.copy(dlq.position);
        req.mesh.position.y = 2;
    }
    return true;
}

// Automatic slow drain, ticked once per frame from Service.update(). Each
// drained request is RECOVERED — removed cleanly (neither success nor failure)
// at a money cost, refunding a little reputation. Never gated on money (a drain
// must always make progress so parked requests cannot leak); spending into the
// red is a real survival cost, exactly like upkeep.
export function tickDLQ(dlq, dt) {
    if (!dlq.parked || dlq.parked.length === 0) return;
    dlq.drainTimer = (dlq.drainTimer || 0) + dt;
    const interval = dlq.config.drainIntervalSec || 0.6;
    while (dlq.drainTimer >= interval && dlq.parked.length > 0) {
        dlq.drainTimer -= interval;
        const req = dlq.parked.shift();
        STATE.money -= dlq.config.drainCost || 0;
        STATE.reputation += dlq.config.drainRepRefund || 0;
        if (STATE.finances) {
            STATE.finances.expenses.mitigation =
                (STATE.finances.expenses.mitigation || 0) +
                (dlq.config.drainCost || 0);
        }
        removeRequest(req);
    }
}
