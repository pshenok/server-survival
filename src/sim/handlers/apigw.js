// API Gateway job handler (#155 PR 9). Rate limiting: over-limit requests are
// throttled (soft fail), the rest round-robin to any live downstream. The
// per-second rateCounter reset stays in Service.update() (it is per-frame
// bookkeeping, not job dispatch). Logic lifted unchanged from the per-type
// if-chain in Service.update().

import { failOrPark, throttleRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";
// Runtime-only cycle (index.js ⇄ apigw.js): forwardCandidates is a hoisted
// function declaration, only dereferenced when a job is actually dispatched —
// long after both modules finish evaluating. Established pattern.
import { forwardCandidates } from "./index.js";

export function process(service, job) {
  service.rateCounter = (service.rateCounter || 0) + 1;
  const rateLimit = service.config.rateLimit || 20;

  if (service.rateCounter > rateLimit) {
    // Rate limited - soft fail
    throttleRequest(job.req, FAIL_REASONS.THROTTLED);
    return "next";
  }

  // Forward to downstream (ALB, SQS, Compute, Pub/Sub) — skipping offline and
  // breaker-open nodes (#196) and the Dead-Letter Queue sink (#197, reached
  // only via failOrPark, never as a normal target). Shared with genericForward
  // since the AI Wave (#87): the gateway has an infgw edge, so its forward has
  // to carry the same INFERENCE preference / single-type exclusion.
  const candidates = forwardCandidates(service, job.req);

  if (candidates.length > 0) {
    const target = candidates[service.rrIndex % candidates.length];
    service.rrIndex++;
    job.req.flyTo(target);
  } else {
    failOrPark(job.req, service, FAIL_REASONS.NO_ROUTE);
  }
  return "next";
}
