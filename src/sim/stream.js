// Stream mechanic (#198, Sandbox archetypes batch 2). The Stream is the ONLY
// node that models HEAD-OF-LINE BLOCKING — the ordering-vs-throughput lesson.
//
// Records arriving in the node's queue are split, in arrival order, across
// `partitions` independent partitions (round-robin at ingress). Each partition
// is a strict FIFO: only its HEAD is ever worked, and the head forwards to the
// partition's OWN downstream consumer (partition i → the i-th routable
// downstream, wrapping if there are fewer downstreams than partitions — the
// "each partition has its own consumer" model). If that consumer is saturated,
// the whole partition WAITS behind its head — it never skips ahead — while the
// other partitions, with other consumers, keep flowing. That is the whole
// point: one slow partition stalls its own tail but not its neighbours.
//
// It sits OUTSIDE the normal job-dispatch pipeline (like the DLQ drain and the
// Scheduler source): Service.update() ticks tickStream() and skips processQueue
// for a stream, so nothing lands in this.processing and there is no handler
// registry entry for "stream".
//
// Termination invariant (#191/#192): every record terminates exactly once.
//   - a head with a routable-but-saturated consumer WAITS (it will forward once
//     traffic stops and the consumer frees — so a "permanently blocked"
//     partition drains as soon as its downstream frees);
//   - a head with NO routable consumer at all is failed (or parked in a wired
//     DLQ) via failOrPark — never left hanging;
//   - forwarded records terminate on their consumer's usual path.
// Deleting a stream node re-homes its partition records (topology.deleteObject
// adds service.partitions to the orphan set), so nothing is stranded there.

import { STATE } from "../state.js";
import { failOrPark } from "../core/actions.js";
import { FAIL_REASONS } from "../core/failure-reasons.js";
import { isRoutable } from "./circuit-breaker.js";

// Lazily seed the partition buckets + per-partition timers on first tick.
function ensurePartitions(service) {
    const n = Math.max(1, service.config.partitions || 1);
    if (!service.partitions || service.partitions.length !== n) {
        service.partitions = Array.from({ length: n }, () => []);
        service.partitionTimers = new Array(n).fill(0);
        service.ingressRR = service.ingressRR || 0;
    }
}

// Routable downstream consumers, in a stable order (connection order).
function consumers(service) {
    return service.connections
        .map((id) => STATE.services.find((s) => s.id === id))
        .filter((s) => s && isRoutable(s));
}

// Can this consumer accept one more record right now? Mirrors the queue-
// overflow gate in Request.update (queue + in-flight below the node's cap).
function canAccept(target) {
    const maxQueue = target.config.maxQueueSize || 20;
    return target.queue.length + (target.incomingCount || 0) < maxQueue;
}

// Ticked once per frame from Service.update() with the game-scaled dt — freezes
// with the game at timeScale 0 exactly like every other timer in the sim.
export function tickStream(service, dt) {
    ensurePartitions(service);

    // 1) Ingest: drain the arrival queue into partitions, round-robin, so the
    //    relative order of records within a partition is their arrival order.
    while (service.queue.length > 0) {
        const req = service.queue.shift();
        const p = service.ingressRR % service.partitions.length;
        service.ingressRR++;
        service.partitions[p].push(req);
    }

    // 2) Advance each partition independently. Only the HEAD is worked; a
    //    blocked head holds the whole partition (head-of-line blocking).
    const cons = consumers(service);
    for (let p = 0; p < service.partitions.length; p++) {
        const part = service.partitions[p];
        if (part.length === 0) {
            service.partitionTimers[p] = 0;
            continue;
        }

        service.partitionTimers[p] += dt * 1000;
        if (service.partitionTimers[p] < service.config.processingTime) continue;

        const head = part[0];

        if (cons.length === 0) {
            // No consumer at all — fail the head (a wired DLQ may catch it) so
            // it cannot leak. The tail advances to the next head next frame.
            part.shift();
            service.partitionTimers[p] = 0;
            // "Partition stalled" (#156) rather than "no route": what the
            // player has to learn here is that the whole partition was WAITING
            // on this one head — everything behind it was blocked by it, and
            // the neighbouring partitions kept flowing. That is head-of-line
            // blocking, and it is the reason this node exists.
            failOrPark(head, service, FAIL_REASONS.PARTITION_STALLED);
            continue;
        }

        // Each partition has its OWN consumer (wrapping if fewer consumers than
        // partitions). This is what lets one partition block while others flow.
        const target = cons[p % cons.length];
        if (canAccept(target)) {
            part.shift();
            service.partitionTimers[p] = 0;
            head.flyTo(target);
        }
        // else: consumer saturated — hold the head, WAIT (do not skip ahead).
        // The timer stays satisfied, so the head retries every frame until the
        // consumer frees; the records behind it are stuck by design.
    }
}
