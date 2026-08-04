// Random-events system (#155 PR 4): survival malicious spikes, traffic
// shifts, random economy/capacity/outage events, and their warning +
// event-bar UI. Code moved verbatim from game.js.

import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
// Cyclic import (events.js <-> game.js) is safe: formatTime is a hoisted
// function declaration in game.js, only called at runtime.
import { formatTime } from "../../game.js";
// Region outage (#221) terminates the requests caught inside the dying
// region. Runtime-only cycle (actions.js -> metrics.js -> events.js ->
// actions.js) — established pattern: hoisted function declarations, only
// dereferenced when an outage actually fires.
import { failRequest, removeRequest } from "./actions.js";
import { FAIL_REASONS } from "./failure-reasons.js";
// Achievements (#158): fortress is an EVENT def — start/end of a malicious
// spike each happen at exactly one code site (here), so the engine is told
// explicitly instead of edge-sampling STATE.maliciousSpikeActive (which
// cannot distinguish "spike ended" from "session reset/died"). Observation
// only; runtime-only cycle on the established pattern.
import { achievements } from "../achievements/achievements.js";

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

    // Arm fortress (#158) — deliberately AFTER the trafficShiftActive
    // early-return, so a suppressed spike never arms.
    achievements.onSpikeStart();

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
            // INFERENCE (#87) is one of the classic shares during a spike —
            // scaled down like the rest, restored with the rest.
            INFERENCE: ((STATE.normalTrafficDist.INFERENCE || 0) / otherTotal) * remaining,
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
    // fortress (#158): the only genuine end-of-spike site — resetGame merely
    // flips the flag and never reaches here, so a reset cannot fake a
    // survived spike (the armed flag it strands dies in onSessionStart).
    achievements.onSpikeEnd({ reputation: STATE.reputation });

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
    // AI hype gating (#87): a shift may declare requiresService, and it joins
    // the rotation only while such a service exists — evaluated HERE, at
    // shift-SELECTION time only, so losing the last GPU mid-shift does not
    // cancel a hype wave already running.
    const shifts = config.shifts.filter(
        (sh) =>
            !sh.requiresService ||
            STATE.services.some((s) => s.type === sh.requiresService)
    );
    if (shifts.length === 0) return;

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

// ==================== INFERENCE SURVIVAL STAGING (#87) ====================
//
// The AI wave arrives in stages, with no chicken-and-egg deadlock and no dead
// GPU: survival starts at a 0 base INFERENCE share; after 300s of game time
// the base moves to 3% — a legible slow bleed (−1 rep per unserved request)
// that arms the "AI demand is emerging" smart hint; and once the player owns
// ≥1 GPU it rebalances to 10%, taken proportionally from the other shares, so
// the GPU has steady food between hype waves.
//
// The rebalance targets the BASE distribution — whichever object an active
// malicious spike or traffic shift is going to restore — never a shift's own
// mix, so a staging step taken mid-shift survives the restore instead of
// being overwritten by it.

const INFERENCE_STAGE_AT_SEC = 300; // the 3% bleed begins here
const INFERENCE_BASE_SHARE = 0.03;
const INFERENCE_FED_SHARE = 0.1; // once a GPU exists

