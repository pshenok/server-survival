// METRICS dashboard panel (#194): the collapsible right-column panel between
// SERVICE HEALTH and FINANCES. Locked until a Monitoring service is placed;
// unlocked it shows one row per service (the monitor itself is excluded — it
// never receives traffic, so its lines would be flat noise) with four mini
// sparklines drawn straight from the ring buffers in core/metrics.js.
//
// Wiring: game.js calls renderMetricsPanel() every animate() frame right
// after metricsTick(). The call is cheap by construction — the lock state and
// row structure are only touched when they actually change (so placing a
// monitor while PAUSED unlocks the panel immediately), and the canvases are
// redrawn only when a new sample landed (2 Hz). While paused or at game-over
// nothing samples, so the panel keeps showing the frozen failure moment.

import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import {
    METRICS_BUFFER_SIZE,
    getSampleCount,
    getServiceMetrics,
    hasMonitoring,
} from "../core/metrics.js";
import { instanceCount } from "../sim/autoscaling.js";

const SPARK_W = 46;
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
        alert: (v) => v > 0.85,
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
    const signature = services
        .map((s) => (s.asgEnabled ? `${s.id}*${instanceCount(s)}` : s.id))
        .join(",");
    if (signature !== lastSignature) {
        buildRows(services, rowsEl);
        lastSignature = signature;
        lastDrawnSample = -1;
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

    const header = document.createElement("div");
    header.className = "flex items-center gap-1 text-[9px] text-gray-500 uppercase";
    header.innerHTML =
        `<span class="w-12 flex-shrink-0"></span>` +
        COLUMNS.map(
            (c) =>
                `<span class="text-center" style="width:${SPARK_W}px">${i18n.t(c.label)}</span>`
        ).join("");
    rowsEl.appendChild(header);

    for (const s of services) {
        const row = document.createElement("div");
        row.className = "flex items-center gap-1";

        const name = document.createElement("span");
        name.className = "w-12 flex-shrink-0 text-[9px] font-mono text-gray-300 truncate";
        name.textContent = i18n.t(s.type).substring(0, 10).toUpperCase();
        name.title = i18n.t(s.type);
        if (s.asgEnabled) {
            // ASG fleet badge (#195): the whole point of the epic's "scaling
            // is visible through metrics" goal — util drops as ×n climbs.
            const n = instanceCount(s);
            name.textContent = name.textContent.substring(0, 7);
            const badge = document.createElement("span");
            badge.className = "text-teal-400";
            badge.textContent = `×${n}`;
            badge.title = i18n.t("asg_label");
            name.appendChild(badge);
        }
        row.appendChild(name);

        for (const col of COLUMNS) {
            const canvas = document.createElement("canvas");
            canvas.width = SPARK_W;
            canvas.height = SPARK_H;
            canvas.className = "bg-gray-800/60 rounded-sm";
            row.appendChild(canvas);
            canvases.set(s.id + ":" + col.key, canvas);
        }

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
