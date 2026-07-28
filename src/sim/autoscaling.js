// Auto-Scaling Group engine (#195, Wave 1 of #193) — the flagship compute
// mechanic. A Compute node with ASG enabled grows a fleet of instances under
// sustained load and shrinks it when the load passes:
//
//   util > targetUtil          held for sustainSec, cooldown elapsed -> boot
//     OR queue pressure high    ONE instance. It warms for warmupSec and
//                              carries NO traffic until then (the cold-start
//                              lesson: you pay for it from boot, you get
//                              capacity only later).
//   util < scaleInUtil         held for sustainSec, cooldown elapsed ->
//     AND queue pressure low    retire one instance immediately (newest
//                              first).
//
// Queue pressure (#220) is the second scaling signal: a fleet that PULLS from
// an upstream Queue caps its own intake at current capacity, so a saturated
// consumer reads comfortable utilization forever while the queue behind it
// grows without bound. The engine therefore also watches the fill ratio of
// every connected upstream SQS (max across queues) and scales out when it
// stays past cfg.queuePressureThreshold — the sim's version of SQS
// ApproximateNumberOfMessages target tracking. Both signals feed the SAME
// asgAbove accumulator, sustain window and cooldown; scale-in additionally
// requires the pressure to have dropped below HALF the threshold, otherwise
// the fleet would flap (drain a little, util still 0, retire the instance it
// just booted).
//
// The gap between the two thresholds is the hysteresis that stops a fleet
// from flapping; cooldownSec caps how fast the fleet can change at all.
//
// State lives on the Service instance (initAutoscaling seeds it for every
// service, so capacity/upkeep math is uniform):
//   asgEnabled  bool     — ASG mode on (Compute only)
//   instances   int      — READY instances, >= 1; capacity multiplier
//   warming     array    — {remaining} countdowns in game seconds
//   asgAbove/asgBelow    — how long util has held past a threshold
//   asgCooldown          — seconds left before another scaling action
//   lastScaleAt          — STATE.elapsedGameTime of the last action
//   satellites  array    — the ring of satellite meshes (visual only)
//
// All timers accumulate the game-scaled dt that Service.update() receives
// (same semantics as core/metrics.js), so pause freezes the fleet and
// fast-forward scales it — no wall clock anywhere.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";

// Satellite ring geometry (visual only).
const SAT_RADIUS = 3.4;
const SAT_WIDTH = 0.9;
const SAT_HEIGHT = 1.4;
const SAT_WARMING_OPACITY = 0.35;

// ASG is the "scale out instead of scale up" counterpart to the tier upgrades.
// Compute runs it (Serverless already auto-scales by construction), and so does
// the Container Cluster (#198) — the same fleet mechanic, but with a longer
// node-pool warmup (see warmupFor / CONFIG.autoscaling.containerWarmupSec).
function canAutoscale(service) {
    return service.type === "compute" || service.type === "container";
}

// Cold-start duration for a booting instance. Container's node pool warms
// notably longer than an ASG Compute's VM, so its scale-out lag is the
// distinguishing pain (#198).
function warmupFor(service) {
    const cfg = CONFIG.autoscaling;
    return service.type === "container"
        ? (cfg.containerWarmupSec ?? cfg.warmupSec)
        : cfg.warmupSec;
}

// Queue-depth signal (#220). Fill ratio of the fullest upstream SQS this
// fleet pulls from — discovery mirrors the compute pull loop in
// Service.update() (type + connection into this node), so the fleet scales
// on precisely the queues it is wired to drain. A queue's backlog lives in
// BOTH arrays: `processing` holds the jobs parked by the "requeue-next"
// wait-for-pull outcome, `queue` the overflow behind them.
//
// Deliberately NOT the pull loop's full isRoutable() gate: a drowning SQS
// trips its own breaker (its parked jobs re-roll load failures and a
// pull-drained queue never records a success), so requiring routability
// would blind the signal in exactly the backlog it exists to detect. Real
// queue metrics work the same way — ApproximateNumberOfMessages reports the
// backlog no matter how sick the consumers are. Only a disabled queue
// (outage event) is skipped: its backlog is frozen and no fleet size can
// drain it. Returns 0 when the node has no upstream SQS — i.e. for every
// ALB-push fleet, which keeps this signal a strict no-op for them.
function upstreamQueuePressure(service) {
    let pressure = 0;
    for (const s of STATE.services) {
        if (s.type !== "sqs" || s.isDisabled) continue;
        if (!s.connections.includes(service.id)) continue;
        const fill =
            (s.queue.length + s.processing.length) / (s.config.maxQueueSize || 20);
        if (fill > pressure) pressure = fill;
    }
    return pressure;
}

