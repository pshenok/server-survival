/**
 * SERVER: Game Logic
 * Single file implementation based on Three.js
 */



// --- ENUMS & CONFIGURATION ---
const TRAFFIC_TYPES = {
    WEB: 'WEB',     // Requires S3 (Simpler, lower reward)
    API: 'API',     // Requires RDS (Complex, higher reward)
    FRAUD: 'FRAUD'  // Must be blocked by WAF
};

const CONFIG = {
    gridSize: 30,
    tileSize: 4,
    colors: {
        bg: 0x050505, grid: 0x1a1a1a,
        alb: 0x3b82f6, compute: 0xf97316,
        db: 0xdc2626, waf: 0xa855f7,
        s3: 0x10b981, line: 0x475569,
        lineActive: 0x38bdf8,
        requestWeb: 0x4ade80, // Green
        requestApi: 0xffa500, // Orange
        requestFraud: 0xff00ff, // Pink
        requestFail: 0xef4444
    },
    services: {
        waf: { name: "WAF Firewall", cost: 50, type: 'waf', processingTime: 20, capacity: 100, upkeep: 1 },
        alb: { name: "Load Balancer", cost: 50, type: 'alb', processingTime: 50, capacity: 50, upkeep: 2 },
        compute: { name: "EC2 Compute", cost: 100, type: 'compute', processingTime: 600, capacity: 5, upkeep: 5 },
        db: { name: "RDS Database", cost: 200, type: 'db', processingTime: 300, capacity: 20, upkeep: 10 },
        s3: { name: "S3 Storage", cost: 25, type: 's3', processingTime: 200, capacity: 100, upkeep: 1 }
    },
    survival: {
        startBudget: 5000,
        baseRPS: 1.0,
        rampUp: 0.005,
        // Traffic Distribution (Must sum to 1.0)
        trafficDistribution: {
            [TRAFFIC_TYPES.WEB]: 0.50, // 50%
            [TRAFFIC_TYPES.API]: 0.35, // 35%
            [TRAFFIC_TYPES.FRAUD]: 0.15 // 15%
        },

        // Score Points based on outcome
        SCORE_POINTS: {
            WEB_COMPLETED: 10,
            API_COMPLETED: 20,
            // BUG FIX: Removed reputation penalty for generic failure (queue overflow, wrong connection)
            FAIL_REPUTATION: 0,
            FRAUD_PASSED_REPUTATION: -10, // Huge rep penalty for passed fraud (CRITICAL FAILURE)
            FRAUD_BLOCKED_SCORE: 25 // High score for WAF success
        }
    }
};

// --- GAME STATE ---
const STATE = {
    money: 0,
    reputation: 0,
    requestsProcessed: 0,

    // New Scoring Variables
    score: {
        total: 0,
        web: 0,
        api: 0,
        fraudBlocked: 0
    },

    activeTool: 'select',
    selectedNodeId: null,
    services: [],
    requests: [],
    connections: [],

    lastTime: 0,
    spawnTimer: 0,
    currentRPS: 0.5,
    timeScale: 1,
    isRunning: true,
    animationId: null,

    internetNode: {
        id: 'internet',
        type: 'internet',
        position: new THREE.Vector3(-40, 0, 0),
        connections: []
    }
};

// --- INIT THREE.JS (Standard Orthographic Setup) ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

const aspect = window.innerWidth / window.innerHeight;
const d = 50;
const camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
camera.position.set(40, 40, 40);
camera.lookAt(scene.position);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(20, 50, 20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(CONFIG.gridSize * CONFIG.tileSize, CONFIG.gridSize, CONFIG.colors.grid, CONFIG.colors.grid);
scene.add(gridHelper);

const serviceGroup = new THREE.Group();
const connectionGroup = new THREE.Group();
const requestGroup = new THREE.Group();
scene.add(serviceGroup);
scene.add(connectionGroup);
scene.add(requestGroup);

const internetGeo = new THREE.BoxGeometry(6, 1, 10);
const internetMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x00ffff, emissiveIntensity: 0.2, roughness: 0.2 });
const internetMesh = new THREE.Mesh(internetGeo, internetMat);
internetMesh.position.copy(STATE.internetNode.position);
internetMesh.castShadow = true;
internetMesh.receiveShadow = true;
scene.add(internetMesh);
STATE.internetNode.mesh = internetMesh;


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Camera panning state
let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

