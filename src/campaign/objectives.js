// Pure objective-check helpers. All take live STATE and return boolean or number.
// Stateless and side-effect free.

export const CampaignObjectives = {
    // ---- counters tracked via STATE.campaign.completedByType (populated in Task 5) ----

    completedOfType(state, type) {
        return state.campaign?.completedByType?.[type] || 0;
    },

    totalCompleted(state) {
        const c = state.campaign?.completedByType || {};
        return Object.values(c).reduce((a, b) => a + b, 0);
    },

    totalFailures(state) {
        return Object.values(state.failures || {}).reduce((a, b) => a + b, 0);
    },

    failureRate(state) {
        const completed = CampaignObjectives.totalCompleted(state);
        const failed = CampaignObjectives.totalFailures(state);
        const total = completed + failed;
        return total === 0 ? 0 : failed / total;
    },

    // ---- service introspection ----

    hasService(state, type) {
        return (state.services || []).some((s) => s.type === type);
    },

    countServices(state, type) {
        return (state.services || []).filter((s) => s.type === type).length;
    },

    /** Returns true if state.services contains `requiredType` and none of `forbiddenTypes`. */
    usesOnly(state, requiredType, forbiddenTypes) {
        const types = new Set((state.services || []).map((s) => s.type));
        if (!types.has(requiredType)) return false;
        return forbiddenTypes.every((t) => !types.has(t));
    },

    // ---- load checks (uses Service.totalLoad getter, range 0..1) ----

    maxLoadOfType(state, type) {
        const services = (state.services || []).filter((s) => s.type === type);
        if (services.length === 0) return 0;
        return Math.max(...services.map((s) => s.totalLoad || 0));
    },

    /**
     * Load of the single busiest service on the board, whatever its type.
     * The observability objective (level 15) is deliberately type-BLIND: the
     * whole lesson is that the player cannot name the bottleneck until the
     * METRICS panel shows it to them, so the goal must not name it either.
     */
    busiestLoad(state) {
        const services = state.services || [];
        if (services.length === 0) return 0;
        return Math.max(...services.map((s) => s.totalLoad || 0));
    },

    // ---- auto-scaling (#195) ----

    /**
     * True once an Auto-Scaling Group of this type has actually grown a fleet
     * — not merely been switched on.
     *
     * LATCHED on purpose. A live instance count is the obvious check and the
     * wrong one: the engine's hysteresis lands a freshly doubled fleet at
     * roughly half the scale-out threshold (targetUtil 0.7 -> ~0.35), so a
     * quiet stretch legitimately retires an instance again. An objective read
     * off the instantaneous count would then un-tick itself for doing exactly
     * what auto-scaling is supposed to do. `lastScaleAt` is stamped by the
     * first scaling action and never cleared for the life of the node, and
     * minInstances is 1, so a non-zero stamp can only mean "this fleet scaled
     * out at some point".
     */
    fleetScaledOut(state, type) {
        return (state.services || []).some(
            (s) =>
                s.type === type &&
                s.asgEnabled &&
                ((s.instances || 1) > 1 || (s.lastScaleAt || 0) > 0)
        );
    },

    // ---- finance ----

    netProfit(state) {
        const inc = state.finances?.income?.total || 0;
        const exp = state.finances?.expenses || {};
        const expTotal =
            (exp.services || 0) + (exp.upkeep || 0) + (exp.repairs || 0) +
            (exp.autoRepair || 0) + (exp.mitigation || 0) + (exp.breach || 0);
        return inc - expTotal;
    },

    totalUpkeepPerSec(state) {
        return (state.services || []).reduce((sum, s) => sum + (s.config.upkeep || 0) / 60, 0);
    },

    // ---- resilience (#196) ----

    /**
     * True when the architecture took a real node failure — a SERVICE_OUTAGE
     * event or a circuit breaker tripping — AND the player's reputation was
     * still above `minReputation` afterwards. That pairing is the whole
     * lesson: surviving is not "nothing broke", it is "something broke and
     * traffic kept flowing".
     *
     * Wired into level 17 (Node Down, #217). Deliberately NOT retro-fitted to
     * level 12 (High Availability): that level already scores redundancy
     * through its own objectives, and wiring this one in would re-balance a
     * level that ships today.
     */
    survivedNodeFailure(state, minReputation = 60) {
        const r = state.resilience || {};
        const failures = (r.outages || 0) + (r.trips || 0);
        return failures > 0 && (state.reputation || 0) >= minReputation;
    },

    /**
     * Requests completed while the forced region outage (#221) was dark.
     * Watermark arithmetic over the campaign completion counters: the trigger
     * stamps the count at lights-out, the restore stamps it at lights-on, and
     * while the outage is live the delta grows with every completion — so the
     * objective can tick DURING the outage, which is exactly when the player
     * is watching the surviving region carry the load.
     */
    completedDuringRegionOutage(state) {
        const outage = state.campaign?.regionOutage;
        if (!outage) return 0;
        const now = CampaignObjectives.totalCompleted(state);
        const end = outage.active ? now : (outage.endedCompleted ?? now);
        return Math.max(0, end - (outage.startedCompleted || 0));
    },

    /** Circuit breakers that opened this session. */
    breakerTrips(state) {
        return state.resilience?.trips || 0;
    },

    // ---- The AI Wave (#87) ----

    /**
     * INFERENCE requests that outlived an Inference Gateway's deadline this
     * session. Reads STATE.inference.expired — the resilience-counter
     * precedent — because the per-reason failure counters are off the table:
     * a #156 reason is attribution only, and an objective hanging off one
     * would make it load-bearing.
     */
    expiredRequests(state) {
        return state.inference?.expired || 0;
    },

    /** Requests that were retried via a healthy peer this session. */
    retriedRequests(state) {
        return state.resilience?.retries || 0;
    },

    /**
     * GPU bad answers across the whole fleet this session. A bad answer is a
     * SUCCESS-side event (#87): the request completed and paid, then the
     * quality roll dinged reputation — so it lives on the service
     * (service.badAnswers, bumped in tickGpu), never in the failure counters,
     * and an objective about model quality has to sum it from the fleet.
     */
    totalBadAnswers(state) {
        return (state.services || [])
            .filter((s) => s.type === "gpu")
            .reduce((sum, s) => sum + (s.badAnswers || 0), 0);
    },

    // ---- request-type counters (need campaign.tick() to bump these — see Task 5) ----

    /**
     * Requests that FINISHED on a service of this type. Pub/Sub fan-out
     * (level 19) is the case this exists for: one inbound event becomes one
     * delivery per subscriber, so the only way to prove the fan-out happened
     * is to count completions on each subscriber separately.
     */
    completedByService(state, type) {
        return state.campaign?.completedByService?.[type] || 0;
    },

    replicaShareOfReads(state) {
        const reads = state.campaign?.completedByType?.READ || 0;
        const viaReplica = state.campaign?.completedByService?.replica || 0;
        return reads === 0 ? 0 : viaReplica / reads;
    },

    nosqlShareOfWrites(state) {
        const writes = state.campaign?.completedByType?.WRITE || 0;
        const viaNosql = state.campaign?.completedByService?.nosql || 0;
        return writes === 0 ? 0 : viaNosql / writes;
    },
};
