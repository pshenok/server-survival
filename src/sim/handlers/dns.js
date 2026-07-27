// GeoDNS job handler (#198, Sandbox archetypes batch 2). DNS is chosen as the
// entry from the Internet (routeRequestToEntry prefers a DNS front-door), then
// this handler RE-DISPATCHES the record across its own routable downstream
// front-doors — one WAF / ALB / API Gateway per independent regional stack —
// round-robin. That is the distinguishing behavior: where an ALB balances
// workers WITHIN a single stack, DNS balances whole independent stacks at the
// very front (the basis for multi-region / regional failover).
//
// It never terminates a record itself: it forwards to a front-door (which runs
// its own pipeline) or, with no routable downstream, fails it (a wired DLQ may
// catch it) so nothing leaks. No cycle: DNS only ever forwards "down" into
// WAF/ALB/API-GW, none of which route back up to it (topology guards this).

import { STATE } from "../../state.js";
import { failOrPark } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";
import { isRoutable } from "../circuit-breaker.js";

export function process(service, job) {
    const stacks = service.connections
        .map((id) => STATE.services.find((s) => s.id === id))
        .filter((s) => s && isRoutable(s));

    if (stacks.length === 0) {
        failOrPark(job.req, service, FAIL_REASONS.NO_ROUTE);
        return "next";
    }

    // Round-robin across the independent regional front-doors.
    const target = stacks[service.rrIndex % stacks.length];
    service.rrIndex++;
    job.req.flyTo(target);
    return "next";
}