// --- GAME LOGIC ---

function startGame() {
    // Reset State
    STATE.money = CONFIG.survival.startBudget;
    STATE.reputation = 100;
    STATE.requestsProcessed = 0;
    STATE.currentRPS = CONFIG.survival.baseRPS;
    STATE.timeScale = 0; // Start Paused
    STATE.spawnTimer = 0;
    STATE.score = { total: 0, web: 0, api: 0, fraudBlocked: 0 };

    // Reset camera position
    camera.position.set(40, 40, 40);
    camera.lookAt(0, 0, 0);

    // Reset Objects
    STATE.services.forEach(s => s.destroy());
    STATE.services = [];
    STATE.requests.forEach(r => r.destroy());
    STATE.requests = [];
    STATE.connections.forEach(c => connectionGroup.remove(c.mesh));
    STATE.connections = [];
    STATE.internetNode.connections = [];

    // UI Reset
    document.getElementById('modal').classList.add('hidden');
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-pause').classList.add('active'); // Set Pause UI active
    updateScoreUI();

    console.log(`Started Survival Mode (Paused)`);

    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    if (!STATE.animationId) {
        animate(performance.now());
    }

    // Show Onboarding on first load or restart
    showOnboarding();
}

function restartGame() { startGame(); }
setTimeout(() => startGame(), 100);

// --- CLASSES ---

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

        serviceGroup.add(this.mesh);
    }

    processQueue() {
        while (this.processing.length < this.config.capacity && this.queue.length > 0) {
            const req = this.queue.shift();

            // WAF Logic
            if (this.type === 'waf' && req.type === TRAFFIC_TYPES.FRAUD) {
                // WAF blocks fraud
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

                // Check for End of Path (DB or S3)
                if (this.type === 'db' || this.type === 's3') {
                    const expectedType = this.type === 'db' ? TRAFFIC_TYPES.API : TRAFFIC_TYPES.WEB;
                    if (job.req.type === expectedType) {
                        finishRequest(job.req); // Success
                    } else {
                        failRequest(job.req); // Wrong data sink!
                    }
                    continue;
                }

                // FORWARDING LOGIC (ALB, WAF, Compute)

                if (this.type === 'compute') {
                    // Compute routing logic: must deterministically route to DB for API or S3 for WEB
                    const requiredType = job.req.type === TRAFFIC_TYPES.API ? 'db' : (job.req.type === TRAFFIC_TYPES.WEB ? 's3' : null);

                    if (requiredType) {
                        // Find a connected service that matches the required type among ALL connections
                        const correctTarget = STATE.services.find(s =>
                            this.connections.includes(s.id) && s.type === requiredType
                        );

                        if (correctTarget) {
                            job.req.flyTo(correctTarget);
                        } else {
                            // Compute finished, but the correct data sink (RDS or S3) is not connected
                            failRequest(job.req);
                        }
                    } else {
                        // Should only happen if FRAUD traffic reaches compute unblocked
                        failRequest(job.req);
                    }
                } else {
                    // Standard routing for WAF/ALB: Load balance across connected services
                    const nextNodeId = this.connections[Math.floor(Math.random() * this.connections.length)];
                    const nextSvc = STATE.services.find(s => s.id === nextNodeId);

                    if (nextSvc) {
                        job.req.flyTo(nextSvc);
                    } else {
                        // No connection
                        failRequest(job.req);
                    }
                }
            }
        }

        const load = this.processing.length / this.config.capacity;
        if (load > 0.8) this.loadRing.material.color.setHex(0xff0000);
        else if (load > 0.4) this.loadRing.material.color.setHex(0xffff00);
        else this.loadRing.material.color.setHex(0x333333);
    }

    destroy() {
        serviceGroup.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

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

                // Queue overflow check happens here
                if (this.target.queue.length < 20) {
                    this.target.queue.push(this);
                } else {
                    failRequest(this); // Queue overflow
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

// --- HELPERS ---

function getIntersect(clientX, clientY) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(serviceGroup.children, true);
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj.parent && obj.parent !== serviceGroup) obj = obj.parent;
        return { type: 'service', id: obj.userData.id, obj: obj };
    }

    const intInter = raycaster.intersectObject(STATE.internetNode.mesh);
    if (intInter.length > 0) return { type: 'internet', id: 'internet', obj: STATE.internetNode.mesh };

    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    return { type: 'ground', pos: target };
}

