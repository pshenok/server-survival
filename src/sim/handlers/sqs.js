// Message Queue (SQS) job handler (#155 PR 9). Pushes to downstream ALBs with
// a backpressure check; compute nodes are deliberately NOT pushed to — they
// PULL from the queue (see the compute pull logic in Service.update()). The
// only handler that uses the requeue outcomes: "requeue-next" while waiting
// for a compute pull, "requeue-stop" when every downstream is saturated.
// Logic lifted unchanged from the per-type if-chain in Service.update().

import { STATE } from "../../state.js";
import { isRoutable } from "../circuit-breaker.js";

export function process(service, job) {
  // SQS just forwards requests with backpressure check
  // MODIFIED: Filter out compute nodes, they will PULL from us instead
  const downstreamTypes = ["alb"];
  // We intentionally excluded "compute" from the automatic push list.
  // Compute nodes must actively pull from SQS.

  const candidates = service.connections
    .map((id) => STATE.services.find((s) => s.id === id))
    .filter((s) => s && downstreamTypes.includes(s.type) && isRoutable(s));

  // If no candidates (e.g. only connected to compute), we just wait.
  // The request stays in 'processing' so it can be popped by compute.
  if (candidates.length === 0) {
    return "requeue-next";
  }

  // Round-robin with backpressure check
  let sent = false;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const target = candidates[service.rrIndex % candidates.length];
    service.rrIndex++;

    const targetMaxQueue = target.config.maxQueueSize || 20;
    if (target.queue.length + target.incomingCount < targetMaxQueue) {
      job.req.flyTo(target);
      sent = true;
      break;
    }
  }

  if (!sent) {
    // Downstream busy - keep in processing to retry next frame
    return "requeue-stop";
  }
  return "next";
}
