// Search Engine job handler (#155 PR 9). Terminal node: completes SEARCH
// requests only. Logic lifted unchanged from the per-type if-chain in
// Service.update().

import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  if (job.req.type === "SEARCH") {
    finishRequest(job.req, service.type);
  } else {
    failRequest(job.req);
  }
  return "next";
}
