// Smart-hints system (#155 PR 5): survival-mode teaching hints — situation
// checks (overloads, missing services, replica misconfig #190) and the
// dismissible warning UI. Code moved verbatim from game.js.

import { STATE } from "../state.js";
import { i18n } from "../i18n.js";

function checkSmartHints() {
  if (STATE.gameMode !== "survival") return;
  if (!STATE.hints) return;
  if (window.tutorial?.isActive) return;
  if (STATE.timeScale === 0) return;

  const now = STATE.elapsedGameTime;
  if (now - STATE.hints.lastHintTime < STATE.hints.hintCooldown) return;

  const dbServices = STATE.services.filter(s => s.type === "db");
  const hasSearch = STATE.services.some(s => s.type === "search");
  const hasReplica = STATE.services.some(s => s.type === "replica");
  const hasWaf = STATE.services.some(s => s.type === "waf");
  const hasCache = STATE.services.some(s => s.type === "cache");
  const hasCdn = STATE.services.some(s => s.type === "cdn");

  const dbOverloaded = dbServices.some(s => s.totalLoad > 0.8);
  const computeOverloaded = STATE.services
    .filter(s => s.type === "compute")
    .some(s => s.totalLoad > 0.8);

  // Misconfiguration: a Compute routes READs through a Replica but has no
  // master DB path left for WRITE/SEARCH traffic (#190). Players replace the
  // direct DB link with the Replica and then watch WRITEs die with no clue why
  // — Replicas are read-only by design, so teach that instead of failing silently.
  const replicaNoMaster = STATE.services.some(s =>
    s.type === "compute" &&
    s.connections.some(id => STATE.services.find(x => x.id === id)?.type === "replica") &&
    !s.connections.some(id => ["db", "nosql"].includes(STATE.services.find(x => x.id === id)?.type))
  );

  let hint = null;

  if (replicaNoMaster && (STATE.failures.WRITE || 0) + (STATE.failures.SEARCH || 0) > 3 &&
      !STATE.hints.dismissedHints.has("replica_write")) {
    hint = { key: "hint_replica_write", id: "replica_write" };
  } else if (dbOverloaded && !hasSearch && STATE.trafficDistribution.SEARCH > 0.05 &&
      !STATE.hints.dismissedHints.has("search")) {
    hint = { key: "hint_search_overload", id: "search" };
  } else if (dbOverloaded && !hasReplica && STATE.trafficDistribution.READ > 0.1 &&
      !STATE.hints.dismissedHints.has("replica")) {
    hint = { key: "hint_read_overload", id: "replica" };
  } else if (!hasWaf && (STATE.failures.MALICIOUS || 0) > 5 &&
      !STATE.hints.dismissedHints.has("waf")) {
    hint = { key: "hint_no_waf", id: "waf" };
  } else if (!hasCache && STATE.trafficDistribution.READ + STATE.trafficDistribution.STATIC + STATE.trafficDistribution.SEARCH > 0.5 &&
      !STATE.hints.dismissedHints.has("cache")) {
    hint = { key: "hint_no_cache", id: "cache" };
  } else if (computeOverloaded && !STATE.services.some(s => s.type === "sqs") &&
      !STATE.hints.dismissedHints.has("sqs")) {
    hint = { key: "hint_compute_overload", id: "sqs" };
  } else if (!hasCdn && STATE.trafficDistribution.STATIC > 0.3 &&
      !STATE.hints.dismissedHints.has("cdn")) {
    hint = { key: "hint_no_cdn", id: "cdn" };
  } else if (
    STATE.services.some(s => s.type === "serverless") &&
    STATE.currentRPS > 8 &&
    !STATE.hints.dismissedHints.has("serverless_expensive")
  ) {
    hint = { key: "hint_serverless_expensive", id: "serverless_expensive" };
  }

  if (hint) {
    showSmartHint(hint);
    STATE.hints.lastHintTime = now;
  }
}

function showSmartHint(hint) {
  const warningsContainer = document.getElementById("intervention-warnings");
  if (!warningsContainer) return;

  const warning = document.createElement("div");
  warning.className = "intervention-warning warning-info border-2 rounded-lg px-6 py-3 mb-2 shadow-lg";
  warning.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="font-bold text-sm">${i18n.t(hint.key)}</span>
      <button onclick="this.parentElement.parentElement.remove(); STATE.hints.dismissedHints.add('${hint.id}')"
        class="pointer-events-auto text-xs bg-blue-800 hover:bg-blue-700 px-2 py-1 rounded ml-2">${i18n.t('hint_dismiss')}</button>
    </div>
  `;
  warningsContainer.appendChild(warning);

  setTimeout(() => {
    warning.style.transition = "all 0.3s ease-out";
    warning.style.opacity = "0";
    warning.style.transform = "translateY(-20px)";
    setTimeout(() => warning.remove(), 300);
  }, 10000);
}

export {
    checkSmartHints,
};
