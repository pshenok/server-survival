import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
// Cyclic imports (game.js / core/actions.js ⇄ Request.js) are safe: these are
// hoisted function declarations / top-level consts, only dereferenced at
// runtime — long after all modules have finished evaluating.
import { failRequest } from "../core/actions.js";
// Retry backoff (#196) is ticked here, inside the existing flight model, so a
// pending retry freezes with the game and dies with a reset — see the note in
// src/sim/retry.js.
import { tickRetry } from "../sim/retry.js";
import { recordBreakerFailure } from "../sim/circuit-breaker.js";
import { requestGroup } from "../../game.js";

export class Request {
    constructor(type) {
        this.id = Math.random().toString(36);
        // Spawn stamp for latency metrics (#194) — set here rather than in
        // spawnRequest so sandbox bursts and test-injected requests get
        // latency attribution too.
        this.spawnedAt = performance.now();
        this.type = type;
        this.typeConfig = CONFIG.trafficTypes[type];
        this.value = this.typeConfig.reward;
        this.cached = false;

        const color = this.typeConfig.color;

        const geo = new THREE.SphereGeometry(0.4, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: color });
        this.mesh = new THREE.Mesh(geo, mat);

        this.mesh.position.copy(STATE.internetNode.position);
        this.mesh.position.y = 2;
        requestGroup.add(this.mesh);

        this.target = null;
        // Resilience (#196): retry bookkeeping. `retries` is capped by
        // CONFIG.resilience.maxRetries; retryDelay > 0 means the request is
        // sitting out its backoff and is not in flight.
        this.retries = 0;
        this.retryDelay = 0;
        this.retryTarget = null;
        this.failed = false;
        this.throttled = false;
        this.origin = STATE.internetNode.position.clone();
        this.origin.y = 2;
        this.progress = 0;
        this.isMoving = false;
    }

    get isCacheable() {
        return this.typeConfig.cacheable && !this.cached;
    }

    get cacheHitRate() {
        return this.typeConfig.cacheHitRate;
    }

    get destination() {
        return this.typeConfig.destination;
    }

    get processingWeight() {
        return this.typeConfig.processingWeight;
    }

    flyTo(service) {
        this.origin.copy(this.mesh.position);
        this.target = service;
        this.progress = 0;
        this.isMoving = true;

        if (this.target && typeof this.target.incomingCount === 'number') {
            this.target.incomingCount++;
        }
    }

    update(dt) {
        // Backoff before a retry (#196): the request hovers at the node that
        // dropped it until the delay expires, then flies to the peer (or is
        // failed if that peer is gone). Always terminates — see retry.js.
        if (tickRetry(this, dt)) return;

        if (this.isMoving && this.target) {
            this.progress += dt * 2;
            if (this.progress >= 1) {
                this.progress = 1;
                this.isMoving = false;
                this.mesh.position.copy(this.target.position);
                this.mesh.position.y = 2;

                if (this.target && typeof this.target.incomingCount === 'number') {
                    this.target.incomingCount = Math.max(0, this.target.incomingCount - 1);
                }

                // Use service-specific max queue size
                const maxQueue = this.target.config.maxQueueSize || 20;
                if (this.target.queue.length < maxQueue) {
                    this.target.queue.push(this);
                } else {
                    // Overflow drop (#196): one of the two genuine "this node
                    // is failing" signals the breaker listens to — the target
                    // is so backed up it cannot even accept the request.
                    recordBreakerFailure(this.target);
                    failRequest(this);
                }
            } else {
                const dest = this.target.position.clone();
                dest.y = 2;
                this.mesh.position.lerpVectors(this.origin, dest, this.progress);
                this.mesh.position.y += Math.sin(this.progress * Math.PI) * 2;
            }
        }
    }

    destroy() {
        requestGroup.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();

        if (this.isMoving && this.target && typeof this.target.incomingCount === 'number') {
            this.target.incomingCount = Math.max(0, this.target.incomingCount - 1);
        }
    }
}
