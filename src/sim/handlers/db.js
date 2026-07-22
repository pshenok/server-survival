// Relational DB job handler (#155 PR 9). Terminal node: completes requests
// whose destination is the database, fails everything else. Logic lifted
// unchanged from the per-type if-chain in Service.update().

import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  if (job.req.destination === "db") {
    finishRequest(job.req, service.type, service);
  } else {
    failRequest(job.req);
  }
  return "next";
}
