// Serverless Function job handler (#155 PR 9). Routing is identical to
// Compute (same topology, same specialized-service preferences) — the type
// difference is the AWS-Lambda-style per-invocation charge, which lives here
// and is also applied by Service.update()'s shared failure path (a serverless
// invocation is billed even when the function errors out).
//
// Runtime-only cycle (serverless.js ⇄ compute.js) — established pattern:
// hoisted function declarations, dereferenced long after both evaluate.

import { STATE } from "../../state.js";
import { process as computeProcess } from "./compute.js";

// Charges the per-request invocation cost. No-op for every type but
// "serverless", so shared code paths can call it unconditionally.
export function chargeServerlessInvocation(service) {
  if (service.type !== "serverless") return;
  const cost = service.config.perRequestCost || 0;
  STATE.money -= cost;
  if (STATE.finances) {
    STATE.finances.expenses.upkeep += cost;
    STATE.finances.expenses.byService.serverless =
      (STATE.finances.expenses.byService.serverless || 0) + cost;
  }
}

export function process(service, job) {
  return computeProcess(service, job);
}
