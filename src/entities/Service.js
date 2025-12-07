class Service {
    constructor(type, pos) {
        this.id = 'svc_' + Math.random().toString(36).substr(2, 9);
        this.type = type;
        this.config = CONFIG.services[type];
        this.position = pos.clone();
        this.queue = [];
        this.processing = [];
        this.connections = [];

        let geo, mat;
        const materialProps = { roughness: 0.2 };

        switch (type) {
            case 'waf':
                geo = new THREE.BoxGeometry(3, 2, 0.5);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.waf, ...materialProps });
                break;
            case 'alb':
                geo = new THREE.BoxGeometry(3, 1.5, 3);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.alb, roughness: 0.1 });
                break;
            case 'compute':
                geo = new THREE.CylinderGeometry(1.2, 1.2, 3, 16);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.compute, ...materialProps });
                break;
            case 'db':
                geo = new THREE.CylinderGeometry(2, 2, 2, 6);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.db, roughness: 0.3 });
                break;
            case 's3':
                geo = new THREE.CylinderGeometry(1.8, 1.5, 1.5, 8);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.s3, ...materialProps });
                break;
            case 'cache':
                geo = new THREE.BoxGeometry(2.5, 1.5, 2.5);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.cache, ...materialProps });
                break;
            case 'sqs':
                geo = new THREE.BoxGeometry(4, 0.8, 2);
                mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.sqs, ...materialProps });
                break;
        }

        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.position.copy(pos);

        if (type === 'waf') this.mesh.position.y += 1;
        else if (type === 'alb') this.mesh.position.y += 0.75;
        else if (type === 'compute') this.mesh.position.y += 1.5;
        else if (type === 's3') this.mesh.position.y += 0.75;
        else if (type === 'cache') this.mesh.position.y += 0.75;
        else if (type === 'sqs') this.mesh.position.y += 0.4;
        else this.mesh.position.y += 1;

        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.mesh.userData = { id: this.id };

        const ringGeo = new THREE.RingGeometry(2.5, 2.7, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
        this.loadRing = new THREE.Mesh(ringGeo, ringMat);
        this.loadRing.rotation.x = -Math.PI / 2;
        this.loadRing.position.y = -this.mesh.position.y + 0.1;
        this.mesh.add(this.loadRing);

        this.tier = 1;
        this.tierRings = [];
        this.rrIndex = 0;

        // SQS queue fill indicator
        if (type === 'sqs') {
            const fillGeo = new THREE.BoxGeometry(3.8, 0.6, 1.8);
            const fillMat = new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                transparent: true,
                opacity: 0.3
            });
            this.queueFill = new THREE.Mesh(fillGeo, fillMat);
            this.queueFill.position.set(0, 0, 0);
            this.queueFill.scale.x = 0;
            this.mesh.add(this.queueFill);
        }

        serviceGroup.add(this.mesh);
    }

    upgrade() {
        if (!['compute', 'db', 'cache'].includes(this.type)) return;
        const tiers = CONFIG.services[this.type].tiers;
        if (this.tier >= tiers.length) return;

        const nextTier = tiers[this.tier];
        if (STATE.money < nextTier.cost) { flashMoney(); return; }

        STATE.money -= nextTier.cost;
        this.tier++;
        this.config = { ...this.config, capacity: nextTier.capacity };

        // Update cacheHitRate for cache type
        if (this.type === 'cache' && nextTier.cacheHitRate) {
            this.config = { ...this.config, cacheHitRate: nextTier.cacheHitRate };
        }

        STATE.sound.playPlace();

        // Visuals
        let ringSize, ringColor;
        if (this.type === 'db') {
            ringSize = 2.2;
            ringColor = 0xff0000;
        } else if (this.type === 'cache') {
            ringSize = 1.5;
            ringColor = 0xDC382D; // Redis red
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
        while (this.processing.length < this.config.capacity && this.queue.length > 0) {
            const req = this.queue.shift();

            if (this.type === 'waf' && req.type === TRAFFIC_TYPES.FRAUD) {
                updateScore(req, 'FRAUD_BLOCKED');
                req.destroy();
                continue;
            }

            this.processing.push({ req: req, timer: 0 });
        }
    }

    update(dt) {
        if (STATE.upkeepEnabled) {
            const multiplier = typeof getUpkeepMultiplier === 'function' ? getUpkeepMultiplier() : 1.0;
            STATE.money -= (this.config.upkeep / 60) * dt * multiplier;
        }

        this.processQueue();

        for (let i = this.processing.length - 1; i >= 0; i--) {
            let job = this.processing[i];
            job.timer += dt * 1000;

            if (job.timer >= this.config.processingTime) {
                this.processing.splice(i, 1);

                const failChance = calculateFailChanceBasedOnLoad(this.totalLoad);
                if (Math.random() < failChance) {
                    failRequest(job.req);
                    continue;
                }

                if (this.type === 'db' || this.type === 's3') {
                    const expectedType = this.type === 'db' ? TRAFFIC_TYPES.API : TRAFFIC_TYPES.WEB;
                    if (job.req.type === expectedType) {
                        finishRequest(job.req);
                    } else {
                        failRequest(job.req);
                    }
                    continue;
                }

                // Cache processing logic
                if (this.type === 'cache') {
                    const hitRate = this.config.cacheHitRate || 0.35;

                    if (Math.random() < hitRate) {
                        // CACHE HIT - request completes here
                        STATE.sound.playSuccess();
                        this.flashCacheHit();
                        finishRequest(job.req);
                    } else {
                        // CACHE MISS - forward to DB or S3
                        const requiredType = job.req.type === TRAFFIC_TYPES.API ? 'db' :
                            (job.req.type === TRAFFIC_TYPES.WEB ? 's3' : null);

                        if (requiredType) {
                            const target = STATE.services.find(s =>
                                this.connections.includes(s.id) && s.type === requiredType
                            );

                            if (target) {
                                job.req.flyTo(target);
                            } else {
                                failRequest(job.req);
                            }
                        } else {
                            // FRAUD should never reach cache
                            failRequest(job.req);
                        }
                    }
                    continue;
                }

                // SQS processing logic
                if (this.type === 'sqs') {
                    // SQS just forwards requests with backpressure check
                    const downstreamTypes = ['alb', 'compute'];
                    const candidates = this.connections
                        .map(id => STATE.services.find(s => s.id === id))
                        .filter(s => s && downstreamTypes.includes(s.type));

                    if (candidates.length === 0) {
                        failRequest(job.req);
                        continue;
                    }

                    // Round-robin with backpressure check
                    let sent = false;
                    for (let attempt = 0; attempt < candidates.length; attempt++) {
                        const target = candidates[this.rrIndex % candidates.length];
                        this.rrIndex++;

                        // Check if target can accept (has queue space)
                        const targetMaxQueue = target.config.maxQueueSize || 20;
                        if (target.queue.length < targetMaxQueue) {
                            job.req.flyTo(target);
                            sent = true;
                            break;
                        }
                    }

                    if (!sent) {
                        // All downstream busy - put back in OUR queue
                        this.queue.unshift(job.req);
                        this.processing.splice(i, 1);
                        break; // Don't process more this frame
                    }
                    continue;
                }

                if (this.type === 'compute') {
                    const requiredEndpoint = job.req.type === TRAFFIC_TYPES.API ? 'db' :
                        (job.req.type === TRAFFIC_TYPES.WEB ? 's3' : null);

                    if (requiredEndpoint) {
                        // Check if cache is connected (preferred path)
                        const cacheTarget = STATE.services.find(s =>
                            this.connections.includes(s.id) && s.type === 'cache'
                        );

                        if (cacheTarget) {
                            // Route through cache
                            job.req.flyTo(cacheTarget);
                        } else {
                            // Direct to DB/S3 (existing logic)
                            const directTarget = STATE.services.find(s =>
                                this.connections.includes(s.id) && s.type === requiredEndpoint
                            );

                            if (directTarget) {
                                job.req.flyTo(directTarget);
                            } else {
                                failRequest(job.req);
                            }
                        }
                    } else {
                        failRequest(job.req);
                    }
                } else {
                    // Round Robin Load Balancing
                    const candidates = this.connections
                        .map(id => STATE.services.find(s => s.id === id))
                        .filter(s => s !== undefined);

                    if (candidates.length > 0) {
                        const target = candidates[this.rrIndex % candidates.length];
                        this.rrIndex++;
                        job.req.flyTo(target);
                    } else {
                        failRequest(job.req);
                    }
                }
            }
        }

        if (this.totalLoad > 0.8) {
            this.loadRing.material.color.setHex(0xff0000);
            if (STATE.selectedNodeId === this.id) {
                this.loadRing.material.opacity = 1.0;
            }
            else {
                this.loadRing.material.opacity = 0.8;
            };
        } else if (this.totalLoad > 0.5) {
            this.loadRing.material.color.setHex(0xffaa00);
            if (STATE.selectedNodeId === this.id) {
                this.loadRing.material.opacity = 1.0;
            }
            else {
                this.loadRing.material.opacity = 0.6;
            };
        } else if (this.totalLoad > 0.2) {
            this.loadRing.material.color.setHex(0xffff00);
            if (STATE.selectedNodeId === this.id) {
                this.loadRing.material.opacity = 1.0;
            }
            else {
                this.loadRing.material.opacity = 0.4;
            };
        } else {
            this.loadRing.material.color.setHex(0x00ff00);
            if (STATE.selectedNodeId === this.id) {
                this.loadRing.material.opacity = 1.0;
            }
            else {
                this.loadRing.material.opacity = 0.3;
            };
        }

        if (this.type === 'sqs' && this.queueFill) {
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
        return (this.processing.length + this.queue.length) / (this.config.capacity * 2);
    }

    destroy() {
        serviceGroup.remove(this.mesh);
        if (this.tierRings) {
            this.tierRings.forEach(r => {
                r.geometry.dispose();
                r.material.dispose();
            });
        }
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }

    static restore(serviceData, pos) {
        const service = new Service(serviceData.type, pos);
        service.id = serviceData.id;
        service.mesh.userData.id = serviceData.id;

        if (serviceData.tier && serviceData.tier > 1) {
            const tiers = CONFIG.services[serviceData.type]?.tiers;
            if (tiers) {
                service.tier = serviceData.tier;
                const tierData = tiers[service.tier - 1];
                if (tierData) {
                    service.config = { ...service.config, capacity: tierData.capacity };
                    if (tierData.cacheHitRate) {
                        service.config = { ...service.config, cacheHitRate: tierData.cacheHitRate };
                    }
                }
                
                for (let t = 2; t <= service.tier; t++) {
                    let ringSize, ringColor;
                    if (service.type === 'db') {
                        ringSize = 2.2;
                        ringColor = 0xff0000;
                    } else if (service.type === 'cache') {
                        ringSize = 1.5;
                        ringColor = 0xDC382D;
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
