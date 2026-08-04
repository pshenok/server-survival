import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
// Cyclic imports (game.js / core modules ⇄ Service.js) are safe: these are
// hoisted function declarations / top-level consts, only dereferenced at
// runtime — long after all modules have finished evaluating.
import {
  calculateFailChanceBasedOnLoad,
  failOrPark,
  flashMoney,
  getUpkeepMultiplier,
  notifySilentFail,
  removeRequest,
  updateScore,
} from "../core/actions.js";
import { addInterventionWarning } from "../core/events.js";
// Failure taxonomy (#156): the load/health roll is the "Overloaded" lesson —
// unless the request had already burned its retry, which teaches a different
// one. Attribution only; see the contract in core/failure-reasons.js.
import { FAIL_REASONS } from "../core/failure-reasons.js";
// Per-type job processing lives in the handler registry (#155 PR 9):
// one file per service type + the shared fallback. See the control-flow
// contract in src/sim/handlers/index.js.
import { SERVICE_HANDLERS, genericForward } from "../sim/handlers/index.js";
import { chargeServerlessInvocation } from "../sim/handlers/serverless.js";
// Auto-Scaling Group (#195): fleet state, the scaling loop and the satellite
// meshes live in src/sim/autoscaling.js — Service only seeds the state, calls
// the loop once per frame, and folds the instance count into capacity/upkeep.
import {
  disposeSatellites,
  initAutoscaling,
  refreshSatellites,
  updateAutoscaling,
  upkeepInstanceFactor,
} from "../sim/autoscaling.js";
// Resilience (#196): breaker state lives on the service, the state machine
// lives in src/sim/circuit-breaker.js, and the one-retry hook in
// src/sim/retry.js. Service seeds the state, ticks the breaker once per frame,
// and records exactly one outcome per dispatched job.
import {
    initBreaker,
    isRoutable,
    recordBreakerFailure,
    recordBreakerSuccess,
    updateBreaker,
} from "../sim/circuit-breaker.js";
import { retryRequest } from "../sim/retry.js";
// Sandbox archetypes, batch 1 (#197). The DLQ auto-drain and the Scheduler
// self-injection are source/sink behaviors that do not fit the job-dispatch
// registry, so they are ticked directly from update() — same pattern as the
// SQS pull loop and the API Gateway rate-counter reset already here.
import { tickDLQ } from "../sim/dlq.js";
import { tickScheduler } from "../sim/scheduler.js";
// Stream (#198): the ordered-partition / head-of-line-blocking mechanic. Like
// the DLQ drain and Scheduler source, it is ticked directly from update()
// rather than run through the job-dispatch registry.
import { tickStream } from "../sim/stream.js";
// The AI Wave (#87): the GPU batch engine and the Inference Gateway's
// deadline queue — two more tick-nodes on the stream/dlq/scheduler pattern,
// ticked from update() and skipped by processQueue().
import { initGpu, startModelLoad, tickGpu } from "../sim/gpu.js";
import { initInfgw, tickInfgw } from "../sim/infgw.js";
import { serviceGroup } from "../../game.js";

