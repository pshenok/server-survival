// Memory Cache job handler (#155 PR 9). Rolls the cache-hit chance, and on a
// miss routes toward the request's destination, preferring specialized
// services (search / replica / nosql before sql). Logic lifted unchanged from
// the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  if (job.req.isCacheable) {
    const hitRate = job.req.cacheHitRate;

    if (Math.random() < hitRate) {
      job.req.cached = true;
      STATE.sound.playSuccess();
      service.flashCacheHit();
      finishRequest(job.req, service.type, service);
      return "next";
    }
  }

  const destType = job.req.destination;

  // Cache miss routing: prefer specialized services
  if (destType === "db") {
    if (job.req.type === "SEARCH") {
      const searchTarget = service.findConnectedService("search");
      if (searchTarget) { job.req.flyTo(searchTarget); return "next"; }
    }
    if (job.req.type === "READ") {
      const replicaTarget = service.findConnectedService("replica");
      if (replicaTarget) { job.req.flyTo(replicaTarget); return "next"; }
    }
    if (job.req.type !== "SEARCH") {
      const nosqlTarget = service.findConnectedService("nosql");
      if (nosqlTarget) { job.req.flyTo(nosqlTarget); return "next"; }
    }
    const sqlTarget = service.findConnectedService("db");
    if (sqlTarget) { job.req.flyTo(sqlTarget); return "next"; }
    failRequest(job.req);
  } else {
    // Storage-family destinations are interchangeable on a miss (#88):
    // STATIC's destination is "cdn" but a Cache wired to S3 should still
    // deliver it — both are static-content origins.
    let target = service.findConnectedService(destType);
    if (!target && (destType === "cdn" || destType === "s3")) {
      target = service.findConnectedService(destType === "cdn" ? "s3" : "cdn");
    }
    if (target) {
      job.req.flyTo(target);
    } else {
      failRequest(job.req);
    }
  }
  return "next";
}
