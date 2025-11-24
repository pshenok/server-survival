class Request {
    constructor(type) {
        this.id = Math.random().toString(36);
        this.value = 10;
        this.type = type;

        let color;
        switch (this.type) {
            case TRAFFIC_TYPES.WEB: color = CONFIG.colors.requestWeb; break;
            case TRAFFIC_TYPES.API: color = CONFIG.colors.requestApi; break;
            case TRAFFIC_TYPES.FRAUD: color = CONFIG.colors.requestFraud; break;
        }

        const geo = new THREE.SphereGeometry(0.4, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: color });
        this.mesh = new THREE.Mesh(geo, mat);

        this.mesh.position.copy(STATE.internetNode.position);
        this.mesh.position.y = 2;
        requestGroup.add(this.mesh);

        this.target = null;
        this.origin = STATE.internetNode.position.clone();
        this.origin.y = 2;
        this.progress = 0;
        this.isMoving = false;
    }

    flyTo(service) {
        this.origin.copy(this.mesh.position);
        this.target = service;
        this.progress = 0;
        this.isMoving = true;
    }

    update(dt) {
        if (this.isMoving && this.target) {
            this.progress += dt * 2;
            if (this.progress >= 1) {
                this.progress = 1;
                this.isMoving = false;
                this.mesh.position.copy(this.target.position);
                this.mesh.position.y = 2;

                if (this.target.queue.length < 20) {
                    this.target.queue.push(this);
                } else {
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
    }
}
