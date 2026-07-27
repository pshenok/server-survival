// NoSQL DB job handler (#155 PR 9). Terminal node: handles READ and WRITE,
// but NOT SEARCH. Logic lifted unchanged from the per-type if-chain in
// Service.update().

import { failRequest, finishRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";

export function process(service, job) {
  // NoSQL handles READ and WRITE, but NOT SEARCH
  if (job.req.type === "SEARCH") {
    // A key-value store is not a search index — that is the whole reason the
    // Search Engine node exists (#156).
    failRequest(job.req, FAIL_REASONS.NOT_INDEXED);
  } else if (job.req.destination === "db") {
    finishRequest(job.req, service.type, service);
  } else {
    failRequest(job.req, FAIL_REASONS.WRONG_STORE);
  }
  return "next";
}
