// Observability layer (#194, Wave 1 of #193): the metrics collection engine.
// Ring-buffered per-service samples (2 Hz over a 60 s window) for utilization,
// queue depth, windowed error rate and rolling latency, plus the
// hasMonitoring() gate and the threshold alerts. Error/latency attribution is
// fed from the request lifecycle in core/actions.js (failRequest /
// finishRequest). Alerts live here rather than in a separate core/alerts.js:
// they are evaluated inside the same per-sample loop over the same counters,
// and a split module would only add imports without adding clarity.
//
// game.js calls metricsTick(dt) once per animate() frame (game-scaled dt, so
// fast-forward samples faster in wall time but keeps the 60 s game-time
// window) and resetMetrics() from resetGame().

import { STATE } from "../state.js";
import { CONFIG } from "../config.js";
import { i18n } from "../i18n.js";
// Cyclic import chain (metrics.js -> events.js -> game.js -> actions.js ->
// metrics.js) is safe — established pattern: addInterventionWarning is a
// hoisted function declaration, only dereferenced at runtime.
import { addInterventionWarning } from "./events.js";

const SAMPLE_INTERVAL = 0.5; // seconds of game time between samples (2 Hz)
export const METRICS_BUFFER_SIZE = 120; // 120 samples × 0.5 s = 60 s window

const ALERT_COOLDOWN = 15; // seconds of game time, per service+rule
// Utilization thresholds live in CONFIG.load (#74) so the ring colours, the
// alert and the failure onset are calibrated against one another instead of
// drifting apart in three files. Both are read at call time, not captured
// here, so a config change cannot be shadowed by module-eval order.
const QUEUE_THRESHOLD = 0.9; // fraction of maxQueueSize
const ERROR_RATE_THRESHOLD = 0.2;
const ERROR_MIN_EVENTS = 5; // rate alone is noise on 1-2 requests

let sampleAcc = 0;
let sampleCount = 0;

// serviceId -> {
//   util, queueDepth, errorRate, latency: ring buffers (newest last),
//   errors, successes, latencySum, latencyCount: counters reset per sample,
//   utilStreak: consecutive samples above CONFIG.load.alertUtil (alert rule 1)
// }
const serviceMetrics = new Map();

// "serviceId:rule" -> game time (STATE.elapsedGameTime) of the last fire.
const alertCooldowns = new Map();

// Per-RUN peak watermark: serviceId -> { type, util, atSec } (#252).
//
// Deliberately a running watermark rather than a scan of the ring buffers: the
// buffers hold METRICS_BUFFER_SIZE x SAMPLE_INTERVAL = 60 seconds, and levels
// 21-25 run 90-300s, so a scan would silently forget an early spike and the
// report would confidently state the wrong peak. It is also O(1) per sample
// instead of O(services x 120).
const runPeaks = new Map();

// Rolling goodput (#261). The game's headline number is reputation: an
// unbounded integral clamped at 100, so it reads 100 for a board that is
// merely coasting and it cannot distinguish "healthy" from "recovering" —
// every run starts pinned at the ceiling. Goodput is a bounded RATIO over a
// short window: of everything the board was asked to do in the last 30
// seconds, what share was answered while someone still wanted it.
//
// It is the number an SRE would actually put on the wall, and #248 made it
// computable for the first time by giving late completions a distinct
// outcome. Buckets are per metrics SAMPLE (2 Hz), so the window is
// GOODPUT_WINDOW_SAMPLES x SAMPLE_INTERVAL of game time.
const GOODPUT_WINDOW_SAMPLES = 60; // 60 x 0.5s = 30s of game time
const goodputBuckets = [];
let pendingOnTime = 0;
let pendingLate = 0;
let pendingFailed = 0;

/**
 * Called from the request lifecycle — one call per terminated request.
 *
 * Three buckets, and the third one is wider than its name: it is "demand that
 * got no timely answer", not "a service errored". A dropped request, a 429
 * from a rate limiter and an event drained out of a dead-letter queue are
 * different events with different costs, and the player sees them differently
 * — but to goodput they are the same thing, a customer who did not get served.
 * Leaving any of them out of the denominator is what lets a board that sheds
 * nine tenths of its traffic report itself perfect.
 */
function recordOutcome(kind) {
    if (kind === "onTime") pendingOnTime++;
    else if (kind === "late") pendingLate++;
    else pendingFailed++;
}

