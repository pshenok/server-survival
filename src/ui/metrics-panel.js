// METRICS dashboard panel (#194): the collapsible right-column panel between
// SERVICE HEALTH and FINANCES. Locked until a Monitoring service is placed;
// unlocked it shows one row per service (the monitor itself is excluded — it
// never receives traffic, so its lines would be flat noise): a line with its
// name, tier and health over four mini sparklines drawn straight from the ring
// buffers in core/metrics.js.
//
// Wiring: game.js calls renderMetricsPanel() every animate() frame right
// after metricsTick(). The call is cheap by construction — the lock state and
// row structure are only touched when they actually change (so placing a
// monitor while PAUSED unlocks the panel immediately), and the canvases are
// redrawn only when a new sample landed (2 Hz). While paused or at game-over
// nothing samples, so the panel keeps showing the frozen failure moment.

import { STATE } from "../state.js";
import { CONFIG } from "../config.js";
import { i18n } from "../i18n.js";
import {
    METRICS_BUFFER_SIZE,
    getSampleCount,
    getServiceMetrics,
    hasMonitoring,
} from "../core/metrics.js";
import { instanceCount } from "../sim/autoscaling.js";

// Four of these and their 4px gaps fill the panel's 254px of inner width.
const SPARK_W = 60;
const SPARK_H = 16;

const LINE_COLOR = "#2dd4bf"; // teal-400
const ALERT_COLOR = "#f87171"; // red-400
const ALERT_TINT = "rgba(248, 113, 113, 0.15)";

// One column per metric: buffer key, header i18n key, y-scale, and the
// "latest value crossed the alert threshold" predicate for the red tint
// (thresholds mirror the alert rules in core/metrics.js).
const COLUMNS = [
    {
        key: "util",
        label: "metrics_col_util",
        max: () => 1,
        // Same constant the alert rule uses (#74) — the red tint in the panel
        // and the warning banner must never disagree about what "hot" means.
        alert: (v) => v > CONFIG.load.alertUtil,
    },
    {
        key: "queueDepth",
        label: "metrics_col_queue",
        max: (s) => s.config.maxQueueSize || 20,
        alert: (v, s) => v >= 0.9 * (s.config.maxQueueSize || 20),
    },
    {
        key: "errorRate",
        label: "metrics_col_err",
        max: () => 1,
        alert: (v) => v > 0.2,
    },
    {
        key: "latency",
        label: "metrics_col_lat",
        max: null, // dynamic: scaled to the buffer's own max
        alert: () => false,
    },
];

let lastSignature = null;
let lastDrawnSample = -1;
// "serviceId:columnKey" -> canvas element of the current row set.
const canvases = new Map();
// serviceId -> { el, shown } for the health figure of the current row set.
const healthFigures = new Map();

function healthColor(health) {
    return health < 40 ? "text-red-400" : health < 70 ? "text-yellow-400" : "text-green-400";
}

function renderMetricsPanel() {
    const lockedEl = document.getElementById("metrics-locked");
    const rowsEl = document.getElementById("metrics-rows");
    if (!lockedEl || !rowsEl) return;

    const unlocked = hasMonitoring();
    lockedEl.classList.toggle("hidden", unlocked);
    rowsEl.classList.toggle("hidden", !unlocked);
    if (!unlocked) {
        lastSignature = null; // force a row rebuild on re-unlock
        return;
    }

    const services = STATE.services.filter((s) => s.type !== "monitor");

    // Rebuild rows only when the service set changes (low DOM churn). The ASG
    // fleet size (#195) is part of the signature so the "×n" badge follows a
    // scaling event — those are rare (cooldown-gated), so this stays cheap.
    // The breaker state joins the signature too (#196): a trip has to repaint
    // the badge immediately, and trips are rare enough to keep this cheap.
    // So do the tier, which an upgrade changes while paused, and the language.
    const signature = i18n.currentLocale + ":" + services
        .map((s) => (s.asgEnabled ? `${s.id}*${instanceCount(s)}` : s.id) + "!" + s.breakerState + "T" + s.tier)
        .join(",");
    if (signature !== lastSignature) {
        buildRows(services, rowsEl);
        lastSignature = signature;
        lastDrawnSample = -1;
    }

    // Health moves on its own and a click repairs it while paused, so it is
    // checked every frame, and the DOM only touched when the figure changes.
    for (const s of services) {
        const figure = healthFigures.get(s.id);
        const shown = Math.round(s.health);
        if (figure && figure.shown !== shown) {
            figure.shown = shown;
            figure.el.textContent = `${shown}%`;
            figure.el.className = `flex-shrink-0 ${healthColor(shown)}`;
        }
    }

    // Redraw canvases only when a new sample landed (2 Hz).
    const sample = getSampleCount();
    if (sample !== lastDrawnSample) {
        drawSparklines(services);
        lastDrawnSample = sample;
    }
}

