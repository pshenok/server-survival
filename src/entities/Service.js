import { CONFIG, TRAFFIC_TYPES } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
// Cyclic imports (game.js / core modules ⇄ Service.js) are safe: these are
// hoisted function declarations / top-level consts, only dereferenced at
// runtime — long after all modules have finished evaluating.
import {
  calculateFailChanceBasedOnLoad,
  failRequest,
  flashMoney,
  getUpkeepMultiplier,
  removeRequest,
  updateScore,
} from "../core/actions.js";
import { addInterventionWarning } from "../core/events.js";
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
    if (!["compute", "db", "cache", "apigw", "nosql", "search", "replica"].includes(this.type)) return;
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
    this.config = { ...this.config, capacity: nextTier.capacity };

    // Update cacheHitRate for cache type
    if (this.type === "cache" && nextTier.cacheHitRate) {
      this.config = { ...this.config, cacheHitRate: nextTier.cacheHitRate };
    }

    // Update rateLimit for apigw type
    if (this.type === "apigw" && nextTier.rateLimit) {
      this.config = { ...this.config, rateLimit: nextTier.rateLimit };
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

    // COMPUTE / SERVERLESS PULL LOGIC
    if (this.type === "compute" || this.type === "serverless") {
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
        this.type === "compute" || this.type === "serverless"
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
          if (!retryRequest(job.req, this)) {
            failRequest(job.req);
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
    // service except a scaled-out ASG Compute — this is the original
    // capacity*2 denominator, unchanged.
    return (
      (this.processing.length + this.queue.length) /
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
    if (service.type === "compute" && serviceData.asgEnabled) {
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
