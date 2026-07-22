// NoSQL DB job handler (#155 PR 9). Terminal node: handles READ and WRITE,
// but NOT SEARCH. Logic lifted unchanged from the per-type if-chain in
// Service.update().

import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  // NoSQL handles READ and WRITE, but NOT SEARCH
  if (job.req.type === "SEARCH") {
    failRequest(job.req);
  } else if (job.req.destination === "db") {
    finishRequest(job.req, service.type, service);
  } else {
    failRequest(job.req);
  }
  return "next";
}
