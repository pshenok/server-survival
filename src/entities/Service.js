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
        }

        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.position.copy(pos);

        if (type === 'waf') this.mesh.position.y += 1;
        else if (type === 'alb') this.mesh.position.y += 0.75;
        else if (type === 'compute') this.mesh.position.y += 1.5;
        else if (type === 's3') this.mesh.position.y += 0.75;
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

        serviceGroup.add(this.mesh);
    }

    upgrade() {
        if (!['compute', 'db'].includes(this.type)) return;
        const tiers = CONFIG.services[this.type].tiers;
        if (this.tier >= tiers.length) return;

        const nextTier = tiers[this.tier];
        if (STATE.money < nextTier.cost) { flashMoney(); return; }

        STATE.money -= nextTier.cost;
        this.tier++;
        this.config = { ...this.config, capacity: nextTier.capacity };
        STATE.sound.playPlace();

        // Visuals
        const ringGeo = new THREE.TorusGeometry(this.type === 'db' ? 2.2 : 1.3, 0.1, 8, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: this.type === 'db' ? 0xff0000 : 0xffff00 });
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
        STATE.money -= (this.config.upkeep / 60) * dt;

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

                if (this.type === 'compute') {
                    const requiredType = job.req.type === TRAFFIC_TYPES.API ? 'db' : (job.req.type === TRAFFIC_TYPES.WEB ? 's3' : null);

                    if (requiredType) {
                        const correctTarget = STATE.services.find(s =>
                            this.connections.includes(s.id) && s.type === requiredType
                        );

                        if (correctTarget) {
                            job.req.flyTo(correctTarget);
                        } else {
                            failRequest(job.req);
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
            this.loadRing.material.opacity = 0.8;
        } else if (this.totalLoad > 0.5) {
            this.loadRing.material.color.setHex(0xffaa00);
            this.loadRing.material.opacity = 0.6;
        } else if (this.totalLoad > 0.2) {
            this.loadRing.material.color.setHex(0xffff00);
            this.loadRing.material.opacity = 0.4;
        } else {
            this.loadRing.material.color.setHex(0x00ff00);
            this.loadRing.material.opacity = 0.3;
        }
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
}
