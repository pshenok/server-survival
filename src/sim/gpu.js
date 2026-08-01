// GPU Cluster mechanic (#87, The AI Wave). The GPU is the ONLY node that
// BATCHES: it accumulates INFERENCE requests into `service.batch` — up to
// `batchSize` or `batchWindowSec` of game time from the FIRST arrival — and
// then runs the whole batch as ONE job of
//
//   batchTimeMs = (batchBaseMs + batchPerItemMs · n) × meanGenLength(batch)
//
// so a full batch amortizes the base cost and a lonely request pays nearly
// full price. That utilization curve is the lesson, and the profit/min-at-
// fill harness in tests/sim/ai-wave.test.mjs is the authority on it.
//
// It sits OUTSIDE the normal job-dispatch pipeline (like stream/dlq/
// scheduler): Service.update() ticks tickGpu() and skips processQueue for a
// gpu, so nothing lands in this.processing and there is no handler registry
// entry for "gpu".
//
// MODEL COLD START: `service.modelLoading` is a DEDICATED flag — never
// isDisabled, because the event system re-enables disabled services and a
// pause would then cancel a model load. isRoutable() treats a loading GPU as
// unroutable (one line in circuit-breaker.js). Held-arrival rule: whatever is
// already in `gpu.queue` (including mid-air arrivals that land during the
// load) STAYS there, ages untouched, and batches normally when the load
// completes — the stall IS the lesson, and holding satisfies the termination
// invariant. Because the batch window counts from each head's true arrival,
// held requests have usually outlived it by then and fire their (partial)
// batch the moment the model is live — no second wait after the stall. A
// tier upgrade re-triggers the load at the new tier's duration; a mid-FILL
// batch keeps its members and its window progress frozen across the reload.
//
// QUALITY: tiers are model size — a bigger model batches more AND answers
// better (qualityRisk 10%/4%/1%). The roll runs in the completion loop only:
// finishRequest() as usual, then on a hit the QUALITY_RISK_REPUTATION
// constant (−0.5) is applied, service.badAnswers ticks up, and an amber
// "Bad answer" soft badge rises over the node via spawnServiceBadge — a
// SUCCESS-side event that never goes through failRequest, so the #156
// inertness contract stays intact.
//
// Termination invariant (#191/#192): a batch terminates with its batch (the
// completion loop) or its node (deleteObject folds `service.batch` into the
// orphan set; the region-outage teardown splices it — exactly as
// stream.partitions are handled in all three sites). Non-INFERENCE intake is
// failed on the spot (fail_gpu_only; MALICIOUS relabels to the breach it is),
// and the intake queue is BOUNDED at batchSize — overflow takes the existing
// QUEUE_FULL path in Request.update — so nothing can pile up invisibly.

import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
// Runtime-only cycle (Service.js -> gpu.js -> actions.js -> ... -> game.js):
// hoisted function declarations, only dereferenced at runtime — the
// established pattern.
import { failRequest, finishRequest } from "../core/actions.js";
import { FAIL_REASONS, SOFT_BADGES } from "../core/failure-reasons.js";
import { spawnServiceBadge } from "../ui/failure-badges.js";

// Seeded from the Service constructor. A fresh GPU cold-starts: the model
// load begins the moment it is placed — provisioning ahead of demand is the
// point of the mechanic.
export function initGpu(service) {
    service.batch = [];
    service.batchState = "filling"; // "filling" | "running"
    service.batchWindowTimer = 0;
    service.batchRunTimer = 0;
    service.batchRunTimeMs = 0;
    service.badAnswers = 0;
    service.modelLoading = false;
    service.modelLoadTimer = 0;
    startModelLoad(service);
}

// Begin (or re-begin, on tier upgrade / restore) a model load at the current
// config's loadTimeSec. While loading the node is not routable; its queue and
// any mid-fill batch freeze in place and resume when the load completes.
export function startModelLoad(service) {
    service.modelLoading = true;
    service.modelLoadTimer = 0;
}

