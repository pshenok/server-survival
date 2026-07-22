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
import { i18n } from "../i18n.js";
// Cyclic import chain (metrics.js -> events.js -> game.js -> actions.js ->
// metrics.js) is safe — established pattern: addInterventionWarning is a
// hoisted function declaration, only dereferenced at runtime.
import { addInterventionWarning } from "./events.js";

const SAMPLE_INTERVAL = 0.5; // seconds of game time between samples (2 Hz)
export const METRICS_BUFFER_SIZE = 120; // 120 samples × 0.5 s = 60 s window

const ALERT_COOLDOWN = 15; // seconds of game time, per service+rule
const UTIL_THRESHOLD = 0.85;
const UTIL_SUSTAINED_SAMPLES = 6; // 3 s at 2 Hz
const QUEUE_THRESHOLD = 0.9; // fraction of maxQueueSize
const ERROR_RATE_THRESHOLD = 0.2;
const ERROR_MIN_EVENTS = 5; // rate alone is noise on 1-2 requests

let sampleAcc = 0;
let sampleCount = 0;

// serviceId -> {
//   util, queueDepth, errorRate, latency: ring buffers (newest last),
//   errors, successes, latencySum, latencyCount: counters reset per sample,
//   utilStreak: consecutive samples above UTIL_THRESHOLD (alert rule 1)
// }
const serviceMetrics = new Map();

// "serviceId:rule" -> game time (STATE.elapsedGameTime) of the last fire.
const alertCooldowns = new Map();

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

    // Lazily prune buffers for deleted services — cheaper and simpler than
    // subscribing to deleteObject, and at most one sample (0.5 s) stale.
    const live = new Set(STATE.services.map((s) => s.id));
    for (const id of serviceMetrics.keys()) {
        if (!live.has(id)) serviceMetrics.delete(id);
    }

    const monitored = hasMonitoring();

    for (const service of STATE.services) {
        const m = bufferFor(service.id);
        const util = service.totalLoad || 0;
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
    if (util > UTIL_THRESHOLD) m.utilStreak++;
    else m.utilStreak = 0;
    if (m.utilStreak >= UTIL_SUSTAINED_SAMPLES) {
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
    sampleAcc = 0;
    sampleCount = 0;
}

export {
    getSampleCount,
    getServiceMetrics,
    hasMonitoring,
    metricsTick,
    recordServiceError,
    recordServiceSuccess,
    resetMetrics,
};