/**
 * Share of recent demand that was answered in time, or null when the window
 * holds nothing at all — an idle board has no goodput, and printing 100%
 * for "nothing happened" is exactly the lie reputation already tells.
 */
function getRollingGoodput() {
    let onTime = 0;
    let total = 0;
    for (const b of goodputBuckets) {
        onTime += b.onTime;
        total += b.onTime + b.late + b.failed;
    }
    if (total === 0) return null;
    return onTime / total;
}

function bufferFor(id) {
    let m = serviceMetrics.get(id);
    if (!m) {
        m = {
            util: [],
            queueDepth: [],
            errorRate: [],
            latency: [],
            errors: 0,
            successes: 0,
            latencySum: 0,
            latencyCount: 0,
            utilStreak: 0,
        };
        serviceMetrics.set(id, m);
    }
    return m;
}

function pushSample(arr, value) {
    arr.push(value);
    if (arr.length > METRICS_BUFFER_SIZE) arr.shift();
}

// Attribution hooks — called from core/actions.js. `service` is any object
// with a service id (failRequest passes req.target, finishRequest the
// finishing service instance).
function recordServiceError(service) {
    if (!service || !service.id) return;
    bufferFor(service.id).errors++;
}

function recordServiceSuccess(service, latencyMs) {
    if (!service || !service.id) return;
    const m = bufferFor(service.id);
    m.successes++;
    if (typeof latencyMs === "number" && isFinite(latencyMs)) {
        m.latencySum += Math.max(0, latencyMs);
        m.latencyCount++;
    }
}

function hasMonitoring() {
    return STATE.services.some((s) => s.type === "monitor" && !s.isDisabled);
}

function metricsTick(dt) {
    // Paused: buffers must FREEZE so the game-over/pause inspection still
    // shows the failure moment (dt is already 0 at timeScale 0, but the
    // explicit guard also stops the accumulator from ever sampling).
    if (STATE.timeScale === 0) return;
    sampleAcc += dt;
    while (sampleAcc >= SAMPLE_INTERVAL) {
        sampleAcc -= SAMPLE_INTERVAL;
        takeSample();
    }
}

function takeSample() {
    sampleCount++;

    // Roll the goodput window one bucket forward (#261).
    goodputBuckets.push({ onTime: pendingOnTime, late: pendingLate, failed: pendingFailed });
    if (goodputBuckets.length > GOODPUT_WINDOW_SAMPLES) goodputBuckets.shift();
    pendingOnTime = 0;
    pendingLate = 0;
    pendingFailed = 0;

    // Lazily prune buffers for deleted services — cheaper and simpler than
    // subscribing to deleteObject, and at most one sample (0.5 s) stale.
    const live = new Set(STATE.services.map((s) => s.id));
    for (const id of serviceMetrics.keys()) {
        if (!live.has(id)) serviceMetrics.delete(id);
    }

    const monitored = hasMonitoring();

    for (const service of STATE.services) {
        const m = bufferFor(service.id);
        // Watermark first, so a node deleted later in the run still keeps the
        // peak it reached while it existed — the report is a post-mortem of
        // the RUN, not a snapshot of the surviving board.
        {
            const u = service.smoothedLoad || 0;
            const prev = runPeaks.get(service.id);
            if (!prev || u > prev.util) {
                runPeaks.set(service.id, {
                    type: service.type,
                    util: u,
                    atSec: STATE.elapsedGameTime,
                });
            }
        }
        // The SMOOTHED load (#74): the sampled series, the alert and the
        // panel's red tint all read the same axis the load rings do. Sampling
        // the instantaneous signal produced a sparkline of a quantity that on
        // a tier-1 Compute can only be 0.75, 1.00 or 1.25 — and an alert that
        // fired at 170% of rated capacity. Real observability shows a windowed
        // average for exactly this reason.
        const util = service.smoothedLoad || 0;
        const queueDepth = service.queue.length;
        const events = m.errors + m.successes;
        const errorRate = events > 0 ? m.errors / events : 0;
        // Rolling latency: average of completions since the last sample;
        // quiet samples carry the previous value forward so the sparkline
        // doesn't collapse to zero between requests.
        const latency =
            m.latencyCount > 0
                ? m.latencySum / m.latencyCount
                : m.latency.length > 0
                    ? m.latency[m.latency.length - 1]
                    : 0;

        pushSample(m.util, util);
        pushSample(m.queueDepth, queueDepth);
        pushSample(m.errorRate, errorRate);
        pushSample(m.latency, latency);

        if (monitored) {
            checkAlerts(service, m, util, queueDepth, errorRate, events);
        } else {
            m.utilStreak = 0;
        }

        m.errors = 0;
        m.successes = 0;
        m.latencySum = 0;
        m.latencyCount = 0;
    }
}

