// Failure taxonomy (#156, educational failure badges). One symbolic constant
// per reason a request can die, whose VALUE is the i18n key of the short label
// the floating badge shows. Two rules keep this honest:
//
//   1. It is pure data with no imports, so every layer (core/actions.js, the
//      handler registry, Request/Service, retry/stream/circuit-breaker, and
//      ui/failure-badges.js) can share it without a new cycle.
//   2. A reason is ATTRIBUTION ONLY. It rides along the existing fail path as
//      an extra argument and never decides anything — adding one must not
//      change which requests fail, in what order, or how they are scored.
//      That is what makes the whole feature provably free of gameplay drift
//      (see tests/sim/failure-badges.test.mjs, "reason argument is inert").
//
// The wording is a teaching line, not an error message: a player who reads
// "Read-only replica" learns why a WRITE cannot land there. Keep them SHORT —
// they are drawn as a floating label over the node, not a sentence.
//
// Two reasons are DERIVED rather than passed by a call site, because the site
// that fails the request does not know them:
//   BREACH        — any MALICIOUS request that reaches failRequest is a breach
//                   (that is exactly what updateScore already scores it as),
//                   whichever routing verdict actually dropped it.
//   CIRCUIT_OPEN  — a NO_ROUTE at a node whose downstream is only unreachable
//                   because its breaker tripped is fail-fast, not a wiring
//                   mistake. Resolved in failOrPark(); see routingReason().

export const FAIL_REASONS = {
    // Capacity / health
    QUEUE_FULL: "fail_queue_full",
    OVERLOADED: "fail_overloaded",
    RETRY_FAILED: "fail_retry_failed",

    // Topology dead ends
    NO_ROUTE: "fail_no_route",
    NO_ORIGIN: "fail_no_origin",
    NO_SUBSCRIBER: "fail_no_subscriber",
    NO_MASTER: "fail_no_master",

    // Wrong destination for this traffic — the OLTP/OLAP and read-replica
    // lessons, worded per site so each one teaches its own rule.
    READ_ONLY_REPLICA: "fail_read_only_replica",
    ANALYTICS_STORE: "fail_analytics_store",
    WRONG_STORE: "fail_wrong_store",
    NOT_INDEXED: "fail_not_indexed",
    SEARCH_ONLY: "fail_search_only",

    // Wave 1 mechanics
    CIRCUIT_OPEN: "fail_circuit_open",
    PARTITION_STALLED: "fail_partition_stalled",

    // Security / load shedding
    BREACH: "fail_breach",
    THROTTLED: "fail_throttled",
};

// Reasons the badge paints amber instead of red: the request was shed on
// purpose (rate limiting working as designed), not dropped by a broken board.
export const SOFT_REASONS = new Set([FAIL_REASONS.THROTTLED]);
