// Scheduler / Cron mechanic (#197, Sandbox archetypes batch 1). The scheduler
// is the only node that is a traffic SOURCE, not a processor: it generates its
// OWN internal traffic in scheduled bursts (batch jobs at 03:00), independent
// of the external RPS the player controls. That is what makes it distinct from
// every other box — nothing is routed into it; it emits.
//
// Ticked from Service.update() with the game-scaled dt, exactly like every
// other timer in the sim — never setTimeout (#183): so it FREEZES with the
// game at timeScale 0 (dt is 0) and cannot outlive a reset. There is no handler
// registry entry for "scheduler".
//
// Termination invariant (#191/#192): every emitted request is a normal Request
// flown to a real downstream, so it terminates on that node's usual path. If
// the scheduler has no routable downstream it emits nothing at all — no
// stranded requests, no pointless failures.

import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
// Runtime-only cycle (game.js / core ⇄ these): Request is only constructed at
// runtime, long after the module graph evaluates. Established pattern.
import { Request } from "../entities/Request.js";
import { isRoutable } from "./circuit-breaker.js";

function routableTargets(service) {
    return service.connections
        .map((id) => STATE.services.find((s) => s.id === id))
        .filter((s) => s && isRoutable(s));
}

// Inject one scheduled burst into the downstream, round-robin across every
// routable target so a scheduler wired to two queues splits its batch evenly.
function emitBurst(service) {
    const targets = routableTargets(service);
    if (targets.length === 0) return; // nowhere to send — skip the wave entirely

    const type = TRAFFIC_TYPES[service.config.burstType] || TRAFFIC_TYPES.WRITE;
    const count = service.config.burstSize || 6;
    for (let i = 0; i < count; i++) {
        const req = new Request(type);
        STATE.requests.push(req);
        const target = targets[i % targets.length];
        req.flyTo(target);
    }
}

// Advance the cron timer and fire a burst every intervalSec of GAME time.
// A `while` (not `if`) drains any backlog if several intervals elapsed in one
// fast-forwarded frame, so bursts stay on schedule under time acceleration.
export function tickScheduler(service, dt) {
    const interval = service.config.intervalSec || CONFIG.services.scheduler.intervalSec;
    service.cronTimer = (service.cronTimer || 0) + dt;
    while (service.cronTimer >= interval) {
        service.cronTimer -= interval;
        emitBurst(service);
    }
}
