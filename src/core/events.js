// Random-events system (#155 PR 4): survival malicious spikes, traffic
// shifts, random economy/capacity/outage events, and their warning +
// event-bar UI. Code moved verbatim from game.js.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
// Cyclic import (events.js <-> game.js) is safe: formatTime is a hoisted
// function declaration in game.js, only called at runtime.
import { formatTime } from "../../game.js";

function updateMaliciousSpike(dt) {
    if (STATE.gameMode === "campaign") {
        if (!STATE.campaign?.level?.enableSurvivalShifts) return;
    } else if (STATE.gameMode !== "survival") {
        return;
    }
    if (!CONFIG.survival.maliciousSpike.enabled) return;

    STATE.maliciousSpikeTimer += dt;

    const interval = CONFIG.survival.maliciousSpike.interval;
    const duration = CONFIG.survival.maliciousSpike.duration;
    const warning = CONFIG.survival.maliciousSpike.warningTime;

    const cycleTime = STATE.maliciousSpikeTimer % interval;

    if (
        cycleTime >= interval - warning &&
        cycleTime < interval - warning + dt &&
        !STATE.maliciousSpikeActive
    ) {
        showMaliciousWarning();
    }

    if (cycleTime < dt && STATE.maliciousSpikeTimer > warning) {
        startMaliciousSpike();
    }

    if (
        STATE.maliciousSpikeActive &&
        cycleTime >= duration &&
        cycleTime < duration + dt
    ) {
        endMaliciousSpike();
    }
}

function showMaliciousWarning() {
    const existing = document.getElementById("malicious-warning");
    if (existing) existing.remove();

    const warning = document.createElement("div");
    warning.id = "malicious-warning";
    warning.className =
        "fixed top-1/3 left-1/2 transform -translate-x-1/2 text-center z-50 pointer-events-none";
    warning.innerHTML = `
        <div class="text-red-500 text-2xl font-bold animate-pulse">${i18n.t('ddos_incoming')}</div>
        <div class="text-red-300 text-sm">${i18n.t('attack_spike')}</div>
    `;
    document.body.appendChild(warning);

    STATE.sound.playTone(400, "sawtooth", 0.3);
    STATE.sound.playTone(300, "sawtooth", 0.3, 0.15);

    setTimeout(() => warning.remove(), 4000);
}

function startMaliciousSpike() {
    const existing = document.getElementById("malicious-spike-indicator");
    if (existing) existing.remove();

    if (STATE.intervention && STATE.intervention.trafficShiftActive) return;

    STATE.maliciousSpikeActive = true;

    STATE.normalTrafficDist = { ...STATE.trafficDistribution };

    const maliciousPct = CONFIG.survival.maliciousSpike.maliciousPercent;
    const remaining = 1 - maliciousPct;

    // Guard against a distribution that's already 100% malicious — otherwise
    // every non-malicious share divides by zero and becomes NaN/Infinity,
    // corrupting the mix for the spike's duration. Not reachable with shipped
    // configs today, but cheap insurance for future levels/shifts.
    const otherTotal = 1 - STATE.normalTrafficDist.MALICIOUS;
    if (otherTotal <= 0) {
        STATE.trafficDistribution = { ...STATE.normalTrafficDist };
    } else {
        STATE.trafficDistribution = {
            STATIC: (STATE.normalTrafficDist.STATIC / otherTotal) * remaining,
            READ: (STATE.normalTrafficDist.READ / otherTotal) * remaining,
            WRITE: (STATE.normalTrafficDist.WRITE / otherTotal) * remaining,
            UPLOAD: (STATE.normalTrafficDist.UPLOAD / otherTotal) * remaining,
            SEARCH: (STATE.normalTrafficDist.SEARCH / otherTotal) * remaining,
            MALICIOUS: maliciousPct,
        };
    }

    const indicator = document.createElement("div");
    indicator.id = "malicious-spike-indicator";
    indicator.className =
        "fixed top-4 left-1/2 transform -translate-x-1/2 z-40 pointer-events-none";
    indicator.innerHTML = `
        <div class="bg-red-900/80 border-2 border-red-500 rounded-lg px-4 py-2 animate-pulse">
            <span class="text-red-400 font-bold">${i18n.t('ddos_active')}</span>
        </div>
    `;
    document.body.appendChild(indicator);

    const maliciousEl = document.getElementById("mix-malicious");
    if (maliciousEl)
        maliciousEl.className = "text-red-500 font-bold animate-pulse";
}

