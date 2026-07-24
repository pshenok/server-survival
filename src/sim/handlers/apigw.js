// API Gateway job handler (#155 PR 9). Rate limiting: over-limit requests are
// throttled (soft fail), the rest round-robin to any live downstream. The
// per-second rateCounter reset stays in Service.update() (it is per-frame
// bookkeeping, not job dispatch). Logic lifted unchanged from the per-type
// if-chain in Service.update().

import { STATE } from "../../state.js";
import { failRequest, throttleRequest } from "../../core/actions.js";
import { isRoutable } from "../circuit-breaker.js";

export function process(service, job) {
  service.rateCounter = (service.rateCounter || 0) + 1;
  const rateLimit = service.config.rateLimit || 20;

  if (service.rateCounter > rateLimit) {
    // Rate limited - soft fail
    throttleRequest(job.req);
    return "next";
  }

  // Forward to downstream (ALB, SQS, Compute) — skipping offline and
  // breaker-open nodes (#196).
  const candidates = service.connections
    .map((id) => STATE.services.find((s) => s.id === id))
    .filter(isRoutable);

  if (candidates.length > 0) {
    const target = candidates[service.rrIndex % candidates.length];
    service.rrIndex++;
    job.req.flyTo(target);
  } else {
    failRequest(job.req);
  }
  return "next";
}
