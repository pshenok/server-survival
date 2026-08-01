// Inference Gateway mechanic (#87, The AI Wave). The gateway is the ONLY node
// with a DEADLINE queue: it owns an array of { req, enqueuedAt } entries and
// every tick runs grace-sweep-dispatch, in that order:
//
//   1. WARMUP GRACE: while every connected GPU is mid model-load the stamps
//      slide with game time — the deadline clock waits for a fleet that
//      cannot serve anyone yet. Without this the 6s deadline is SHORTER than
//      every tier's load (12/20/30s) and the gateway expires requests a
//      direct-wired GPU's own bounded queue would have held and served —
//      actively worse than not buying it, inverting the card's pitch.
//   2. SWEEP: every entry older than deadlineSec is spliced out and
//      failRequest()ed as an SLO breach — never failOrPark (a blown deadline
//      is not recoverable work; a stale answer is worthless — explicit
//      decision), and never dispatched after expiry. Splice-before-fail is
//      what makes expiry exactly-once even though the failed request lingers
//      500ms in the fail-fade: it is already out of the array.
//   3. Then dispatch heads to the least-loaded routable GPU (queue + batch +
//      incomingCount). A warming or full fleet just means entries stay put,
//      bounded by maxQueueSize (arrival overflow = the QUEUE_FULL path) plus
//      the expiry above.
//
// Why it exists (the honest pitch, on its concept card): a direct-wired GPU
// has only its tiny bounded intake — during warmup or overload requests die
// fast; the gateway holds up to 20 with deadline honesty and dispatches where
// the batch has room. Its value is measured in reputation saved during those
// windows, not revenue.
//
// It sits OUTSIDE the normal job-dispatch pipeline (like stream/dlq/
// scheduler): Service.update() ticks tickInfgw() and skips processQueue, so
// there is no handler registry entry for "infgw".
//
// Termination invariant (#191/#192): every entry terminates — dispatched to a
// GPU's usual path, expired via failRequest, or re-homed when its node dies
// (deleteObject folds `service.pending` into the orphan set; the region-
// outage teardown splices it — the stream.partitions treatment, all three
// sites). Ages are stamps against STATE.elapsedGameTime, which freezes at
// timeScale 0, so a pause never expires anything (#183).

import { TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
// Runtime-only cycle (Service.js -> infgw.js -> actions.js -> ... -> game.js):
// hoisted declarations, dereferenced long after every module evaluates.
import { failRequest } from "../core/actions.js";
import { FAIL_REASONS } from "../core/failure-reasons.js";
import { isRoutable } from "./circuit-breaker.js";

// Seeded from the Service constructor.
export function initInfgw(service) {
    service.pending = [];
    service.expiredCount = 0;
}

// Can this GPU take one more dispatched request right now? Mirrors the
// queue-overflow gate in Request.update (its bounded intake, in-flight
// included).
function canAccept(gpu) {
    const maxQueue = gpu.config.maxQueueSize || 20;
    return gpu.queue.length + (gpu.incomingCount || 0) < maxQueue;
}

// The dispatch metric from the spec: everything the GPU is already committed
// to — waiting intake, the live batch, and requests in flight toward it.
function gpuLoad(gpu) {
    return gpu.queue.length + (gpu.batch ? gpu.batch.length : 0) + (gpu.incomingCount || 0);
}

// Ticked once per frame from Service.update() with the game-scaled dt. No dt
// accumulator for the ages themselves: they are computed against the
// enqueuedAt stamps, so the deadline clock is exactly the game clock — frozen
// pauses included. dt is only used for the warmup grace below.
export function tickInfgw(service, dt) {
    if (!service.pending) initInfgw(service);
    const cap = service.config.maxQueueSize || 20;

    // 0) Admission: move arrivals into the deadline array, stamping their
    //    enqueue time. The gateway is single-type (fail_gpu_only for anything
    //    else — MALICIOUS relabels to the breach it is), and the held backlog
    //    is BOUNDED at maxQueueSize: an arrival past the cap takes the
    //    QUEUE_FULL drop, same lesson as every other full node. The breaker is
    //    deliberately NOT fed here — this admission is bookkeeping between the
    //    node's own buffers; the genuine arrival-overflow signal already fires
    //    in Request.update when the intake queue itself fills.
    while (service.queue.length > 0) {
        const req = service.queue.shift();
        if (req.type !== TRAFFIC_TYPES.INFERENCE) {
            failRequest(req, FAIL_REASONS.GPU_ONLY);
            continue;
        }
        if (service.pending.length >= cap) {
            failRequest(req, FAIL_REASONS.QUEUE_FULL);
            continue;
        }
        service.pending.push({ req, enqueuedAt: STATE.elapsedGameTime });
    }

    const fleet = service.connections
        .map((id) => STATE.services.find((s) => s.id === id))
        .filter((s) => s && s.type === "gpu");

    // 1) WARMUP GRACE: while EVERY connected GPU is loading its model, the
    //    deadline clock waits — an entry cannot be "stale" relative to a
    //    fleet that cannot serve anyone yet, and holding through the warmup
    //    is the reputation this node is sold on. Implemented by sliding the
    //    stamps with game time, so a pause (dt 0) changes nothing and the
    //    clock resumes the instant one model comes live. No connected GPUs
    //    at all is NOT a grace: with nothing to ever serve, the deadline is
    //    the only honest exit (the no-GPU ignore-runs depend on it).
    if (dt > 0 && fleet.length > 0 && fleet.every((g) => g.modelLoading)) {
        for (const entry of service.pending) entry.enqueuedAt += dt;
    }

    // 2) SWEEP before dispatch: expire first, so an entry that outlived its
    //    deadline is provably never sent to a GPU.
    const deadline = service.config.deadlineSec;
    for (let i = service.pending.length - 1; i >= 0; i--) {
        const entry = service.pending[i];
        if (STATE.elapsedGameTime - entry.enqueuedAt > deadline) {
            service.pending.splice(i, 1); // out BEFORE the fail-fade starts
            STATE.inference.expired++;
            service.expiredCount++;
            failRequest(entry.req, FAIL_REASONS.SLO_TIMEOUT);
        }
    }

    // 3) Dispatch heads to the least-loaded routable GPU with room. A warming
    //    (modelLoading) GPU is not routable, a full one cannot accept — either
    //    way entries simply stay and keep aging toward their deadline.
    const gpus = fleet.filter((s) => isRoutable(s));
    while (service.pending.length > 0) {
        let target = null;
        for (const gpu of gpus) {
            if (!canAccept(gpu)) continue;
            if (!target || gpuLoad(gpu) < gpuLoad(target)) target = gpu;
        }
        if (!target) break;
        const entry = service.pending.shift();
        entry.req.flyTo(target);
    }
}
