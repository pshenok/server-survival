// Read Replica job handler (#155 PR 9). Terminal node: completes db-destined
// READ requests, but only while wired to a master (db or nosql). Logic lifted
// unchanged from the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { failRequest, finishRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";

export function process(service, job) {
  const hasMaster = service.connections.some(id => {
    const s = STATE.services.find(svc => svc.id === id);
    return s && (s.type === "db" || s.type === "nosql");
  });
  if (!hasMaster) {
    // A replica replicates FROM somewhere — unwired, it has nothing to serve.
    failRequest(job.req, FAIL_REASONS.NO_MASTER);
    return "next";
  }
  if (job.req.type === "READ" && job.req.destination === "db") {
    finishRequest(job.req, service.type, service);
  } else {
    // The read-replica lesson (#156): WRITEs must go to the master.
    failRequest(job.req, FAIL_REASONS.READ_ONLY_REPLICA);
  }
  return "next";
}