function endMaliciousSpike() {
    STATE.maliciousSpikeActive = false;

    // Restore normal distribution
    if (STATE.normalTrafficDist) {
        STATE.trafficDistribution = { ...STATE.normalTrafficDist };
        STATE.normalTrafficDist = null;
    }

    // Remove indicator
    const indicator = document.getElementById("malicious-spike-indicator");
    if (indicator) indicator.remove();

    // Reset mix display styling
    const maliciousEl = document.getElementById("mix-malicious");
    if (maliciousEl) maliciousEl.className = "text-red-400";

    STATE.sound.playSuccess();
}

// ==================== INTERVENTION MECHANICS ====================

function addInterventionWarning(message, type = "warning", duration = 4000) {
    const warningsContainer = document.getElementById("intervention-warnings");
    if (!warningsContainer) return;

    const warning = document.createElement("div");
    const typeStyles = {
        warning: "warning-warning",
        danger: "warning-danger",
        info: "warning-info",
    };

    warning.className = `intervention-warning ${typeStyles[type] || typeStyles.warning
        } border-2 rounded-lg px-6 py-3 mb-2 shadow-lg`;
    warning.innerHTML = `
        <div class="flex items-center gap-3">
            <span class="text-2xl">${type === "danger" ? "⚠️" : type === "info" ? "✅" : "📢"
        }</span>
            <span class="font-bold text-lg">${message}</span>
        </div>
    `;
    warningsContainer.appendChild(warning);

    // Play warning sound
    if (type === "danger") {
        STATE.sound?.playTone(200, "sawtooth", 0.4);
        STATE.sound?.playTone(150, "sawtooth", 0.4, 0.1);
    } else if (type === "warning") {
        STATE.sound?.playTone(400, "sine", 0.2);
    }

    // Add to state for tracking
    if (STATE.intervention) {
        STATE.intervention.warnings.push({ message, type, time: Date.now() });
    }

    // Animate out before removing
    setTimeout(() => {
        warning.style.transition = "all 0.3s ease-out";
        warning.style.opacity = "0";
        warning.style.transform = "translateY(-20px)";
        setTimeout(() => warning.remove(), 300);
    }, duration - 300);
}

function updateTrafficShift(dt) {
    if (STATE.gameMode === "campaign") {
        if (!STATE.campaign?.level?.enableSurvivalShifts) return;
    } else if (STATE.gameMode !== "survival") {
        return;
    }
    if (!CONFIG.survival.trafficShift?.enabled) return;
    if (!STATE.intervention) return;

    STATE.intervention.trafficShiftTimer += dt;

    const config = CONFIG.survival.trafficShift;
    const interval = config.interval;
    const duration = config.duration;

    // Check if shift should start
    if (
        !STATE.intervention.trafficShiftActive &&
        STATE.intervention.trafficShiftTimer >= interval
    ) {
        startTrafficShift();
    }

    // Check if shift should end. The timer is reset to 0 when a shift actually
    // activates (see startTrafficShift), so here it measures time-since-active.
    // Previously this used the absolute `interval + duration` threshold, which
    // meant a shift that was delayed (blocked while a malicious spike was active)
    // could end on its very first active frame — running for ~0 seconds.
    if (
        STATE.intervention.trafficShiftActive &&
        STATE.intervention.trafficShiftTimer >= duration
    ) {
        endTrafficShift();
        STATE.intervention.trafficShiftTimer = 0; // Reset for next cycle
    }
}