function snapToGrid(vec) {
    const s = CONFIG.tileSize;
    return new THREE.Vector3(
        Math.round(vec.x / s) * s,
        0,
        Math.round(vec.z / s) * s
    );
}

function getTrafficType() {
    const r = Math.random();
    const dist = CONFIG.survival.trafficDistribution;
    if (r < dist[TRAFFIC_TYPES.WEB]) return TRAFFIC_TYPES.WEB;
    if (r < dist[TRAFFIC_TYPES.WEB] + dist[TRAFFIC_TYPES.API]) return TRAFFIC_TYPES.API;
    return TRAFFIC_TYPES.FRAUD;
}

function spawnRequest() {
    const type = getTrafficType();
    const req = new Request(type);
    STATE.requests.push(req);
    const conns = STATE.internetNode.connections;
    if (conns.length > 0) {
        // If WAF exists, always route through WAF first if it is the entry point
        const entryNodes = conns.map(id => STATE.services.find(s => s.id === id));
        const wafEntry = entryNodes.find(s => s?.type === 'waf');
        const target = wafEntry || entryNodes[Math.floor(Math.random() * entryNodes.length)];

        if (target) req.flyTo(target); else failRequest(req);
    } else failRequest(req);
}

function updateScore(req, outcome) {
    const points = CONFIG.survival.SCORE_POINTS;

    if (outcome === 'FRAUD_BLOCKED') {
        STATE.score.fraudBlocked += points.FRAUD_BLOCKED_SCORE;
        STATE.score.total += points.FRAUD_BLOCKED_SCORE;
    } else if (req.type === TRAFFIC_TYPES.FRAUD && outcome === 'FRAUD_PASSED') {
        // This is the CRITICAL failure that results in reputation loss
        STATE.reputation += points.FRAUD_PASSED_REPUTATION;
        console.warn(`FRAUD PASSED: ${points.FRAUD_PASSED_REPUTATION} Rep. (Critical Failure)`);
    } else if (outcome === 'COMPLETED') {
        if (req.type === TRAFFIC_TYPES.WEB) {
            STATE.score.web += points.WEB_COMPLETED;
            STATE.score.total += points.WEB_COMPLETED;
            STATE.money += points.WEB_COMPLETED;
        } else if (req.type === TRAFFIC_TYPES.API) {
            STATE.score.api += points.API_COMPLETED;
            STATE.score.total += points.API_COMPLETED;
            STATE.money += points.API_COMPLETED;
        }
    } else if (outcome === 'FAILED') {
        // Common failure (Queue Overflow, Wrong Sink, No Connection).
        // Reputation loss for generic failures is set to 0 in CONFIG.
        STATE.reputation += points.FAIL_REPUTATION; // This is 0 now
        STATE.score.total -= (req.type === TRAFFIC_TYPES.API ? points.API_COMPLETED : points.WEB_COMPLETED) / 2; // Deduct half potential earnings
    }

    updateScoreUI();
}

function finishRequest(req) {
    STATE.requestsProcessed++;
    updateScore(req, 'COMPLETED');
    removeRequest(req);
}

function failRequest(req) {
    // Special check for fraud that bypassed WAF
    if (req.type === TRAFFIC_TYPES.FRAUD) {
        updateScore(req, 'FRAUD_PASSED');
    } else {
        updateScore(req, 'FAILED');
    }
    req.mesh.material.color.setHex(CONFIG.colors.requestFail);
    setTimeout(() => removeRequest(req), 500);
}

function removeRequest(req) {
    req.destroy();
    STATE.requests = STATE.requests.filter(r => r !== req);
}

function updateScoreUI() {
    document.getElementById('total-score-display').innerText = STATE.score.total;
    document.getElementById('score-web').innerText = STATE.score.web;
    document.getElementById('score-api').innerText = STATE.score.api;
    document.getElementById('score-fraud').innerText = STATE.score.fraudBlocked;
}

function flashMoney() {
    const el = document.getElementById('money-display');
    el.classList.add('text-red-500');
    setTimeout(() => el.classList.remove('text-red-500'), 300);
}