// Ticked once per frame from Service.update() with the game-scaled dt — every
// timer here freezes with the game at timeScale 0 and dies with its node.
export function tickGpu(service, dt) {
    // Intake pass: GPUs serve inference only — reject wrong-type entries at
    // the queue, before they can ever join a batch (failRequest relabels a
    // MALICIOUS one to the breach it is, #156). Legit arrivals get their
    // ARRIVAL stamped: the batch window is measured from the first arrival's
    // landing, not from when a finished batch frees the drain — a request
    // that waited out a running batch (or a model load) has already served
    // its share of the window. Stamps are game time, so they freeze on
    // pause (#183). This pass runs even while the model loads.
    for (let i = service.queue.length - 1; i >= 0; i--) {
        const req = service.queue[i];
        if (req.type !== TRAFFIC_TYPES.INFERENCE) {
            service.queue.splice(i, 1);
            failRequest(req, FAIL_REASONS.GPU_ONLY);
        } else if (req.gpuArrivedAt === undefined) {
            req.gpuArrivedAt = STATE.elapsedGameTime;
        }
    }

    // Model (re)load: everything held — the queue ages untouched, a mid-fill
    // batch keeps its members, a mid-run batch keeps its progress — until the
    // load completes. The stall is the lesson.
    if (service.modelLoading) {
        service.modelLoadTimer += dt;
        if (service.modelLoadTimer < service.config.loadTimeSec) return;
        service.modelLoading = false;
    }

    const batchSize = service.config.batchSize;

    if (service.batchState === "filling") {
        // Accumulate: drain arrivals into the batch, up to batchSize. The
        // window is seeded with the head's ALREADY-ELAPSED age — "1.5s from
        // first arrival", literally — so a partial batch never pays a dead
        // window on top of the wait it already served behind the previous
        // run. (Reset it to 0 here instead and the live break-even climbs
        // from ~half fill to ~93% — the profit harness pins the difference.)
        while (service.queue.length > 0 && service.batch.length < batchSize) {
            const req = service.queue.shift();
            if (service.batch.length === 0) {
                service.batchWindowTimer =
                    STATE.elapsedGameTime - (req.gpuArrivedAt ?? STATE.elapsedGameTime);
            }
            service.batch.push(req);
        }

        if (service.batch.length > 0) {
            service.batchWindowTimer += dt;
            const windowSec =
                service.config.batchWindowSec || CONFIG.services.gpu.batchWindowSec;
            if (service.batch.length >= batchSize || service.batchWindowTimer >= windowSec) {
                // Launch: the whole batch becomes ONE job. A long generation
                // in the batch slows everyone — that is what genLength is for.
                const mean =
                    service.batch.reduce((sum, r) => sum + (r.genLength || 1), 0) /
                    service.batch.length;
                service.batchRunTimeMs =
                    (service.config.batchBaseMs + service.config.batchPerItemMs * service.batch.length) * mean;
                service.batchRunTimer = 0;
                service.batchState = "running";
            }
        }
    }

    if (service.batchState === "running") {
        service.batchRunTimer += dt * 1000;
        if (service.batchRunTimer >= service.batchRunTimeMs) {
            // Completion loop: every request terminates here, exactly once.
            const done = service.batch.splice(0);
            service.batchState = "filling";
            service.batchWindowTimer = 0;
            const risk = service.config.qualityRisk || 0;
            for (const req of done) {
                finishRequest(req, "gpu", service);
                if (Math.random() < risk) {
                    // A bad answer: completed and paid, but the user noticed.
                    // Success-side, so it must still be VISIBLE — the amber
                    // soft badge — without ever touching the fail path.
                    STATE.reputation +=
                        CONFIG.survival.SCORE_POINTS.QUALITY_RISK_REPUTATION;
                    service.badAnswers++;
                    spawnServiceBadge(service, SOFT_BADGES.BAD_ANSWER);
                }
            }
        }
    }
}
