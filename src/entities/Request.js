class Request {
  constructor(type) {
    this.id = Math.random().toString(36);
    this.type = type;
    this.typeConfig = CONFIG.trafficTypes[type];
    this.value = this.typeConfig.reward;
    this.cached = false;

    // Path tracking properties
    this.path = []; // Track the forward path through services
    this.returnPath = []; // Track the return path for responses
    this.currentHopIndex = 0; // Current position in the path

    const color = this.typeConfig.color;

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

  // Record a hop in the request's path
  recordHop(serviceType) {
    this.path.push(serviceType);
  }

  // Set the return path for the response
  setReturnPath(path) {
    this.returnPath = [...path].reverse(); // Reverse for return journey
    this.currentHopIndex = 0; // Reset for return journey
  }

  // Get the next hop in the path (forward or return)
  getNextHop(isReturn = false) {
    const currentPath = isReturn ? this.returnPath : this.path;

    if (this.currentHopIndex < currentPath.length) {
      return currentPath[this.currentHopIndex];
    }
    return null;
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

        // Record the hop in the path
        this.recordHop(this.target.type);

        // Use service-specific max queue size
        const maxQueue = this.target.config.maxQueueSize || 20;
        if (this.target.queue.length < maxQueue) {
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
