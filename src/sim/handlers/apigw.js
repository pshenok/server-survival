// API Gateway job handler (#155 PR 9). Rate limiting: over-limit requests are
// throttled (soft fail), the rest round-robin to any live downstream. The
// per-second rateCounter reset stays in Service.update() (it is per-frame
// bookkeeping, not job dispatch). Logic lifted unchanged from the per-type
// if-chain in Service.update().

import { CONFIG } from "../../config.js";
import { failOrPark, throttleRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";
// Runtime-only cycle (index.js ⇄ apigw.js): forwardCandidates is a hoisted
// function declaration, only dereferenced when a job is actually dispatched —
// long after both modules finish evaluating. Established pattern.
import { forwardCandidates } from "./index.js";

// The share of the rate limit at which a class starts being refused (#248).
// A gateway that sheds blindly protects nothing: measured on the reference
// board at 8 rps, the topology alone killed READ 118 / SEARCH 32 / WRITE 28 /
// UPLOAD 19 and STATIC 0 — the $1.20 and $1.50 traffic died while the $0.50
// traffic sailed through, and the player had no say in it.
//
// Real systems classify in ADVANCE (Google's CRITICAL vs SHEDDABLE_PLUS,
// Envoy's priority levels) precisely because nobody can make this decision
// during an incident. Unclassified traffic is treated as CRITICAL: refusing
// something the config never spoke about would be the wrong default.
function shedThresholdFor(req) {
  const cls = req.typeConfig?.criticality;
  const policy = CONFIG.shedding || {};
  return policy[cls] ?? 1.0;
}

export function process(service, job) {
  service.rateCounter = (service.rateCounter || 0) + 1;
  const rateLimit = service.config.rateLimit || 20;

  // PRIORITIZED SHEDDING (#248). The gateway degrades in a chosen order:
  // SHEDDABLE goes at 60% of the limit, STANDARD at 85%, CRITICAL is carried
  // to the very last slot. Throttling stays the soft-fail it always was — it
  // feeds neither the breaker nor the error rate — so this changes WHICH
  // requests are shed, never how many the gateway can serve.
  if (service.rateCounter > rateLimit * shedThresholdFor(job.req)) {
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
