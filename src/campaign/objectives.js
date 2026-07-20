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

    // ---- request-type counters (need campaign.tick() to bump these — see Task 5) ----

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