// --- ONBOARDING LOGIC ---
function showOnboarding() {
    document.getElementById('onboarding-modal').style.display = 'flex';
    nextOnboardingStep(1);
}

function nextOnboardingStep(step) {
    document.querySelectorAll('.onboarding-step').forEach(el => el.classList.remove('active'));
    document.getElementById(`step-${step}`).classList.add('active');
}

function closeOnboarding() {
    document.getElementById('onboarding-modal').style.display = 'none';

    // If game is paused (which it is on start), highlight the Play button
    if (STATE.timeScale === 0) {
        document.getElementById('btn-play').classList.add('pulse-green');
    }
}

// --- INPUT & ACTIONS ---

function createService(type, pos) {
    if (STATE.money < CONFIG.services[type].cost) { flashMoney(); return; }
    if (STATE.services.find(s => s.position.distanceTo(pos) < 1)) return;
    STATE.money -= CONFIG.services[type].cost;
    STATE.services.push(new Service(type, pos));
}

function createConnection(fromId, toId) {
    if (fromId === toId) return;
    const getEntity = (id) => id === 'internet' ? STATE.internetNode : STATE.services.find(s => s.id === id);
    const from = getEntity(fromId), to = getEntity(toId);
    if (!from || !to || from.connections.includes(toId)) return;

    // Validation: Only specific flows are allowed
    let valid = false;
    const t1 = from.type, t2 = to.type;

    if (t1 === 'internet' && (t2 === 'waf' || t2 === 'alb')) valid = true;
    else if (t1 === 'waf' && t2 === 'alb') valid = true; // WAF -> ALB
    else if (t1 === 'alb' && t2 === 'compute') valid = true; // ALB -> Compute
    // Compute must connect to both DB and S3
    else if (t1 === 'compute' && (t2 === 'db' || t2 === 's3')) valid = true;

    if (!valid) {
	new Audio('assets/sounds/click-9.mp3').play();
        // Using a non-alert message for invalid connections
        console.error("Invalid connection topology: WAF/ALB from Internet -> WAF -> ALB -> Compute -> (RDS/S3)");
        return;
    }
    
    new Audio('assets/sounds/click-5.mp3').play();

    from.connections.push(toId);
    const pts = [from.position.clone(), to.position.clone()];
    pts[0].y = pts[1].y = 1;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: CONFIG.colors.line });
    const line = new THREE.Line(geo, mat);
    connectionGroup.add(line);
    STATE.connections.push({ from: fromId, to: toId, mesh: line });
}

function deleteObject(id) {
    const svc = STATE.services.find(s => s.id === id);
    if (!svc) return;

    // Clean connections
    STATE.services.forEach(s => s.connections = s.connections.filter(c => c !== id));
    STATE.internetNode.connections = STATE.internetNode.connections.filter(c => c !== id);
    const toRemove = STATE.connections.filter(c => c.from === id || c.to === id);
    toRemove.forEach(c => connectionGroup.remove(c.mesh));
    STATE.connections = STATE.connections.filter(c => !toRemove.includes(c));

    svc.destroy();
    STATE.services = STATE.services.filter(s => s.id !== id);
    STATE.money += Math.floor(svc.config.cost / 2);
}


