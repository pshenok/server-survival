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
    // Multi-region (#221): a request that was already inside a regional stack
    // when the whole region went dark. Attribution only, like every reason
    // here — the region event fails those requests identically either way.
    REGION_DOWN: "fail_region_down",

    // The AI Wave (#87)
    // SLO_TIMEOUT — an Inference Gateway entry outlived its deadline; the
    //               answer is worthless now even though the GPUs may be fine.
    // GPU_ONLY    — non-INFERENCE traffic reached a GPU or Inference Gateway;
    //               a MALICIOUS one is relabelled to BREACH by failRequest as
    //               usual (the attack got through, consistent with #156).
    SLO_TIMEOUT: "fail_slo_timeout",
    GPU_ONLY: "fail_gpu_only",

    // Security / load shedding
    BREACH: "fail_breach",
    THROTTLED: "fail_throttled",
};

// Success-side soft badges (#87). NOT failure reasons: these ride the same
// badge renderer but are spawned via spawnServiceBadge() on a COMPLETION-side
// event — a GPU bad answer still finishes and pays, it just costs a little
// reputation — so they never touch failRequest and the #156 inertness
// contract stays intact. Kept in this file so the amber set below can name
// them without a new import cycle.
export const SOFT_BADGES = {
    BAD_ANSWER: "soft_bad_answer",
};

// Reasons the badge paints amber instead of red: the request was shed on
// purpose (rate limiting working as designed) or completed with a quality
// blemish (#87) — not dropped by a broken board.
export const SOFT_REASONS = new Set([FAIL_REASONS.THROTTLED, SOFT_BADGES.BAD_ANSWER]);
