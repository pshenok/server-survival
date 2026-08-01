// The power grid (#87, The AI Wave). The smallest model that makes watts a
// real decision: GPUs draw CONFIG.power.gpuDrawKw each, the base grid plus
// every placed Substation supplies capacity, and a GPU cannot be placed past
// the cap. That is the whole mechanic — the substation itself is unwireable
// (no isValidEdge rows, like Monitoring) and never takes traffic.
//
// recomputePower() is deliberately ONE derivation function over live
// services, not call-site bookkeeping: the campaign prebuild loop constructs
// services via `new Service` directly (bypassing createService), so any
// incremental usedKw += / -= would silently go stale there. Call sites:
// createService, deleteObject, clearAllServices (topology.js),
// restoreServices + loadGameState (persistence/save-load.js), the campaign
// prebuild loop (ui/campaign-ui.js), resetGame (game.js) and the test world
// reset — each one just re-derives.
//
// The two gates live in topology.js (they are placement/demolish rules), but
// their predicates live here so the tests can pin the arithmetic — most
// importantly that the placement gate is boundary INCLUSIVE (<=): a build
// whose draw lands exactly on the cap is legal, which is precisely where
// level 24's target sits.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";

// Re-derive STATE.power = { usedKw, capKw } from the live service list.
export function recomputePower() {
    let gpus = 0;
    let subs = 0;
    for (const s of STATE.services) {
        if (s.type === "gpu") gpus++;
        else if (s.type === "power") subs++;
    }
    STATE.power = {
        usedKw: gpus * CONFIG.power.gpuDrawKw,
        capKw: CONFIG.power.baseCapKw + subs * CONFIG.power.substationKw,
    };
}

// Placement gate: can one more GPU go on the grid? Boundary INCLUSIVE — a
// draw that lands exactly on the cap is allowed.
export function hasPowerHeadroom() {
    return STATE.power.usedKw + CONFIG.power.gpuDrawKw <= STATE.power.capKw;
}

// Deletion gate (anti-cheese): true when removing ONE substation would leave
// the powered GPUs drawing more than the reduced cap supplies. Without this,
// buy-place-refund runs an 18 kW fleet on an 8 kW cap forever and level 24 is
// beaten by the exploit. GPU deletion itself stays free — shedding load is
// always legal.
export function substationRemovalStrandsGpus() {
    return STATE.power.usedKw > STATE.power.capKw - CONFIG.power.substationKw;
}