// Input Handlers
window.setTool = (t) => {
    STATE.activeTool = t; STATE.selectedNodeId = null;
    document.querySelectorAll('.service-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tool-${t}`).classList.add('active');
};

window.setTimeScale = (s) => {
    STATE.timeScale = s;
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    if (s === 0) document.getElementById('btn-pause').classList.add('active');
    if (s === 1) {
        document.getElementById('btn-play').classList.add('active');
        document.getElementById('btn-play').classList.remove('pulse-green');
    }
    if (s === 3) document.getElementById('btn-fast').classList.add('active');
};

// --- MOUSE LISTENERS FOR INTERACTION AND CAMERA PANNING ---

container.addEventListener('contextmenu', (e) => e.preventDefault()); // Prevent context menu on right click

container.addEventListener('mousedown', (e) => {
    if (!STATE.isRunning) return;

    // Camera Panning Setup (Right-click or middle-click)
    if (e.button === 2 || e.button === 1) { // 2 = Right, 1 = Middle
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        container.style.cursor = 'grabbing';
        e.preventDefault();
        return;
    }

    // Game Interaction Logic (Left-click only)
    const i = getIntersect(e.clientX, e.clientY);
    if (STATE.activeTool === 'delete' && i.type === 'service') deleteObject(i.id);
    else if (STATE.activeTool === 'connect' && (i.type === 'service' || i.type === 'internet')) {
        if (STATE.selectedNodeId) { createConnection(STATE.selectedNodeId, i.id); STATE.selectedNodeId = null; }
        else { STATE.selectedNodeId = i.id; new Audio('assets/sounds/click-5.mp3').play(); }
    } else if (['waf', 'alb', 'lambda', 'db', 's3'].includes(STATE.activeTool) && i.type === 'ground') {
        createService({ 'waf': 'waf', 'alb': 'alb', 'lambda': 'compute', 'db': 'db', 's3': 's3' }[STATE.activeTool], snapToGrid(i.pos));
    }
});

container.addEventListener('mousemove', (e) => {
    // Tooltip Logic
    const i = getIntersect(e.clientX, e.clientY);
    const t = document.getElementById('tooltip');
    if (i.type === 'service') {
        const s = STATE.services.find(s => s.id === i.id);
        if (s) {
            t.style.display = 'block'; t.style.left = e.clientX + 15 + 'px'; t.style.top = e.clientY + 15 + 'px';

            const load = s.processing.length / s.config.capacity;
            let loadColor = load > 0.8 ? 'text-red-400' : (load > 0.4 ? 'text-yellow-400' : 'text-green-400');

            t.innerHTML = `<strong class="text-blue-300">${s.config.name}</strong><br>
            Queue: <span class="${loadColor}">${s.queue.length}</span><br>
            Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;
        }
    } else if (!isPanning) {
        t.style.display = 'none';
    }


    // Camera Panning Logic (Right-click drag)
    if (isPanning) {
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;

        // Convert screen movement to world movement for Orthographic camera
        // Scaling by camera's view size to keep movement consistent regardless of zoom/aspect ratio
        const panX = -dx * (camera.right - camera.left) / window.innerWidth * panSpeed;
        const panY = dy * (camera.top - camera.bottom) / window.innerHeight * panSpeed;

        // Move the camera position (both X and Z axes)
        camera.position.x += panX;
        camera.position.z += panY;

        // Keep the camera pointing at its new position on the ground plane (Y=0)
        camera.lookAt(camera.position.x, 0, camera.position.z);
        camera.updateProjectionMatrix();

        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    }
});

container.addEventListener('mouseup', (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = 'default';
    }
});


// Game Loop
function animate(time) {
    STATE.animationId = requestAnimationFrame(animate);
    if (!STATE.isRunning) return;

    const dt = ((time - STATE.lastTime) / 1000) * STATE.timeScale;
    STATE.lastTime = time;

    STATE.services.forEach(s => s.update(dt));
    STATE.requests.forEach(r => r.update(dt));

    STATE.spawnTimer += dt;
    if (STATE.spawnTimer > (1 / STATE.currentRPS)) {
        STATE.spawnTimer = 0;
        spawnRequest();
        STATE.currentRPS += CONFIG.survival.rampUp;
    }

    document.getElementById('money-display').innerText = `$${Math.floor(STATE.money)}`;
    STATE.reputation = Math.min(100, STATE.reputation);
    document.getElementById('rep-bar').style.width = `${Math.max(0, STATE.reputation)}%`;
    document.getElementById('rps-display').innerText = `${STATE.currentRPS.toFixed(1)} req/s`;

    // Survival Game Over Check Only
    if (STATE.reputation <= 0 || STATE.money <= -1000) {
        STATE.isRunning = false;
        document.getElementById('modal-title').innerText = "SYSTEM FAILURE";
        document.getElementById('modal-title').classList.add("text-red-500");
        document.getElementById('modal-desc').innerText = `Final Score: ${STATE.score.total}`;
        document.getElementById('modal').classList.remove('hidden');
    }

    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    // Update camera frustum to maintain aspect ratio for orthographic camera
    camera.left = -d * aspect;
    camera.right = d * aspect;
    camera.top = d;
    camera.bottom = -d;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});