function checkAlerts(service, m, util, queueDepth, errorRate, events) {
    if (util > CONFIG.load.alertUtil) m.utilStreak++;
    else m.utilStreak = 0;
    if (m.utilStreak >= CONFIG.load.alertSustainSamples) {
        fireAlert(service, "util", "alert_high_load", "warning");
    }

    const maxQueue = service.config.maxQueueSize || 20;
    if (queueDepth >= QUEUE_THRESHOLD * maxQueue) {
        fireAlert(service, "queue", "alert_queue_capacity", "warning");
    }

    if (events >= ERROR_MIN_EVENTS && errorRate > ERROR_RATE_THRESHOLD) {
        fireAlert(service, "errors", "alert_error_rate", "danger");
    }
}

// Shared alert emitter. Also called from src/sim/circuit-breaker.js (#196) so
// breaker trips/recoveries reuse this cooldown map — note it is deliberately
// NOT gated on hasMonitoring(): only the threshold rules in checkAlerts() are
// an observability feature, a breaker trip is a routing event.
function fireAlert(service, rule, i18nKey, severity) {
    const key = service.id + ":" + rule;
    const now = STATE.elapsedGameTime || 0;
    const last = alertCooldowns.get(key);
    if (last !== undefined && now - last < ALERT_COOLDOWN) return;
    alertCooldowns.set(key, now);
    addInterventionWarning(
        i18n.t(i18nKey, { type: i18n.t(service.type) }),
        severity,
        5000
    );
}

// Panel accessors.
function getServiceMetrics(id) {
    return serviceMetrics.get(id);
}

// Monotonic sample counter — the METRICS panel redraws its canvases only
// when this changes (cheap per-frame polling instead of a callback registry).
function getSampleCount() {
    return sampleCount;
}

function resetMetrics() {
    serviceMetrics.clear();
    alertCooldowns.clear();
    runPeaks.clear();
    goodputBuckets.length = 0;
    pendingOnTime = 0;
    pendingLate = 0;
    pendingFailed = 0;
    sampleAcc = 0;
    sampleCount = 0;
}

/**
 * The post-run report (#252). Everything here is data the simulation already
 * collected and then threw away at the level boundary.
 *
 * Deliberately NOT gated on owning a Monitoring node: a post-mortem is not
 * live observability, and level 15's buy-the-eyes lesson depends on the LIVE
 * dashboard being purchasable, not on the player never learning what happened
 * afterwards. It is called from the debrief render path and nowhere else — a
 * mid-run caller would silently refund a purchase the game charges for, so
 * tests/sim/run-report.test.mjs asserts the live metrics panel never imports it.
 *
 * @returns {{peaks: Array, topReasons: Array, onTime: number, late: number,
 *            processed: number, failures: number}}
 */
function getRunReport({ topN = 3 } = {}) {
    const peaks = [...runPeaks.entries()]
        .map(([id, p]) => ({ id, type: p.type, util: p.util, atSec: p.atSec }))
        .sort((a, b) => b.util - a.util);

    const topReasons = Object.entries(STATE.failuresByReason || {})
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);

    const processed = STATE.requestsProcessed || 0;
    const late = STATE.lateCompletions || 0;
    const failures = Object.values(STATE.failures || {}).reduce(
        (a, n) => a + (typeof n === "number" ? n : 0),
        0
    );

    return {
        peaks,
        topReasons,
        processed,
        late,
        onTime: Math.max(0, processed - late),
        failures,
    };
}

export {
    fireAlert,
    getRollingGoodput,
    getRunReport,
    recordOutcome,
    getSampleCount,
    getServiceMetrics,
    hasMonitoring,
    metricsTick,
    recordServiceError,
    recordServiceSuccess,
    resetMetrics,
};
