// Read Replica job handler (#155 PR 9). Terminal node: completes db-destined
// READ requests, but only while wired to a master (db or nosql). Logic lifted
// unchanged from the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  const hasMaster = service.connections.some(id => {
    const s = STATE.services.find(svc => svc.id === id);
    return s && (s.type === "db" || s.type === "nosql");
  });
  if (!hasMaster) {
    failRequest(job.req);
    return "next";
  }
  if (job.req.type === "READ" && job.req.destination === "db") {
    finishRequest(job.req, service.type, service);
  } else {
    failRequest(job.req);
  }
  return "next";
}