function buildRows(services, rowsEl) {
    rowsEl.innerHTML = "";
    canvases.clear();
    healthFigures.clear();

    const header = document.createElement("div");
    header.setAttribute("data-metrics-header", "");
    header.className = "flex gap-1 text-[9px] text-gray-500 uppercase";
    header.innerHTML = COLUMNS.map(
        (c) =>
            `<span class="text-center" style="width:${SPARK_W}px">${i18n.t(c.label)}</span>`
    ).join("");
    rowsEl.appendChild(header);

    for (const s of services) {
        const row = document.createElement("div");
        row.setAttribute("data-metrics-row", s.id);

        const info = document.createElement("div");
        info.className = "flex items-center gap-1 text-[10px] font-mono";

        const name = document.createElement("span");
        name.setAttribute("data-metrics-name", "");
        name.className = "min-w-0 truncate text-gray-300";
        name.textContent = i18n.t(s.type);
        name.title = i18n.t(s.type);
        info.appendChild(name);

        if (s.asgEnabled) {
            // ASG fleet badge (#195): the whole point of the epic's "scaling
            // is visible through metrics" goal — util drops as ×n climbs.
            const badge = document.createElement("span");
            badge.className = "flex-shrink-0 text-teal-400";
            badge.textContent = `×${instanceCount(s)}`;
            badge.title = i18n.t("asg_label");
            info.appendChild(badge);
        }
        // Circuit-breaker badge (#196): nothing while closed (the normal
        // state should be invisible), red OPEN while traffic is being skipped,
        // amber HALF while it is probing its way back.
        if (s.breakerState === "open" || s.breakerState === "half-open") {
            const open = s.breakerState === "open";
            const badge = document.createElement("span");
            badge.className = `flex-shrink-0 font-bold ${open ? "text-red-400" : "text-amber-400"}`;
            badge.textContent = open ? i18n.t("breaker_open") : i18n.t("breaker_half");
            badge.title = i18n.t("breaker_label");
            info.appendChild(badge);
        }

        const spacer = document.createElement("span");
        spacer.className = "flex-1";
        info.appendChild(spacer);

        // Only where tiers exist: on anything else "T1" would mean nothing.
        if (CONFIG.services[s.type]?.tiers) {
            const tier = document.createElement("span");
            tier.setAttribute("data-metrics-tier", "");
            tier.className = "flex-shrink-0 text-yellow-400";
            tier.textContent = `T${s.tier}`;
            info.appendChild(tier);
        }

        const shown = Math.round(s.health);
        const health = document.createElement("span");
        health.setAttribute("data-metrics-health", "");
        health.className = `flex-shrink-0 ${healthColor(shown)}`;
        health.textContent = `${shown}%`;
        info.appendChild(health);
        healthFigures.set(s.id, { el: health, shown });

        row.appendChild(info);

        const sparks = document.createElement("div");
        sparks.className = "flex gap-1";
        for (const col of COLUMNS) {
            const canvas = document.createElement("canvas");
            canvas.width = SPARK_W;
            canvas.height = SPARK_H;
            canvas.className = "bg-gray-800/60 rounded-sm";
            sparks.appendChild(canvas);
            canvases.set(s.id + ":" + col.key, canvas);
        }
        row.appendChild(sparks);

        rowsEl.appendChild(row);
    }
}

function drawSparklines(services) {
    for (const s of services) {
        const metrics = getServiceMetrics(s.id);
        for (const col of COLUMNS) {
            const canvas = canvases.get(s.id + ":" + col.key);
            if (!canvas || typeof canvas.getContext !== "function") continue;
            const ctx = canvas.getContext("2d");
            if (!ctx) continue; // happy-dom canvases have no 2D context

            ctx.clearRect(0, 0, SPARK_W, SPARK_H);
            const data = metrics ? metrics[col.key] : null;
            if (!data || data.length === 0) continue;

            const latest = data[data.length - 1];
            const alerted = col.alert(latest, s);
            let maxV;
            if (col.max) {
                maxV = col.max(s);
            } else {
                maxV = 1;
                for (const v of data) if (v > maxV) maxV = v;
                maxV *= 1.1;
            }

            if (alerted) {
                ctx.fillStyle = ALERT_TINT;
                ctx.fillRect(0, 0, SPARK_W, SPARK_H);
            }

            ctx.strokeStyle = alerted ? ALERT_COLOR : LINE_COLOR;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < data.length; i++) {
                const x = (i / (METRICS_BUFFER_SIZE - 1)) * (SPARK_W - 1);
                const norm = Math.max(0, Math.min(1, data[i] / maxV));
                const y = SPARK_H - 1 - norm * (SPARK_H - 2);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    }
}

export { renderMetricsPanel };