// Seeded from the Service constructor for EVERY type. Non-compute services
// keep asgEnabled false and instances 1 forever, which makes the instance
// multiplier in getEffectiveCapacity/totalLoad a no-op for them.
function initAutoscaling(service) {
    service.asgEnabled = false;
    service.instances = 1;
    service.warming = [];
    service.asgAbove = 0;
    service.asgBelow = 0;
    service.asgCooldown = 0;
    service.lastScaleAt = 0;
    service.satellites = [];
}

// Ready + warming. Capacity counts only `instances`; upkeep counts this —
// real clouds bill an instance from boot, not from readiness.
function instanceCount(service) {
    return (service.instances || 1) + (service.warming ? service.warming.length : 0);
}

function warmingCount(service) {
    return service.warming ? service.warming.length : 0;
}

// Toggle from the UI. Turning ASG OFF collapses the fleet back to a single
// instance immediately (any warming boot is cancelled) — the player gets an
// instant, legible result and stops paying for the fleet the same frame.
function toggleAutoscaling(service) {
    if (!canAutoscale(service)) return false;
    service.asgEnabled = !service.asgEnabled;
    if (!service.asgEnabled) {
        service.instances = 1;
        service.warming = [];
    }
    service.asgAbove = 0;
    service.asgBelow = 0;
    service.asgCooldown = 0;
    refreshSatellites(service);
    return service.asgEnabled;
}

// The single call site is Service.update(); the gate lives here so the
// caller stays one unconditional line.
function updateAutoscaling(service, dt) {
    if (!service.asgEnabled || !canAutoscale(service)) return;
    // Paused: freeze the fleet exactly like the metrics buffers do. dt is
    // already 0 at timeScale 0, but the explicit guard keeps a future
    // unscaled caller from warming instances while the game is stopped.
    if (STATE.timeScale === 0) return;

    const cfg = CONFIG.autoscaling;
    let changed = false;

    // Cold start: warming instances become ready (and only then count
    // toward capacity).
    for (let i = service.warming.length - 1; i >= 0; i--) {
        service.warming[i].remaining -= dt;
        if (service.warming[i].remaining <= 0) {
            service.warming.splice(i, 1);
            service.instances++;
            changed = true;
        }
    }

    service.asgCooldown = Math.max(0, service.asgCooldown - dt);

    // Utilization of the CURRENT ready fleet — totalLoad already divides by
    // the instance count, so a fleet at half load reads 0.5 no matter how
    // wide it is. That is what makes scale-in possible at all.
    const util = service.totalLoad;
    // Second signal (#220): a pull-based fleet never looks busy however deep
    // the upstream queue gets, so queue pressure feeds the SAME accumulator
    // as utilization — one state machine, two reasons to grow.
    const pressureThreshold = cfg.queuePressureThreshold ?? 0.5;
    const queuePressure = upstreamQueuePressure(service);
    if (util > cfg.targetUtil || queuePressure > pressureThreshold) {
        service.asgAbove += dt;
        service.asgBelow = 0;
    } else if (util < cfg.scaleInUtil && queuePressure < pressureThreshold / 2) {
        // Scale-in demands BOTH quiet: half the threshold is the queue-side
        // hysteresis gap — without it the fleet scales out on pressure,
        // drains a little, still reads util 0 and immediately retires the
        // instance it just booted.
        service.asgBelow += dt;
        service.asgAbove = 0;
    } else {
        // Inside the hysteresis band — neither streak survives.
        service.asgAbove = 0;
        service.asgBelow = 0;
    }

    if (service.asgCooldown <= 0) {
        const total = instanceCount(service);
        if (service.asgAbove >= cfg.sustainSec && total < cfg.maxInstances) {
            service.warming.push({ remaining: warmupFor(service) });
            service.asgAbove = 0;
            service.asgCooldown = cfg.cooldownSec;
            service.lastScaleAt = STATE.elapsedGameTime || 0;
            changed = true;
        } else if (service.asgBelow >= cfg.sustainSec && total > cfg.minInstances) {
            // Newest first: cancel a boot in progress before retiring a
            // healthy ready instance (and never drop below minInstances).
            if (service.warming.length > 0) service.warming.pop();
            else service.instances--;
            service.asgBelow = 0;
            service.asgCooldown = cfg.cooldownSec;
            service.lastScaleAt = STATE.elapsedGameTime || 0;
            changed = true;
        }
    }

    if (changed) refreshSatellites(service);
}

