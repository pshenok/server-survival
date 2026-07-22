// CDN job handler (#155 PR 9). High cache hit rate for static content; on a
// miss forwards to the connected origin (S3 or whatever is wired). Logic
// lifted unchanged from the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { failRequest, finishRequest } from "../../core/actions.js";

export function process(service, job) {
  if (job.req.type === "STATIC") {
    const hitRate = service.config.cacheHitRate || 0.95;

    // CDN Cache Hit
    if (Math.random() < hitRate) {
      job.req.cached = true;
      STATE.sound.playSuccess();
      service.flashCacheHit();
      finishRequest(job.req, service.type);
      return "next";
    }
  }

  // Cache Miss - Forward to Origin (S3 or whatever is connected)
  // We look for any connected service that isn't Internet
  const connectedServices = service.connections
    .map((id) => STATE.services.find((s) => s.id === id))
    .filter((s) => s && s.type !== "internet" && !s.isDisabled);

  if (connectedServices.length > 0) {
    // Simple round robin or just pick first
    const target = connectedServices[0];
    job.req.flyTo(target);
  } else {
    // Configuring Miss but no origin = Fail
    failRequest(job.req);
  }
  return "next";
}