function startTrafficShift() {
    if (!STATE.intervention || STATE.maliciousSpikeActive) return;

    const config = CONFIG.survival.trafficShift;
    const shifts = config.shifts;

    // Pick a random shift
    const shift = shifts[Math.floor(Math.random() * shifts.length)];
    STATE.intervention.currentShift = shift;
    STATE.intervention.trafficShiftActive = true;
    // Reset so the end check measures duration from actual activation, not from
    // when the timer first crossed `interval` (it may have kept growing while a
    // malicious spike blocked the start).
    STATE.intervention.trafficShiftTimer = 0;

    // Store original distribution
    STATE.intervention.originalTrafficDist = { ...STATE.trafficDistribution };

    if (shift.distribution) {
        STATE.trafficDistribution = { ...shift.distribution };
    }

    // Shift configs carry only { name, distribution } — there is no `type`
    // field, and most shift names have no `shift_<name>` i18n key. Referencing
    // shift.type threw on every shift start (crashing the frame and suppressing
    // this warning). Use the shift's display name directly.
    addInterventionWarning(
        i18n.t('traffic_surging', { name: shift.name }),
        "warning",
        5000
    );
    STATE.sound?.playTone(500, "sine", 0.2);
}

function endTrafficShift() {
    if (!STATE.intervention) return;

    STATE.intervention.trafficShiftActive = false;

    // Restore original distribution
    if (STATE.intervention.originalTrafficDist) {
        STATE.trafficDistribution = { ...STATE.intervention.originalTrafficDist };
        STATE.intervention.originalTrafficDist = null;
    }

    STATE.intervention.currentShift = null;
}

function updateRandomEvents(dt) {
    if (STATE.gameMode === "campaign") {
        if (!STATE.campaign?.level?.enableSurvivalShifts) return;
    } else if (STATE.gameMode !== "survival") {
        return;
    }
    if (!CONFIG.survival.randomEvents?.enabled) return;
    if (!STATE.intervention) return;

    STATE.intervention.randomEventTimer += dt;

    const config = CONFIG.survival.randomEvents;

    // Check if event should trigger
    if (STATE.intervention.randomEventTimer >= config.checkInterval) {
        STATE.intervention.randomEventTimer = 0;

        // 30% chance to trigger an event
        if (Math.random() < 0.3) {
            triggerRandomEvent();
        }
    }

    // Check if active event should end
    if (
        STATE.intervention.activeEvent &&
        Date.now() >= STATE.intervention.eventEndTime
    ) {
        endRandomEvent();
    }
}

function triggerRandomEvent(
    eventType = null,
    duration = null,
    outageServiceId = null
) {
    if (!STATE.intervention || STATE.intervention.activeEvent) return;

    const config = CONFIG.survival.randomEvents;
    if (!eventType)
        eventType = config.types[Math.floor(Math.random() * config.types.length)];
    if (!duration) duration = 30000; // 30 seconds

    STATE.intervention.activeEvent = eventType;
    STATE.intervention.eventEndTime = Date.now() + duration;
    STATE.intervention.eventDuration = duration;

    switch (eventType) {
        case "COST_SPIKE":
            addInterventionWarning(
                i18n.t('cost_spike_warning'),
                "danger",
                8000
            );
            STATE.intervention.costMultiplier = 2.0;
            break;

        case "CAPACITY_DROP":
            addInterventionWarning(
                i18n.t('capacity_drop_warning'),
                "danger",
                8000
            );
            STATE.services.forEach((s) => {
                s.tempCapacityReduction = 0.5; // 50% capacity
            });
            break;

        case "TRAFFIC_BURST":
            addInterventionWarning(
                i18n.t('traffic_burst_warning'),
                "warning",
                8000
            );
            STATE.intervention.trafficBurstMultiplier = 3.0;
            break;

        case "SERVICE_OUTAGE": {
            // Reuse the previously-chosen service when resuming a paused outage
            // (STATE.intervention.outageServiceId set), otherwise pick a fresh
            // random one. Without this, pause→resume re-rolled the target and
            // the outage could "teleport" to a different service.
            let target = outageServiceId
                ? STATE.services.find((s) => s.id === outageServiceId)
                : null;
            if (!target) {
                const services = STATE.services.filter((s) => s.type !== "waf");
                target = services.length > 0
                    ? services[Math.floor(Math.random() * services.length)]
                    : null;
            }
            if (target) {
                STATE.intervention.outageServiceId = target.id;
                target.isDisabled = true;
                target.mesh.material.opacity = 0.3;
                target.mesh.material.transparent = true;
                addInterventionWarning(
                    i18n.t('service_outage_warning', { type: i18n.t(target.type) }),
                    "danger",
                    8000
                );
            }
            break;
        }
    }

    // Show active event bar
    showActiveEventBar(eventType);

    STATE.sound?.playTone(300, "sawtooth", 0.3);
}

