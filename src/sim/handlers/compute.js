// Compute / Serverless job handler (#155 PR 9). The routing brain: prefers
// specialized services (search / replica / nosql / cache with the #167 and
// #88 rules) and falls back to the general path. Shared by "compute" and
// "serverless" — the only difference is the per-invocation charge, which
// chargeServerlessInvocation() applies for serverless and no-ops for compute.
// Logic lifted unchanged from the per-type if-chain in Service.update().
//
// Runtime-only cycle (compute.js ⇄ serverless.js) — established pattern:
// hoisted function declarations, dereferenced long after both evaluate.

import { failRequest } from "../../core/actions.js";
import { chargeServerlessInvocation } from "./serverless.js";

export function process(service, job) {
  // Per-request cost for serverless (AWS Lambda style - charged per invocation,
  // including failed ones since you still pay for execution time)
  const chargePerRequest = () => chargeServerlessInvocation(service);

  const destType = job.req.destination;

  if (destType === "blocked") {
    chargePerRequest();
    failRequest(job.req);
    return "next";
  }

  if (job.req.isCacheable) {
    // Prefer specialized services over Cache when they're a better fit (#167):
    // - SEARCH cache hit rate is only 15%, so routing through Cache is mostly
    //   wasted latency. If a Search Engine is connected, use it directly.
    // - READ hit rate is 40%, but if Cache is heavily loaded, its queue delay
    //   outweighs the savings — prefer Read Replica when both are connected
    //   and Cache is >60% loaded.
    if (job.req.type === "SEARCH") {
      const searchDirect = service.findConnectedService("search");
      if (searchDirect) {
        chargePerRequest();
        job.req.flyTo(searchDirect);
        return "next";
      }
    }
    const cacheTarget = service.findConnectedService("cache");
    if (job.req.type === "READ" && cacheTarget && cacheTarget.totalLoad > 0.6) {
      const replicaDirect = service.findConnectedService("replica");
      if (replicaDirect) {
        chargePerRequest();
        job.req.flyTo(replicaDirect);
        return "next";
      }
    }
    // Only route through Cache if a miss can still reach its destination
    // from there (#88). A Cache wired only to the DB must not swallow
    // STATIC traffic whose destination is Storage — those requests
    // should use Compute's direct S3 link instead.
    if (cacheTarget) {
      const dest = job.req.destination;
      const cacheCanDeliver =
        dest === "db"
          ? true // cache-miss cascade handles search/replica/nosql/db
          : !!(cacheTarget.findConnectedService("s3") ||
               cacheTarget.findConnectedService("cdn"));
      if (cacheCanDeliver) {
        chargePerRequest();
        job.req.flyTo(cacheTarget);
        return "next";
      }
    }
  }

  // Routing: prefer specialized services, fallback to general
  if (destType === "db") {
    if (job.req.type === "SEARCH") {
      const searchTarget = service.findConnectedService("search");
      if (searchTarget) { chargePerRequest(); job.req.flyTo(searchTarget); return "next"; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return "next"; }
    } else if (job.req.type === "READ") {
      const replicaTarget = service.findConnectedService("replica");
      if (replicaTarget) { chargePerRequest(); job.req.flyTo(replicaTarget); return "next"; }
      const nosqlTarget = service.findConnectedService("nosql");
      if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); return "next"; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return "next"; }
    } else {
      const nosqlTarget = service.findConnectedService("nosql");
      if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); return "next"; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return "next"; }
    }
    chargePerRequest();
    failRequest(job.req);
    return "next";
  }

  // Storage-family destinations are interchangeable (#88): STATIC's
  // destination is "cdn" but a Compute wired directly to S3 must still
  // deliver it — both are static-content origins.
  let directTarget = service.findConnectedService(destType);
  if (!directTarget && (destType === "cdn" || destType === "s3")) {
    directTarget = service.findConnectedService(destType === "cdn" ? "s3" : "cdn");
  }
  if (directTarget) {
    chargePerRequest();
    job.req.flyTo(directTarget);
  } else {
    chargePerRequest();
    failRequest(job.req);
  }
  return "next";
}
