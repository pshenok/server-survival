// Data Warehouse job handler (#198, Sandbox archetypes batch 2). A pure
// terminal sink, like the DB — but with the INVERSE read/write profile, which
// is its distinguishing behavior: it COMPLETES analytics WRITES (WRITE /
// UPLOAD) and REJECTS realtime READS (READ / SEARCH / anything else). A
// warehouse is OLAP, not OLTP — you load it, you do not serve user reads from
// it — so a read that reaches it is a modelling error and FAILS (the OLTP-vs-
// OLAP lesson). The "slow and cheap at volume" half lives in config (very high
// processingTime, high capacity at very low upkeep).
//
// It is fed by an analytics fan-out (a Pub/Sub copy) or a scheduled batch load
// (Scheduler ETL) — both existing generic-forward sources — so no upstream
// routing brain had to learn about it.
//
// Termination invariant (#191/#192): every record reaching here terminates via
// finishRequest or failRequest exactly once.

import { TRAFFIC_TYPES } from "../../config.js";
import { failRequest, finishRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";

export function process(service, job) {
    const t = job.req.type;
    if (t === TRAFFIC_TYPES.WRITE || t === TRAFFIC_TYPES.UPLOAD) {
        // Analytics ingest — the one thing a warehouse is for.
        finishRequest(job.req, service.type, service);
    } else {
        // READ / SEARCH / STATIC / anything else: a warehouse cannot serve it.
        // The badge says so in as many words — this is the OLTP-vs-OLAP lesson
        // and the one failure players most often read as a bug (#156).
        failRequest(job.req, FAIL_REASONS.ANALYTICS_STORE);
    }
    return "next";
}
