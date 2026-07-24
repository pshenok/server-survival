// Notification job handler (#197, Sandbox archetypes batch 1). A TERMINAL sink,
// like S3 or the DB — but the only terminal whose SUCCESS grants reputation
// (user goodwill from a delivered notification) on top of the usual reward,
// rather than money alone. That is its distinguishing behavior.
//
// The other half of the hook — SILENT overload failures that accrue
// "dissatisfaction" instead of a counted, sonified failure — lives in
// Service.update()'s shared failure roll (a notify drop calls notifySilentFail
// there), because that is where a terminal node's only failures come from: it
// never fails for "no route". See core/actions.js:notifySilentFail.
//
// Termination invariant (#191/#192): every request reaching here terminates via
// finishRequest — notify accepts any traffic type and always completes it.

import { STATE } from "../../state.js";
import { finishRequest } from "../../core/actions.js";

export function process(service, job) {
    finishRequest(job.req, service.type, service);
    // Extra reputation beyond the base SUCCESS_REPUTATION finishRequest applies:
    // a delivered notification is goodwill, valuable even when the money reward
    // is small.
    STATE.reputation += service.config.repBonus || 0;
    return "next";
}