function endRandomEvent() {
    if (!STATE.intervention || !STATE.intervention.activeEvent) return;

    const eventType = STATE.intervention.activeEvent;

    switch (eventType) {
        case "COST_SPIKE":
            STATE.intervention.costMultiplier = 1.0;
            break;

        case "CAPACITY_DROP":
            STATE.services.forEach((s) => {
                s.tempCapacityReduction = 1.0;
            });
            break;

        case "TRAFFIC_BURST":
            STATE.intervention.trafficBurstMultiplier = 1.0;
            break;

        case "SERVICE_OUTAGE":
            STATE.services.forEach((s) => {
                if (s.isDisabled) {
                    s.isDisabled = false;
                    s.mesh.material.opacity = 1.0;
                    s.mesh.material.transparent = false;
                }
            });
            // Clear the remembered target. On a pause, handleGameState has
            // already captured it into pausedOutageServiceId before calling this,
            // so clearing here only affects a genuine end — the next fresh outage
            // will pick a new service.
            STATE.intervention.outageServiceId = null;
            break;
    }

    // Hide active event bar
    hideActiveEventBar();

    STATE.intervention.activeEvent = null;
    addInterventionWarning(i18n.t('event_ended'), "info", 2000);
    STATE.sound?.playSuccess();
}

function showActiveEventBar(eventType) {
    const bar = document.getElementById("active-event-bar");
    const icon = document.getElementById("active-event-icon");
    const text = document.getElementById("active-event-text");

    if (!bar) return;

    const eventConfig = {
        COST_SPIKE: { icon: "💰", text: i18n.t('cost_spike_active'), color: "bg-red-600" },
        CAPACITY_DROP: {
            icon: "⚡",
            text: i18n.t('capacity_reduced'),
            color: "bg-orange-600",
        },
        TRAFFIC_BURST: {
            icon: "🚀",
            text: i18n.t('traffic_burst'),
            color: "bg-yellow-600",
        },
        SERVICE_OUTAGE: {
            icon: "🔧",
            text: i18n.t('service_outage_active'),
            color: "bg-purple-600",
        },
    };

    const config = eventConfig[eventType] || eventConfig["COST_SPIKE"];

    bar.className = `fixed top-0 left-0 right-0 h-8 z-40 ${config.color}`;
    icon.textContent = config.icon;
    text.textContent = config.text;
    bar.classList.remove("hidden");
}

function hideActiveEventBar() {
    const bar = document.getElementById("active-event-bar");
    if (bar) bar.classList.add("hidden");
}

function updateActiveEventTimer() {
    if (!STATE.intervention?.activeEvent) return;

    const timerEl = document.getElementById("active-event-timer");
    const progressEl = document.getElementById("active-event-progress");

    const remaining = Math.max(0, STATE.intervention.eventEndTime - Date.now());
    const remainingSec = Math.ceil(remaining / 1000);

    if (timerEl) {
        timerEl.textContent = formatTime(remainingSec);
    }

    if (progressEl && STATE.intervention.eventDuration) {
        const progress = (remaining / STATE.intervention.eventDuration) * 100;
        progressEl.style.width = `${Math.max(0, progress)}%`;
    }
}

export {
    addInterventionWarning,
    endRandomEvent,
    triggerRandomEvent,
    updateActiveEventTimer,
    updateMaliciousSpike,
    updateRandomEvents,
    updateTrafficShift,
};
