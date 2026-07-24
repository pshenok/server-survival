// Per-service-type job handler registry (#155 PR 9 — the strategy-pattern
// enabler for Wave 1, #193). Service.update() finishes a job's processing
// timer, runs the shared failure roll, then dispatches the job here:
//
//   const handler = SERVICE_HANDLERS[service.type] || genericForward;
//   const outcome = handler(service, job);
//
// Adding a new service type = one handler file + one registry line below.
//
// CONTROL-FLOW CONTRACT — a handler's return value maps 1:1 onto the control
// flow the old inline if-chain used inside Service.update()'s job loop
// (the job has already been splice()d out of service.processing when the
// handler runs):
//
//   "next"          The job was consumed (finished / failed / throttled) or
//                   forwarded downstream. Move on to the next job.
//                   (was: `continue`)
//   "requeue-next"  The job was NOT consumed — put it back at its old index
//                   and move on to the next job. Used by SQS while it waits
//                   for a compute node to pull.
//                   (was: `this.processing.splice(i, 0, job); continue`)
//   "requeue-stop"  Backpressure — put the job back at its old index and stop
//                   processing this service for the rest of the frame. Used
//                   by SQS when every downstream target is saturated.
//                   (was: `this.processing.splice(i, 0, job); break`)
//
// Handlers reach shared context (STATE, core/actions) via imports, and the
// service instance via the first argument — no parameter soup.
//
// Types with no dedicated handler (waf, alb) fall back to genericForward.
// WAF's malicious-blocking logic is NOT here by design: it lives in
// Service.processQueue() (requests are blocked on intake, before they ever
// become processing jobs), outside the job-dispatch chain this registry owns.

import { STATE } from "../../state.js";
import { failOrPark } from "../../core/actions.js";
import { isRoutable } from "../circuit-breaker.js";
import { process as apigw } from "./apigw.js";
import { process as cache } from "./cache.js";
import { process as cdn } from "./cdn.js";
import { process as compute } from "./compute.js";
import { process as db } from "./db.js";
import { process as nosql } from "./nosql.js";
import { process as notify } from "./notify.js";
import { process as pubsub } from "./pubsub.js";
import { process as replica } from "./replica.js";
import { process as s3 } from "./s3.js";
import { process as search } from "./search.js";
import { process as serverless } from "./serverless.js";
import { process as sqs } from "./sqs.js";

// Shared fallback: round-robin the job to any live connected service.
// Logic lifted unchanged from the final `else` of the old if-chain, except
// that "live" now means isRoutable (#196): offline OR breaker-open, and a
// Dead-Letter Queue (#197) is never a normal forward target — it is a failure
// SINK reached only via failOrPark, so it is excluded here; with no other
// candidate the request falls through to failOrPark and can still be parked.
export function genericForward(service, job) {
  const candidates = service.connections
    .map((id) => STATE.services.find((s) => s.id === id))
    .filter((s) => s && s.type !== "dlq" && isRoutable(s));

  if (candidates.length > 0) {
    const target = candidates[service.rrIndex % candidates.length];
    service.rrIndex++;
    job.req.flyTo(target);
  } else {
    failOrPark(job.req, service);
  }
  return "next";
}

export const SERVICE_HANDLERS = {
  apigw,
  cache,
  cdn,
  compute,
  db,
  nosql,
  notify,
  pubsub,
  replica,
  s3,
  search,
  serverless,
  sqs,
};
