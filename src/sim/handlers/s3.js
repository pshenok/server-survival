// File Storage (S3) job handler (#155 PR 9). Terminal node: completes
// storage-family requests — destination "s3" or "cdn" (#88: both are
// static-content origins). Logic lifted unchanged from the per-type
// if-chain in Service.update().

import { failRequest, finishRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";

export function process(service, job) {
  if (job.req.destination === "s3" || job.req.destination === "cdn") {
    finishRequest(job.req, service.type, service);
  } else {
    // Object storage cannot answer database or search traffic (#156).
    failRequest(job.req, FAIL_REASONS.WRONG_STORE);
  }
  return "next";
}