// Upkeep multiplier for the fleet: instance #1 at base price, every further
// instance (ready OR warming) at instanceUpkeepFactor of it.
function upkeepInstanceFactor(service) {
    const extra = instanceCount(service) - 1;
    if (extra <= 0) return 1;
    return 1 + extra * (CONFIG.autoscaling.instanceUpkeepFactor ?? 1);
}

// ---- Visuals: one satellite box per EXTRA instance, in a ring ----

function makeSatellite(service) {
    const geo = new THREE.BoxGeometry(SAT_WIDTH, SAT_HEIGHT, SAT_WIDTH);
    const mat = new THREE.MeshStandardMaterial({
        // Match the fleet to its parent so a Container's node pool reads as
        // Container-blue, not Compute-orange (#198).
        color: CONFIG.colors[service.type] ?? CONFIG.colors.compute,
        roughness: 0.2,
        transparent: true,
        opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    // Child of the parent mesh, so dragging the node carries the fleet and
    // the raycast walk-up in input/handlers.js still resolves to the parent.
    service.mesh.add(mesh);
    return mesh;
}

function disposeSatellite(service, mesh) {
    service.mesh.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
}

// Rebuild the ring to match (instances + warming - 1). Slots are fixed by
// maxInstances so existing boxes never shuffle when the fleet changes size;
// warming instances take the last slots and render semi-transparent.
function refreshSatellites(service) {
    if (!service.mesh) return;
    if (!service.satellites) service.satellites = [];

    const want = Math.max(0, instanceCount(service) - 1);
    while (service.satellites.length > want) {
        disposeSatellite(service, service.satellites.pop());
    }
    while (service.satellites.length < want) {
        service.satellites.push(makeSatellite(service));
    }

    const slots = Math.max(1, (CONFIG.autoscaling.maxInstances || 5) - 1);
    const readyExtra = Math.max(0, (service.instances || 1) - 1);
    for (let i = 0; i < service.satellites.length; i++) {
        const angle = (i / slots) * Math.PI * 2;
        const sat = service.satellites[i];
        sat.position.set(
            Math.cos(angle) * SAT_RADIUS,
            -service.mesh.position.y + SAT_HEIGHT / 2 + 0.05,
            Math.sin(angle) * SAT_RADIUS
        );
        const isWarming = i >= readyExtra;
        sat.material.opacity = isWarming ? SAT_WARMING_OPACITY : 1;
        sat.userData.warming = isWarming;
    }
}

function disposeSatellites(service) {
    if (!service.satellites) return;
    service.satellites.forEach((sat) => {
        service.mesh.remove(sat);
        sat.geometry.dispose();
        sat.material.dispose();
    });
    service.satellites = [];
}

export {
    canAutoscale,
    disposeSatellites,
    initAutoscaling,
    instanceCount,
    refreshSatellites,
    toggleAutoscaling,
    updateAutoscaling,
    upkeepInstanceFactor,
    upstreamQueuePressure,
    warmingCount,
};