function updateInferenceStaging() {
    if (STATE.gameMode !== "survival") return;

    const hasGpu = STATE.services.some((s) => s.type === "gpu");
    const target = hasGpu
        ? INFERENCE_FED_SHARE
        : STATE.elapsedGameTime >= INFERENCE_STAGE_AT_SEC
            ? INFERENCE_BASE_SHARE
            : 0;

    const base =
        STATE.maliciousSpikeActive && STATE.normalTrafficDist
            ? STATE.normalTrafficDist
            : STATE.intervention?.trafficShiftActive &&
                STATE.intervention.originalTrafficDist
                ? STATE.intervention.originalTrafficDist
                : STATE.trafficDistribution;

    const current = base.INFERENCE || 0;
    if (Math.abs(current - target) < 1e-9) return;

    // Take (or give back) the delta proportionally across the other shares.
    let othersTotal = 0;
    for (const key of Object.keys(base)) {
        if (key !== "INFERENCE") othersTotal += base[key] || 0;
    }
    if (othersTotal <= 0) {
        base.INFERENCE = target;
        return;
    }
    const scale = (1 - target) / othersTotal;
    for (const key of Object.keys(base)) {
        if (key !== "INFERENCE") base[key] = (base[key] || 0) * scale;
    }
    base.INFERENCE = target;
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
                // Resilience (#196): the session counter behind the
                // "survived a node failure" objective helper.
                if (STATE.resilience) STATE.resilience.outages++;
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

// ==================== REGION OUTAGE (#221) ====================
//
// The whole-region failure the multi-region lesson needs: where
// SERVICE_OUTAGE above kills one node, this kills one ENTIRE regional stack
// behind a GeoDNS front door — the "an Availability Zone went dark" scenario
// that active-active exists for. Campaign-only, driven by the level config
// (forceRegionOutageAtSec / regionOutageDurationSec) from CampaignController
// .tick(), so every timer here is game time: pause freezes the outage, and a
// retry/reset rebuilds the state through loadLevel (the #183 timer class).
//
// The outage RESTORES after regionOutageDurationSec on purpose (rather than
// staying dark for the level): failover is only half of active-active, and
// the restore is what lets the player watch traffic spread BACK across both
// regions — the direction no single-node outage ever shows.

// Same visual contract as SERVICE_OUTAGE: isDisabled + ghosted mesh.
function setServiceDisabled(service, disabled) {
    service.isDisabled = disabled;
    service.mesh.material.opacity = disabled ? 0.3 : 1.0;
    service.mesh.material.transparent = disabled;
}

function totalCampaignCompleted() {
    return Object.values(STATE.campaign?.completedByType || {}).reduce(
        (a, b) => a + b,
        0
    );
}

// The set of service ids that die with the region behind `frontDoorId` (one
// direct downstream of a DNS node): everything reachable from that front door
// that is NOT reachable from any other way into the graph. A shared backend
// wired from both regions stays up — which is itself accurate: a database
// both regions talk to is not sitting in the dead AZ.
function computeRegionSubtree(frontDoorId) {
    const byId = new Map(STATE.services.map((s) => [s.id, s]));

    // Defensive BFS: the services graph has no downward cycles today
    // (topology guards them), but a visited set costs nothing and keeps this
    // terminating if one ever appears.
    const reachableFrom = (startIds, blockedId) => {
        const seen = new Set();
        const stack = [...startIds];
        while (stack.length > 0) {
            const id = stack.pop();
            if (id === blockedId || seen.has(id) || !byId.has(id)) continue;
            seen.add(id);
            for (const next of byId.get(id).connections) stack.push(next);
        }
        return seen;
    };

    const behindFrontDoor = reachableFrom([frontDoorId], null);
    // Every OTHER way in: the Internet's remaining direct entries — the
    // GeoDNS itself among them, and walking it reaches the surviving regions'
    // stacks. Traversal is blocked at the dying front door, so "reachable"
    // here means reachable WITHOUT the dead region.
    const otherEntries = (STATE.internetNode?.connections || []).filter(
        (id) => id !== frontDoorId
    );
    const reachableElsewhere = reachableFrom(otherEntries, frontDoorId);

    return [...behindFrontDoor].filter((id) => !reachableElsewhere.has(id));
}

// THE CARDINAL INVARIANT: a request caught inside the dying region must
// terminate now, not sit in a dead queue. Non-MALICIOUS requests fail with
// the REGION_DOWN badge; a MALICIOUS one is removed silently — the attack
// died with the region, so it neither breached (failRequest would score it
// as one) nor earned the WAF a block.
function terminateInDeadRegion(req) {
    // Mid-air arrivals hold an incomingCount slot on their target; give it
    // back before freezing the flight, exactly like Request.destroy() would.
    if (req.isMoving && req.target && typeof req.target.incomingCount === "number") {
        req.target.incomingCount = Math.max(0, req.target.incomingCount - 1);
    }
    req.isMoving = false;
    if (req.type === TRAFFIC_TYPES.MALICIOUS) {
        removeRequest(req);
    } else {
        failRequest(req, FAIL_REASONS.REGION_DOWN);
    }
}

// Fires the region outage. Deterministic target: the FIRST front door the
// internet-wired DNS was connected to — i.e. the level's pre-built region,
// which the briefing announces, so the player always knows which side dies.
// Returns false (and stays inert) when there is no DNS front door to kill.
function triggerRegionOutage(durationSec) {
    const dns = STATE.services.find(
        (s) => s.type === "dns" && STATE.internetNode.connections.includes(s.id)
    );
    const frontDoor = dns
        ? dns.connections
            .map((id) => STATE.services.find((s) => s.id === id))
            .find(Boolean)
        : null;
    if (!frontDoor) return false;

    const serviceIds = computeRegionSubtree(frontDoor.id);
    STATE.campaign.regionOutage = {
        serviceIds,
        endAtSec: STATE.elapsedGameTime + durationSec,
        active: true,
        // Completed-request watermarks for the "kept serving through the
        // outage" objective — see CampaignObjectives.completedDuringRegionOutage.
        startedCompleted: totalCampaignCompleted(),
        endedCompleted: null,
    };

    // Resilience (#196): one region outage is one node-failure event on the
    // session counter behind survivedNodeFailure — same as SERVICE_OUTAGE.
    if (STATE.resilience) STATE.resilience.outages++;

    const dead = new Set(serviceIds);
    for (const id of serviceIds) {
        const s = STATE.services.find((x) => x.id === id);
        if (s) setServiceDisabled(s, true);
    }

    // Terminate everything already inside the region: queued, processing and
    // mid-air arrivals. New traffic never enters — every routing site funnels
    // through isRoutable(), which skips disabled nodes — and a retry backoff
    // aimed here re-validates its peer on expiry (tickRetry) and fails on its
    // own, so after this sweep nothing can hang in the dark.
    for (const id of serviceIds) {
        const s = STATE.services.find((x) => x.id === id);
        if (!s) continue;
        const caught = [
            ...s.queue.splice(0),
            ...s.processing.splice(0).map((job) => job.req),
            // The AI Wave (#87): a GPU's live batch and an Inference
            // Gateway's deadline entries die with their region too. Unlike a
            // stream (whose heads fail on their own once every consumer goes
            // dark), a mid-run batch would otherwise COMPLETE inside the dark
            // region — so these must be swept here explicitly.
            ...(s.batch ? s.batch.splice(0) : []),
            ...(s.pending ? s.pending.splice(0).map((entry) => entry.req) : []),
        ];
        for (const req of caught) terminateInDeadRegion(req);
    }
    for (const req of STATE.requests.slice()) {
        if (req.isMoving && req.target && dead.has(req.target.id)) {
            terminateInDeadRegion(req);
        }
    }

    addInterventionWarning(
        i18n.t("region_outage_warning", {
            type: i18n.t(frontDoor.type),
            count: serviceIds.length,
        }),
        "danger",
        8000
    );
    STATE.sound?.playTone(200, "sawtooth", 0.5);
    STATE.sound?.playTone(150, "sawtooth", 0.5, 0.15);
    return true;
}

// Ticked from CampaignController.tick() every frame while the outage is
// active (so it freezes with the game — tick receives the game-scaled dt and
// elapsedGameTime stops at timeScale 0).
function updateRegionOutage() {
    const outage = STATE.campaign?.regionOutage;
    if (!outage?.active) return;

    // Re-assert every frame. Pausing the game ends any concurrent random
    // SERVICE_OUTAGE, and that cleanup re-enables EVERY disabled service
    // (see endRandomEvent) — this region's included. An idempotent re-disable
    // keeps the region dark whatever fires around it, and it is what makes
    // pause → resume re-darken the SAME region, the way outageServiceId does
    // for a single service.
    for (const id of outage.serviceIds) {
        const s = STATE.services.find((x) => x.id === id);
        if (s && !s.isDisabled) setServiceDisabled(s, true);
    }

    if (STATE.elapsedGameTime >= outage.endAtSec) endRegionOutage();
}

function endRegionOutage() {
    const outage = STATE.campaign?.regionOutage;
    if (!outage?.active) return;

    for (const id of outage.serviceIds) {
        const s = STATE.services.find((x) => x.id === id);
        if (!s) continue; // demolished mid-outage
        // A random SERVICE_OUTAGE may have independently picked this node;
        // its own end event owns that restore.
        if (
            STATE.intervention?.activeEvent === "SERVICE_OUTAGE" &&
            STATE.intervention.outageServiceId === id
        ) {
            continue;
        }
        setServiceDisabled(s, false);
    }

    outage.active = false;
    outage.endedCompleted = totalCampaignCompleted();
    addInterventionWarning(i18n.t("region_outage_restored"), "info", 5000);
    STATE.sound?.playSuccess();
}

export {
    addInterventionWarning,
    computeRegionSubtree,
    endRandomEvent,
    endRegionOutage,
    triggerRandomEvent,
    triggerRegionOutage,
    updateActiveEventTimer,
    updateInferenceStaging,
    updateMaliciousSpike,
    updateRandomEvents,
    updateRegionOutage,
    updateTrafficShift,
};
