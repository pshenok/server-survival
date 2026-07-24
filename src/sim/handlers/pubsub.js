// Pub/Sub Topic job handler (#197, Sandbox archetypes batch 1). The ONLY
// handler that MULTIPLIES requests: an inbound request fans out to one delivery
// per connected subscriber. The original is delivered to the first subscriber;
// one CLONE is minted for every additional subscriber. Fan-out is capped at the
// subscriber count by construction, so it can never explode.
//
// Termination invariant (#191/#192) — the whole reason this handler is written
// carefully: every copy is a real Request that must terminate exactly once.
//   - the ORIGINAL is consumed here by being flown to subscriber #0 (it
//     terminates on that subscriber's normal path);
//   - each CLONE is pushed into STATE.requests and flown to its own subscriber,
//     terminating there;
//   - with NO routable subscriber the original is failed (or parked in a wired
//     DLQ) — never left hanging.
// Cloning happens BEFORE the original is re-flown so the clone copies a clean
// origin, and clones are plain Requests of the same traffic type, indistinct
// from organically spawned traffic thereafter.

import { STATE } from "../../state.js";
import { failOrPark } from "../../core/actions.js";
import { Request } from "../../entities/Request.js";
import { isRoutable } from "../circuit-breaker.js";

export function process(service, job) {
    const subs = service.connections
        .map((id) => STATE.services.find((s) => s.id === id))
        .filter((s) => s && isRoutable(s));

    if (subs.length === 0) {
        // No subscriber to deliver to — fail the event (a wired DLQ may catch it).
        failOrPark(job.req, service);
        return "next";
    }

    // One clone per ADDITIONAL subscriber, minted before the original is re-flown.
    for (let i = 1; i < subs.length; i++) {
        const clone = new Request(job.req.type);
        STATE.requests.push(clone);
        clone.flyTo(subs[i]);
    }

    // The original becomes subscriber #0's delivery.
    job.req.flyTo(subs[0]);
    return "next";
}
