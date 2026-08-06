// Memory Cache job handler (#155 PR 9). Rolls the cache-hit chance, and on a
// miss routes toward the request's destination, preferring specialized
// services (search / replica / nosql before sql). Logic lifted unchanged from
// the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { CONFIG } from "../../config.js";
import { failOrPark, finishRequest } from "../../core/actions.js";
import { FAIL_REASONS } from "../../core/failure-reasons.js";

// A cache hit needs BOTH: content that is cacheable at all (a property of the
// traffic type — STATIC 0.9, READ 0.4, SEARCH 0.15, writes 0) and a cache big
// enough to still hold it (a property of the node's tier). This handler used
// to read only `job.req.cacheHitRate`, so Memory Cache tier upgrades bought
// capacity and nothing else — while the tooltip and `cache_desc_long`
// advertised "upgrade tiers for higher hit rates". The CDN handler had it
// right all along (it reads `service.config.cacheHitRate`); this is Memory
// Cache catching up.
//
// The tier is expressed as a MULTIPLIER against tier 1, deliberately: tier 1
// resolves to exactly 1.0, so every shipped campaign level plays bit-for-bit
// as before (levels never pre-build an upgraded cache) and only a player who
// spends $120/$180 sees a difference — which is what they were promised.
function effectiveHitRate(service, req) {
  const baseQuality = CONFIG.services.cache.cacheHitRate; // tier 1 = the anchor
  const quality = service.config.cacheHitRate || baseQuality;
  // Capped: a tier-3 cache must not make STATIC (0.9) a certainty, or a cache
  // in front of Storage would silently retire the origin.
  return Math.min(0.95, req.cacheHitRate * (quality / baseQuality));
}

export function process(service, job) {
  if (job.req.isCacheable) {
    const hitRate = effectiveHitRate(service, job.req);

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
    failOrPark(job.req, service, FAIL_REASONS.NO_ROUTE);
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
      failOrPark(job.req, service, FAIL_REASONS.NO_ROUTE);
    }
  }
  return "next";
}
