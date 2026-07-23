// Shared world-building helpers for the sim test suite (#155 PR 10).
// Imports the REAL game modules (game.js's whole graph evaluates under the
// happy-dom + THREE-stub environment installed by sim-setup.mjs).

import { STATE } from "../../src/state.js";
import { CONFIG } from "../../src/config.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { resetResilience } from "../../src/sim/circuit-breaker.js";

export { STATE, CONFIG };

// Reset the mutable singleton STATE between tests. Mirrors the fields
// resetGame() touches, minus the UI/sound side effects — deterministic
// sandbox-style defaults (no degradation, no upkeep drain, no interventions).
export function resetWorld({ money = 100000, gameMode = "sandbox" } = {}) {
  STATE.services.forEach((s) => s.destroy());
  STATE.requests.forEach((r) => r.destroy());
  STATE.services = [];
  STATE.requests = [];
  STATE.connections = [];
  STATE.internetNode.connections = [];
  STATE.internetNode.position.set(
    CONFIG.internetNodeStartPos.x,
    CONFIG.internetNodeStartPos.y,
    CONFIG.internetNodeStartPos.z
  );

  STATE.money = money;
  STATE.reputation = 100;
  STATE.requestsProcessed = 0;
  STATE.score = { total: 0, storage: 0, database: 0, maliciousBlocked: 0 };
  STATE.failures = { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0 };

  STATE.gameMode = gameMode; // "sandbox" => no health degradation in update()
  STATE.upkeepEnabled = false;
  STATE.autoRepairEnabled = false;
  STATE.timeScale = 1;
  STATE.isRunning = true;
  STATE.elapsedGameTime = 0;
  STATE.spawnTimer = 0;
  STATE.currentRPS = 0;
  STATE.selectedNodeId = null;
  STATE.activeTool = "select";

  resetResilience(); // mirrors resetGame() (#196 session counters)

  STATE.campaign.active = false;
  if (globalThis.window?.campaign) globalThis.window.campaign.active = false;

  STATE.finances = {
    income: {
      byType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 },
      countByType: { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, blocked: 0 },
      requests: 0,
      blocked: 0,
      total: 0,
    },
    expenses: {
      services: 0,
      upkeep: 0,
      repairs: 0,
      autoRepair: 0,
      mitigation: 0,
      breach: 0,
      byService: {
        waf: 0, alb: 0, compute: 0, db: 0, s3: 0, cache: 0, sqs: 0,
        search: 0, replica: 0, apigw: 0, nosql: 0, cdn: 0, serverless: 0,
        monitor: 0,
      },
      countByService: {
        waf: 0, alb: 0, compute: 0, db: 0, s3: 0, cache: 0, sqs: 0,
        search: 0, replica: 0, apigw: 0, nosql: 0, cdn: 0, serverless: 0,
        monitor: 0,
      },
    },
  };
}

// Place a service on its own grid tile and return the Service instance.
let placeIndex = 0;
export function place(type) {
  // Spread services far apart so the <1 unit collision check never trips.
  const pos = new globalThis.THREE.Vector3(placeIndex * 8, 0, 0);
  placeIndex++;
  const before = STATE.services.length;
  createService(type, pos);
  if (STATE.services.length === before) {
    throw new Error(`place(${type}) failed (money? occupied tile?)`);
  }
  return STATE.services[STATE.services.length - 1];
}

export function connect(fromIdOrService, toIdOrService) {
  const id = (x) => (typeof x === "string" ? x : x.id);
  createConnection(id(fromIdOrService), id(toIdOrService));
}

// One simulation frame, same ordering as game.js's animate loop:
// services update first, then requests move.
export function step(dt = 0.1) {
  STATE.services.forEach((s) => s.update(dt));
  STATE.requests.slice().forEach((r) => r.update(dt));
}

export function run(seconds, dt = 0.1) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) step(dt);
}