export class Service {
  constructor(type, pos) {
    this.id = "svc_" + Math.random().toString(36).substr(2, 9);
    this.type = type;
    this.config = CONFIG.services[type];
    this.position = pos.clone();
    this.queue = [];
    this.processing = [];
    this.connections = [];
    this.incomingCount = 0;
    // Achievements (#158): true ONLY for services placed through the normal
    // createService path (the player's own click). Campaign pre-builds,
    // save restores, retry rebuilds and shared-arch rebuilds all construct
    // outside that path (or opt out), so architecture-variety polls never
    // grant for a board the player did not build this session.
    this.playerPlaced = false;

    let geo, mat;
    const materialProps = { roughness: 0.2 };

    switch (type) {
      case "waf":
        geo = new THREE.BoxGeometry(3, 2, 0.5);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.waf,
          ...materialProps,
        });
        break;
      case "alb":
        geo = new THREE.BoxGeometry(3, 1.5, 3);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.alb,
          roughness: 0.1,
        });
        break;
      case "compute":
        geo = new THREE.CylinderGeometry(1.2, 1.2, 3, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.compute,
          ...materialProps,
        });
        break;
      case "db":
        geo = new THREE.CylinderGeometry(2, 2, 2, 6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.db,
          roughness: 0.3,
        });
        break;
      case "s3":
        geo = new THREE.CylinderGeometry(1.8, 1.5, 1.5, 8);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.s3,
          ...materialProps,
        });
        break;
      case "cache":
        geo = new THREE.BoxGeometry(2.5, 1.5, 2.5);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.cache,
          ...materialProps,
        });
        break;
      case "sqs":
        geo = new THREE.BoxGeometry(4, 0.8, 2);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.sqs,
          ...materialProps,
        });
        break;
      case "cdn":
        geo = new THREE.SphereGeometry(1.5, 16, 16);
        mat = new THREE.MeshStandardMaterial({
          color: 0x4ade80, // Greenish for static
          ...materialProps,
          wireframe: true,
        });
        break;
      case "apigw":
        geo = new THREE.OctahedronGeometry(1.5, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.apigw,
          ...materialProps,
        });
        break;
      case "nosql":
        geo = new THREE.CylinderGeometry(2, 2, 1.5, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.nosql,
          roughness: 0.3,
        });
        break;
      case "search":
        geo = new THREE.DodecahedronGeometry(1.5, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.search,
          ...materialProps,
        });
        break;
      case "replica":
        geo = new THREE.CylinderGeometry(1.8, 1.8, 1, 6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.replica,
          roughness: 0.3,
        });
        break;
      case "serverless":
        geo = new THREE.TetrahedronGeometry(1.8, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.serverless,
          ...materialProps,
        });
        break;
      case "monitor":
        // Observability (#194): teal torus — a "lens" watching the grid.
        geo = new THREE.TorusGeometry(1.3, 0.4, 8, 24);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.monitor,
          ...materialProps,
        });
        break;
      // ===== Sandbox archetypes, batch 1 (#197) — distinct shapes =====
      case "dlq":
        // Stone slab, sunk low — a bin where dead letters pile up.
        geo = new THREE.BoxGeometry(3, 1, 2);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.dlq,
          roughness: 0.6,
        });
        break;
      case "pubsub":
        // Indigo broadcast horn (cone) — fan-out to many subscribers.
        geo = new THREE.ConeGeometry(1.6, 2.4, 4);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.pubsub,
          ...materialProps,
        });
        break;
      case "auth":
        // Gold shield slab — an identity gate on the path.
        geo = new THREE.BoxGeometry(2.5, 2.5, 0.6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.auth,
          ...materialProps,
        });
        break;
      case "scheduler":
        // Sky-blue clock face (flat disc).
        geo = new THREE.CylinderGeometry(1.5, 1.5, 0.4, 24);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.scheduler,
          ...materialProps,
        });
        break;
      case "notify":
        // Rose bell (inverted cone).
        geo = new THREE.ConeGeometry(1.4, 1.8, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.notify,
          ...materialProps,
        });
        break;
      // ===== Sandbox archetypes, batch 2 (#198) — distinct shapes =====
      case "container":
        // Kubernetes-blue solid cube — a dense box of packed capacity.
        geo = new THREE.BoxGeometry(2.6, 2.6, 2.6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.container,
          ...materialProps,
        });
        break;
      case "stream":
        // Teal flat ribbon — an ordered flow of records.
        geo = new THREE.BoxGeometry(4.6, 0.7, 1.5);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.stream,
          ...materialProps,
        });
        break;
      case "dns":
        // Lime solid globe — a resolver in front of the world.
        geo = new THREE.SphereGeometry(1.5, 16, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.dns,
          ...materialProps,
        });
        break;
      case "warehouse":
        // Amber wide low block — a big cold analytics store.
        geo = new THREE.BoxGeometry(3.6, 1.5, 3.4);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.warehouse,
          roughness: 0.4,
        });
        break;
      // ===== The AI Wave (#87) — distinct shapes =====
      case "gpu":
        // Fuchsia server rack, tall and dense — the batch engine.
        geo = new THREE.BoxGeometry(2.2, 3.2, 2.2);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.gpu,
          ...materialProps,
        });
        break;
      case "infgw":
        // Deep-fuchsia six-sided funnel — the dispatcher in front of the racks.
        geo = new THREE.ConeGeometry(1.3, 2.2, 6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.infgw,
          ...materialProps,
        });
        break;
      case "power":
        // Yellow tapering pylon — the substation feeding the racks.
        geo = new THREE.CylinderGeometry(0.5, 1.6, 2.8, 4);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.power,
          roughness: 0.5,
        });
        break;
    }

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);

    if (type === "waf") this.mesh.position.y += 1;
    else if (type === "alb") this.mesh.position.y += 0.75;
    else if (type === "compute") this.mesh.position.y += 1.5;
    else if (type === "s3") this.mesh.position.y += 0.75;
    else if (type === "cache") this.mesh.position.y += 0.75;
    else if (type === "sqs") this.mesh.position.y += 0.4;
    else if (type === "cdn") this.mesh.position.y += 1.5;
    else if (type === "apigw") this.mesh.position.y += 1.5;
    else if (type === "nosql") this.mesh.position.y += 1;
    else if (type === "search") this.mesh.position.y += 1.5;
    else if (type === "replica") this.mesh.position.y += 1;
    else if (type === "serverless") this.mesh.position.y += 1.5;
    else if (type === "monitor") this.mesh.position.y += 1.7;
    else if (type === "dlq") this.mesh.position.y += 0.5;
    else if (type === "pubsub") this.mesh.position.y += 1.2;
    else if (type === "auth") this.mesh.position.y += 1.25;
    else if (type === "scheduler") this.mesh.position.y += 0.2;
    else if (type === "notify") this.mesh.position.y += 0.9;
    else if (type === "container") this.mesh.position.y += 1.3;
    else if (type === "stream") this.mesh.position.y += 0.35;
    else if (type === "dns") this.mesh.position.y += 1.5;
    else if (type === "warehouse") this.mesh.position.y += 0.75;
    else if (type === "gpu") this.mesh.position.y += 1.6;
    else if (type === "infgw") this.mesh.position.y += 1.1;
    else if (type === "power") this.mesh.position.y += 1.4;
    else this.mesh.position.y += 1;

    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData = { id: this.id };

    const ringGeo = new THREE.RingGeometry(2.5, 2.7, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    this.loadRing = new THREE.Mesh(ringGeo, ringMat);
    this.loadRing.rotation.x = -Math.PI / 2;
    this.loadRing.position.y = -this.mesh.position.y + 0.1;
    this.mesh.add(this.loadRing);

    this.tier = 1;
    this.tierRings = [];
    this.rrIndex = 0;

    // ASG state (#195). Seeded for every type: non-compute services keep
    // asgEnabled false / instances 1, which makes every instance-aware
    // formula below a no-op for them.
    initAutoscaling(this);

    // Circuit-breaker state (#196). Seeded for every type — a closed breaker
    // is invisible, and it keeps isRoutable() free of null checks.
    initBreaker(this);

    // The AI Wave (#87): the GPU's batch/model state (a fresh GPU cold-starts
    // its model load right here) and the gateway's deadline array.
    if (type === "gpu") initGpu(this);
    else if (type === "infgw") initInfgw(this);

    // Service health for degradation mechanic
    this.health = 100;
    this.originalColor = mat.color.getHex();

    // Health bar (3D bar above service)
    this.createHealthBar();

    // SQS queue fill indicator
    if (type === "sqs") {
      const fillGeo = new THREE.BoxGeometry(3.8, 0.6, 1.8);
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.3,
      });
      this.queueFill = new THREE.Mesh(fillGeo, fillMat);
      this.queueFill.position.set(0, 0, 0);
      this.queueFill.scale.x = 0;
      this.mesh.add(this.queueFill);
    }

    serviceGroup.add(this.mesh);
  }

  upgrade() {
    if (!["compute", "db", "cache", "apigw", "nosql", "search", "replica", "gpu"].includes(this.type)) return;
    const tiers = CONFIG.services[this.type].tiers;
    if (this.tier >= tiers.length) return;

    const nextTier = tiers[this.tier];
    if (STATE.money < nextTier.cost) {
      flashMoney();
      return;
    }

    STATE.money -= nextTier.cost;
    // Track upgrade costs in finances
    if (STATE.finances) {
      STATE.finances.expenses.services += nextTier.cost;
      STATE.finances.expenses.byService[this.type] =
        (STATE.finances.expenses.byService[this.type] || 0) + nextTier.cost;
    }
    this.tier++;
    // Achievements (#158): the no_upgrades counter — bumped strictly AFTER
    // the affordability check passed and the tier actually moved (the early
    // returns above never count). Reset per level in CampaignController
    // .loadLevel; only ever read at level win.
    if (STATE.campaign) {
      STATE.campaign.upgradesPerformed = (STATE.campaign.upgradesPerformed || 0) + 1;
    }
    this.config = { ...this.config, capacity: nextTier.capacity };

    // Update cacheHitRate for cache type
    if (this.type === "cache" && nextTier.cacheHitRate) {
      this.config = { ...this.config, cacheHitRate: nextTier.cacheHitRate };
    }

    // Update rateLimit for apigw type
    if (this.type === "apigw" && nextTier.rateLimit) {
      this.config = { ...this.config, rateLimit: nextTier.rateLimit };
    }

    // GPU tiers are MODEL SIZE (#87): bigger batches, lower bad-answer risk,
    // a longer model load — and the upgrade RE-TRIGGERS that load, so an
    // upgrade mid-surge is a self-inflicted outage. The bounded intake
    // follows the batch size.
    if (this.type === "gpu") {
      this.config = {
        ...this.config,
        batchSize: nextTier.batchSize,
        qualityRisk: nextTier.qualityRisk,
        loadTimeSec: nextTier.loadTimeSec,
        maxQueueSize: nextTier.batchSize,
      };
      startModelLoad(this);
    }

    STATE.sound.playPlace();

    // Visuals
    let ringSize, ringColor;
    if (this.type === "db") {
      ringSize = 2.2;
      ringColor = 0xff0000;
    } else if (this.type === "cache") {
      ringSize = 1.5;
      ringColor = 0xdc382d; // Redis red
    } else if (this.type === "apigw") {
      ringSize = 1.5;
      ringColor = 0xe879f9;
    } else if (this.type === "nosql") {
      ringSize = 2.0;
      ringColor = 0x7c3aed;
    } else if (this.type === "search") {
      ringSize = 1.5;
      ringColor = 0x06b6d4;
    } else if (this.type === "replica") {
      ringSize = 1.8;
      ringColor = 0xf472b6;
    } else if (this.type === "gpu") {
      ringSize = 1.6;
      ringColor = 0xd946ef;
    } else {
      ringSize = 1.3;
      ringColor = 0xffff00;
    }

    const ringGeo = new THREE.TorusGeometry(ringSize, 0.1, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: ringColor });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    // Tier rings
    ring.position.y = -this.mesh.position.y + (this.tier === 2 ? 0.5 : 1.0);
    this.mesh.add(ring);
    this.tierRings.push(ring);
  }

  processQueue() {
    // Stream (#198) manages its own queue entirely in tickStream (queue ->
    // partitions -> heads forward), so it must NOT feed the normal processing
    // pipeline — otherwise records would be pulled out of order into
    // this.processing behind the partition model's back.
    if (this.type === "stream") return;
    // GPU / Inference Gateway (#87) are tick-nodes the same way: tickGpu
    // batches straight out of this.queue and tickInfgw owns its deadline
    // array — feeding this.processing would run their requests through the
    // per-job pipeline behind the batch/deadline model's back.
    if (this.type === "gpu" || this.type === "infgw") return;

    const effectiveCapacity = this.getEffectiveCapacity();
    while (
      this.processing.length < effectiveCapacity &&
      this.queue.length > 0
    ) {
      const req = this.queue.shift();

      if (this.type === "waf" && req.type === TRAFFIC_TYPES.MALICIOUS) {
        updateScore(req, "MALICIOUS_BLOCKED");
        // Must go through removeRequest (not raw destroy) — otherwise the blocked
        // request stays in STATE.requests forever and is ticked every frame. This
        // fires on every WAF block (a large fraction of all traffic), so raw
        // destroy() leaked the request array unbounded over a session.
        removeRequest(req);
        continue;
      }

      // Auth / Identity (#197): a second security layer on the pass-through
      // path. It catches a FRACTION (catchRate) of the MALICIOUS traffic that
      // reached it — the session-based attacks a WAF alone misses. What it does
      // NOT catch falls through to processing and is forwarded downstream, where
      // it eventually breaches (that is the "slips past" lesson). The latency
      // cost is the node's high processingTime, paid by every request it passes.
      if (this.type === "auth" && req.type === TRAFFIC_TYPES.MALICIOUS) {
        if (Math.random() < (this.config.catchRate ?? 0.5)) {
          updateScore(req, "MALICIOUS_BLOCKED");
          removeRequest(req);
          continue;
        }
      }

      this.processing.push({ req: req, timer: 0 });
    }
  }

  findConnectedService(serviceType) {
    // Skip services that are not routable — disabled (e.g. during a
    // SERVICE_OUTAGE event) or with an open circuit breaker (#196) — so
    // routing falls through to a healthy alternative instead of stalling
    // traffic on a node with 0 effective capacity or a dying one. Otherwise
    // the redundancy the player built (the whole point of the High
    // Availability level) does nothing.
    return STATE.services.find(
      (s) => this.connections.includes(s.id) && s.type === serviceType && isRoutable(s)
    );
  }

  forwardToDestination(req) {
    const destType = req.destination;
    const target = this.findConnectedService(destType);
    if (target) {
      req.flyTo(target);
      return true;
    }
    return false;
  }

  update(dt) {
    // Service degradation mechanic
    if (CONFIG.survival.degradation?.enabled && STATE.gameMode === "survival") {
      const degradeConfig = CONFIG.survival.degradation;
      const load = this.totalLoad;

      // Always degrade when handling any traffic, faster at higher loads
      if (load > 0.05) {
        // Base decay + load-based acceleration
        const loadMultiplier = 0.5 + load * 1.5; // 0.5x at low load, 2x at full load
        const degradeAmount =
          degradeConfig.healthDecayRate * loadMultiplier * dt;
        this.health = Math.max(0, this.health - degradeAmount);
      } else if (degradeConfig.autoRepairRate > 0 && this.health < 100) {
        // Auto-repair when idle (only if enabled)
        this.health = Math.min(
          100,
          this.health + degradeConfig.autoRepairRate * dt
        );
      }

      // Update visual appearance based on health
      this.updateHealthVisual();
    }

    // API Gateway rate counter reset
    if (this.type === "apigw") {
      this.rateTimer = (this.rateTimer || 0) + dt;
      if (this.rateTimer >= 1.0) {
        this.rateCounter = 0;
        this.rateTimer -= 1.0;
      }
    }

    // ASG (#195): grow/shrink the fleet before capacity is read this frame.
    // The type/enabled gate lives inside updateAutoscaling.
    updateAutoscaling(this, dt);

    // Circuit breaker (#196): only the open -> half-open cooldown needs a
    // clock; every other transition is event-driven. Gate lives inside.
    updateBreaker(this, dt);

    // Sandbox archetypes (#197): source/sink behaviors that sit OUTSIDE the
    // job-dispatch pipeline. The DLQ drains its parked backlog; the Scheduler
    // injects its own timed traffic. Both use the game-scaled dt, so both
    // freeze at timeScale 0 exactly like every other timer here.
    if (this.type === "dlq") tickDLQ(this, dt);
    else if (this.type === "scheduler") tickScheduler(this, dt);
    // Stream (#198): the ordered-partition mechanic. It drains this.queue into
    // its partitions and forwards heads itself, entirely outside the
    // processQueue/processing pipeline (which processQueue skips for a stream).
    else if (this.type === "stream") tickStream(this, dt);
    // The AI Wave (#87): the GPU batch engine and the gateway's
    // sweep-then-dispatch deadline queue — same tick-node treatment.
    else if (this.type === "gpu") tickGpu(this, dt);
    else if (this.type === "infgw") tickInfgw(this, dt);

    if (STATE.upkeepEnabled) {
      const multiplier =
        typeof getUpkeepMultiplier === "function" ? getUpkeepMultiplier() : 1.0;
      // Every instance is billed, warming ones included — clouds charge from
      // boot, not from readiness.
      const upkeepCost =
        (this.config.upkeep / 60) * dt * multiplier * upkeepInstanceFactor(this);
      STATE.money -= upkeepCost;
      if (STATE.finances) {
        STATE.finances.expenses.upkeep += upkeepCost;
        STATE.finances.expenses.byService[this.type] =
          (STATE.finances.expenses.byService[this.type] || 0) + upkeepCost;
      }
    }

    // COMPUTE / SERVERLESS / CONTAINER PULL LOGIC
    // Container (#198) is Compute's sibling — it pulls from an upstream Queue
    // the same way so a SQS→Container topology never starves.
    if (this.type === "compute" || this.type === "serverless" || this.type === "container") {
      // Keep the local pipeline full. The upstream SQS does the long-term
      // buffering, but Compute must pull aggressively enough to saturate its
      // own processing slots.
      //
      // The previous logic pulled at most ONE request per frame and only when
      // (queue + inFlight) <= 1. Because a request spends ~0.5s in flight from
      // SQS to Compute, that capped the SQS→Compute path at ~4 req/s no matter
      // how upgraded the Compute was — making the Queue topology strictly worse
      // than a direct ALB link and soft-locking Campaign Level 5 (#170) and
      // degrading late-game Queue setups (#166).
      //
      // New logic: pull until processing + queue + inFlight covers effective
      // capacity plus a small buffer, so the pipeline never starves while
      // requests are in flight.
      const capacity = this.getEffectiveCapacity();
      const pipelineTarget = capacity + 2;
      let freeSlots = pipelineTarget - (this.processing.length + this.queue.length + this.incomingCount);

      if (freeSlots > 0) {
        // Find upstream SQS services
        const upstreamSQS = STATE.services.filter(s =>
          s.type === 'sqs' &&
          s.connections.includes(this.id) &&
          isRoutable(s)
        );

        if (upstreamSQS.length > 0) {
          // Round robin pull across upstream queues until slots are filled
          // or every queue is empty this frame.
          if (typeof this.upstreamRR === 'undefined') this.upstreamRR = 0;

          let emptyStreak = 0;
          while (freeSlots > 0 && emptyStreak < upstreamSQS.length) {
            const idx = this.upstreamRR % upstreamSQS.length;
            const sqs = upstreamSQS[idx];
            this.upstreamRR = (idx + 1) % upstreamSQS.length;

            const req = sqs.popRequest();
            if (req) {
              req.flyTo(this);
              freeSlots--;
              emptyStreak = 0;
            } else {
              emptyStreak++;
            }
          }
        }
      }
    }

    this.processQueue();

    for (let i = this.processing.length - 1; i >= 0; i--) {
      let job = this.processing[i];

      const processingTime =
        this.type === "compute" || this.type === "serverless" || this.type === "container"
          ? this.config.processingTime * job.req.processingWeight
          : this.config.processingTime;

      job.timer += dt * 1000;

      if (job.timer >= processingTime) {
        this.processing.splice(i, 1);

        const failChance = calculateFailChanceBasedOnLoad(this.totalLoad);
        // Increase fail chance when health is low
        const healthPenalty =
          this.health < (CONFIG.survival.degradation?.criticalHealth || 30)
            ? (1 - this.health / 100) * 0.5
            : 0;
        const totalFailChance = Math.min(1, failChance + healthPenalty);
        if (Math.random() < totalFailChance) {
          // Serverless pays per invocation even when the function errors out
          // (no-op for every other type)
          chargeServerlessInvocation(this);
          // Resilience (#196): this is the sim's one genuinely TRANSIENT
          // failure — the node was too loaded or too damaged to finish work it
          // could otherwise have done. So it is both the one signal the
          // breaker trips on and the one place a retry makes sense. The
          // REQUEST is counted only when it finally terminates; retryRequest()
          // returns false unless a healthy alternate route provably exists.
          recordBreakerFailure(this);
          if (this.type === "notify") {
            // Notification overload is SILENT (#197): dissatisfaction, not a
            // scored/sonified failure. No retry, no DLQ — a dropped send is
            // just gone.
            notifySilentFail(job.req, this);
          } else if (!retryRequest(job.req, this)) {
            // Final failure: park it in a wired DLQ (#197) if one exists,
            // otherwise drop it normally. A request that already spent a retry
            // and died anyway is a "Retry failed", not a plain overload —
            // labelling only, both paths fail it identically (#156).
            failOrPark(
              job.req,
              this,
              job.req.retries > 0
                ? FAIL_REASONS.RETRY_FAILED
                : FAIL_REASONS.OVERLOADED
            );
          }
          continue;
        }

        // Per-type job dispatch (#155 PR 9): the strategy registry replaces
        // the old inline if-chain. Handler return values map back onto the
        // exact control flow the chain used — see the contract in
        // src/sim/handlers/index.js.
        const handler = SERVICE_HANDLERS[this.type] || genericForward;
        const outcome = handler(this, job);
        if (outcome === "requeue-next") {
          // Job not consumed (SQS waiting for a compute pull) — put it back
          // at its old index and move on to the next job.
          this.processing.splice(i, 0, job);
          continue;
        }
        if (outcome === "requeue-stop") {
          // Backpressure — put the job back and stop processing this frame.
          this.processing.splice(i, 0, job);
          break;
        }
        // "next": job consumed or forwarded — fall through to the next job.
        //
        // Breaker bookkeeping (#196): this is the single success site. A job
        // that left this node without being failed (failRequest) or shed
        // (throttleRequest) is a healthy outcome, whether it was completed
        // here or forwarded onward — which is the only way a pure forwarding
        // node (ALB, WAF) can ever earn a non-error event and avoid tripping
        // on nothing but routing dead ends.
        if (!job.req.failed && !job.req.throttled) {
          recordBreakerSuccess(this);
        }
        continue;
      }
    }

    if (this.totalLoad > 0.8) {
      this.loadRing.material.color.setHex(0xff0000);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.8;
      }
    } else if (this.totalLoad > 0.5) {
      this.loadRing.material.color.setHex(0xffaa00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.6;
      }
    } else if (this.totalLoad > 0.2) {
      this.loadRing.material.color.setHex(0xffff00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.4;
      }
    } else {
      this.loadRing.material.color.setHex(0x00ff00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.3;
      }
    }

    if (this.type === "sqs" && this.queueFill) {
      const maxQ = this.config.maxQueueSize || 200;
      const fillPercent = this.queue.length / maxQ;
      this.queueFill.scale.x = fillPercent;
      this.queueFill.position.x = (fillPercent - 1) * 1.9;

      if (fillPercent > 0.8) {
        this.queueFill.material.color.setHex(0xff0000);
      } else if (fillPercent > 0.5) {
        this.queueFill.material.color.setHex(0xffaa00);
      } else {
        this.queueFill.material.color.setHex(0x00ff00);
      }
    }
  }

  flashCacheHit() {
    if (!this.mesh) return;
    const originalColor = this.mesh.material.color.getHex();
    this.mesh.material.color.setHex(0x00ff00); // Green flash
    setTimeout(() => {
      this.mesh.material.color.setHex(originalColor);
    }, 100);
  }

  get totalLoad() {
    // Utilization of the READY fleet (#195). With one instance — every
    // service except a scaled-out ASG Compute/Container — this is the original
    // capacity*2 denominator, unchanged.
    //
    // Stream (#198) keeps its backlog in partitions, not in processing/queue,
    // so fold the partition depth in — otherwise a badly backed-up stream would
    // read as idle and never degrade / colour its load ring. The GPU's batch
    // and the Inference Gateway's deadline array (#87) are the same kind of
    // off-pipeline backlog and get the same treatment.
    const partitionDepth = this.partitions
      ? this.partitions.reduce((n, p) => n + p.length, 0)
      : 0;
    const batchDepth = this.batch ? this.batch.length : 0;
    const pendingDepth = this.pending ? this.pending.length : 0;
    return (
      (this.processing.length + this.queue.length + partitionDepth + batchDepth + pendingDepth) /
      (this.config.capacity * (this.instances || 1) * 2)
    );
  }

  destroy() {
    serviceGroup.remove(this.mesh);
    // ASG satellites (#195) are children of this.mesh — drop and dispose them
    // explicitly, the parent's dispose() below does not recurse.
    disposeSatellites(this);
    if (this.tierRings) {
      this.tierRings.forEach((r) => {
        r.geometry.dispose();
        r.material.dispose();
      });
    }
    if (this.healthBarBg) {
      this.healthBarBg.geometry.dispose();
      this.healthBarBg.material.dispose();
    }
    if (this.healthBarFill) {
      this.healthBarFill.geometry.dispose();
      this.healthBarFill.material.dispose();
    }
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  createHealthBar() {
    // Background bar (dark)
    const bgGeo = new THREE.BoxGeometry(3, 0.3, 0.1);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      transparent: true,
      opacity: 0.8,
    });
    this.healthBarBg = new THREE.Mesh(bgGeo, bgMat);
    this.healthBarBg.position.set(0, 2.5, 0);
    this.mesh.add(this.healthBarBg);

    // Fill bar (colored based on health)
    const fillGeo = new THREE.BoxGeometry(2.9, 0.25, 0.12);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.healthBarFill = new THREE.Mesh(fillGeo, fillMat);
    this.healthBarFill.position.set(0, 0, 0.01);
    this.healthBarBg.add(this.healthBarFill);

    // Initially hidden (show when damaged)
    this.healthBarBg.visible = false;
  }

  updateHealthBar() {
    if (!this.healthBarBg || !this.healthBarFill) return;

    // Show health bar when health < 100
    this.healthBarBg.visible = this.health < 100;

    if (this.health >= 100) return;

    // Update fill scale (0 to 1)
    const fillPercent = this.health / 100;
    this.healthBarFill.scale.x = Math.max(0.01, fillPercent);
    this.healthBarFill.position.x = (fillPercent - 1) * 1.45;

    // Update color based on health
    if (this.health < 30) {
      this.healthBarFill.material.color.setHex(0xff0000); // Red
    } else if (this.health < 60) {
      this.healthBarFill.material.color.setHex(0xff8800); // Orange
    } else if (this.health < 80) {
      this.healthBarFill.material.color.setHex(0xffff00); // Yellow
    } else {
      this.healthBarFill.material.color.setHex(0x00ff00); // Green
    }
  }

  updateHealthVisual() {
    if (!this.mesh || !this.mesh.material) return;

    // Update the 3D health bar
    this.updateHealthBar();

    const criticalHealth = CONFIG.survival.degradation?.criticalHealth || 30;

    if (this.health < criticalHealth) {
      // Critical - red tint and pulsing
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      this.mesh.material.color.setHex(0xff0000);
      this.mesh.material.emissive = new THREE.Color(0xff0000);
      this.mesh.material.emissiveIntensity = pulse * 0.3;
    } else if (this.health < 60) {
      // Damaged - orange tint
      this.mesh.material.color.setHex(0xff8800);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    } else if (this.health < 80) {
      // Worn - yellow tint
      const healthRatio = this.health / 100;
      const r =
        (1 - healthRatio) * 255 +
        healthRatio * ((this.originalColor >> 16) & 0xff);
      const g = healthRatio * ((this.originalColor >> 8) & 0xff);
      const b = healthRatio * (this.originalColor & 0xff);
      this.mesh.material.color.setRGB(r / 255, g / 255, b / 255);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    } else {
      // Healthy - original color
      this.mesh.material.color.setHex(this.originalColor);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    }
  }

  repair() {
    if (this.health >= 100) return false;

    const repairConfig = CONFIG.survival.degradation;
    const repairCost = Math.ceil(
      this.config.cost * (repairConfig?.repairCostPercent || 0.15)
    );

    if (STATE.money < repairCost) {
      flashMoney();
      addInterventionWarning(
        i18n.t('repair_need_money', { cost: repairCost }),
        "danger",
        2000
      );
      return false;
    }

    STATE.money -= repairCost;
    if (STATE.finances) {
      STATE.finances.expenses.repairs += repairCost;
      STATE.finances.expenses.byService[this.type] =
        (STATE.finances.expenses.byService[this.type] || 0) + repairCost;
    }
    this.health = 100;
    this.updateHealthVisual();
    STATE.sound?.playPlace();
    return true;
  }

  popRequest() {
    // Try to take from processing list first (these are "ready" or "in-flight" but held back)
    if (this.processing.length > 0) {
      // Taking from the start (index 0) which should be the oldest if we push to end?
      // processing array is likely small for SQS.
      // NOTE: processing contains {req, timer} objects
      const job = this.processing.shift();
      return job.req;
    }

    // If nothing in processing, check the queue
    if (this.queue.length > 0) {
      return this.queue.shift();
    }

    return null;
  }

  getEffectiveCapacity() {
    // Fleet size first (#195): READY instances only — a warming instance
    // contributes nothing until its cold start finishes. Applied before the
    // health / event reductions so those still scale the whole fleet
    // proportionally. instances is 1 for every non-ASG service, so this is a
    // no-op there.
    let capacity = this.config.capacity * (this.instances || 1);

    // Apply health-based reduction
    const criticalHealth = CONFIG.survival.degradation?.criticalHealth || 30;
    if (this.health < criticalHealth) {
      // Linear reduction from critical to 0 health: 100% -> 30% capacity
      const healthRatio = this.health / criticalHealth;
      capacity = Math.max(1, Math.floor(capacity * (0.3 + 0.7 * healthRatio)));
    }

    // Apply temporary capacity reduction from random events
    if (this.tempCapacityReduction && this.tempCapacityReduction < 1) {
      capacity = Math.max(1, Math.floor(capacity * this.tempCapacityReduction));
    }

    // Check if service is disabled
    if (this.isDisabled) {
      return 0;
    }

    return capacity;
  }

  static restore(serviceData, pos) {
    const service = new Service(serviceData.type, pos);
    service.id = serviceData.id;
    service.mesh.userData.id = serviceData.id;

    // ASG (#195): enabled flag + ready fleet size round-trip; warming
    // instances deliberately do NOT — a load is a cold boot of the whole
    // fleet, and resuming a half-finished warmup would be invisible state.
    // Saves that predate ASG have neither field and load as (false, 1).
    if ((service.type === "compute" || service.type === "container") && serviceData.asgEnabled) {
      service.asgEnabled = true;
      const max = CONFIG.autoscaling.maxInstances;
      const min = CONFIG.autoscaling.minInstances;
      const saved = Number(serviceData.instances) || 1;
      service.instances = Math.max(min, Math.min(max, Math.floor(saved)));
      refreshSatellites(service);
    }

    if (serviceData.tier && serviceData.tier > 1) {
      const tiers = CONFIG.services[serviceData.type]?.tiers;
      if (tiers) {
        service.tier = serviceData.tier;
        const tierData = tiers[service.tier - 1];
        if (tierData) {
          service.config = { ...service.config, capacity: tierData.capacity };
          if (tierData.cacheHitRate) {
            service.config = {
              ...service.config,
              cacheHitRate: tierData.cacheHitRate,
            };
          }
          if (tierData.rateLimit) {
            service.config = {
              ...service.config,
              rateLimit: tierData.rateLimit,
            };
          }
          // GPU (#87): tier fields ride along, and the restored model
          // RE-loads at the restored tier's duration — a load is a cold boot,
          // same stance the ASG takes on warming instances above.
          if (serviceData.type === "gpu" && tierData.batchSize) {
            service.config = {
              ...service.config,
              batchSize: tierData.batchSize,
              qualityRisk: tierData.qualityRisk,
              loadTimeSec: tierData.loadTimeSec,
              maxQueueSize: tierData.batchSize,
            };
            startModelLoad(service);
          }
        }

        for (let t = 2; t <= service.tier; t++) {
          let ringSize, ringColor;
          if (service.type === "db") {
            ringSize = 2.2;
            ringColor = 0xff0000;
          } else if (service.type === "cache") {
            ringSize = 1.5;
            ringColor = 0xdc382d;
          } else if (service.type === "apigw") {
            ringSize = 1.5;
            ringColor = 0xe879f9;
          } else if (service.type === "nosql") {
            ringSize = 2.0;
            ringColor = 0x7c3aed;
          } else if (service.type === "search") {
            ringSize = 1.5;
            ringColor = 0x06b6d4;
          } else if (service.type === "replica") {
            ringSize = 1.8;
            ringColor = 0xf472b6;
          } else if (service.type === "gpu") {
            ringSize = 1.6;
            ringColor = 0xd946ef;
          } else {
            ringSize = 1.3;
            ringColor = 0xffff00;
          }
          const ringGeo = new THREE.TorusGeometry(ringSize, 0.1, 8, 32);
          const ringMat = new THREE.MeshBasicMaterial({ color: ringColor });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = -service.mesh.position.y + (t === 2 ? 0.5 : 1.0);
          service.mesh.add(ring);
          service.tierRings.push(ring);
        }
      }
    }

    return service;
  }
}
