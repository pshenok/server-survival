STATE.sound = new SoundService();

// ==================== BALANCE OVERHAUL FUNCTIONS ====================

function calculateTargetRPS(gameTimeSeconds) {
    // Logarithmic curve: fast growth early, plateaus later
    // At 0s: 0.5, at 60s: ~2.5, at 180s: ~4, at 300s: ~5, at 600s: ~6.5
    const base = CONFIG.survival.baseRPS;
    const growth = Math.log(1 + gameTimeSeconds / 30) * 1.8;
    return base + growth;
}

function getUpkeepMultiplier() {
    if (STATE.gameMode !== 'survival') return 1.0;
    if (!CONFIG.survival.upkeepScaling.enabled) return 1.0;

    // Use simulated elapsed time so timeScale affects upkeep ramp
    const gameTime = STATE.elapsedGameTime ?? ((performance.now() - STATE.gameStartTime) / 1000);
    const progress = Math.min(gameTime / CONFIG.survival.upkeepScaling.scaleTime, 1.0);

    const base = CONFIG.survival.upkeepScaling.baseMultiplier;
    const max = CONFIG.survival.upkeepScaling.maxMultiplier;

    // Smooth curve from base to max
    return base + (max - base) * progress;
}

function updateFraudSpike(dt) {
    if (STATE.gameMode !== 'survival') return;
    if (!CONFIG.survival.fraudSpike.enabled) return;

    STATE.fraudSpikeTimer += dt;

    const interval = CONFIG.survival.fraudSpike.interval;
    const duration = CONFIG.survival.fraudSpike.duration;
    const warning = CONFIG.survival.fraudSpike.warningTime;

    const cycleTime = STATE.fraudSpikeTimer % interval;

    // Warning phase
    if (cycleTime >= interval - warning && cycleTime < interval - warning + dt && !STATE.fraudSpikeActive) {
        showFraudWarning();
    }

    // Start spike
    if (cycleTime < dt && STATE.fraudSpikeTimer > warning) {
        startFraudSpike();
    }

    // End spike
    if (STATE.fraudSpikeActive && cycleTime >= duration && cycleTime < duration + dt) {
        endFraudSpike();
    }
}

function showFraudWarning() {
    const existing = document.getElementById('fraud-warning');
    if (existing) existing.remove();

    // Visual warning
    const warning = document.createElement('div');
    warning.id = 'fraud-warning';
    warning.className = 'fixed top-1/3 left-1/2 transform -translate-x-1/2 text-center z-50 pointer-events-none';
    warning.innerHTML = `
        <div class="text-red-500 text-2xl font-bold animate-pulse">⚠️ DDoS INCOMING ⚠️</div>
        <div class="text-red-300 text-sm">Fraud spike in 5 seconds!</div>
    `;
    document.body.appendChild(warning);

    STATE.sound.playTone(400, 'sawtooth', 0.3);
    STATE.sound.playTone(300, 'sawtooth', 0.3, 0.15);

    setTimeout(() => warning.remove(), 4000);
}

function startFraudSpike() {
    const existing = document.getElementById('fraud-spike-indicator');
    if (existing) existing.remove();

    STATE.fraudSpikeActive = true;

    // Store normal distribution
    STATE.normalTrafficDist = { ...STATE.trafficDistribution };

    // Apply spike distribution
    const fraudPct = CONFIG.survival.fraudSpike.fraudPercent;
    const remaining = 1 - fraudPct;
    STATE.trafficDistribution = {
        WEB: remaining * 0.5,
        API: remaining * 0.5,
        FRAUD: fraudPct
    };

    // Visual indicator
    const indicator = document.createElement('div');
    indicator.id = 'fraud-spike-indicator';
    indicator.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 z-40 pointer-events-none';
    indicator.innerHTML = `
        <div class="bg-red-900/80 border-2 border-red-500 rounded-lg px-4 py-2 animate-pulse">
            <span class="text-red-400 font-bold">🔥 DDoS ATTACK ACTIVE 🔥</span>
        </div>
    `;
    document.body.appendChild(indicator);

    // Update mix display
    const fraudEl = document.getElementById('mix-fraud');
    if (fraudEl) fraudEl.className = 'text-red-500 font-bold animate-pulse';
}

function endFraudSpike() {
    STATE.fraudSpikeActive = false;

    // Restore normal distribution
    if (STATE.normalTrafficDist) {
        STATE.trafficDistribution = { ...STATE.normalTrafficDist };
        STATE.normalTrafficDist = null;
    }

    // Remove indicator
    const indicator = document.getElementById('fraud-spike-indicator');
    if (indicator) indicator.remove();

    // Reset mix display styling
    const fraudEl = document.getElementById('mix-fraud');
    if (fraudEl) fraudEl.className = 'text-purple-400';

    STATE.sound.playSuccess();
}

// ==================== END BALANCE OVERHAUL FUNCTIONS ====================

const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

let isDraggingNode = false;
let draggedNode = null;
let dragOffset = new THREE.Vector3();

const aspect = window.innerWidth / window.innerHeight;
const d = 50;
const camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
const cameraTarget = new THREE.Vector3(0, 0, 0);
let isIsometric = true;
resetCamera()

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
const internetMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x00ffff, emissiveIntensity: 0.7, roughness: 0.2 });
const internetMesh = new THREE.Mesh(internetGeo, internetMat);
internetMesh.position.copy(STATE.internetNode.position);
internetMesh.castShadow = true;
internetMesh.receiveShadow = true;
scene.add(internetMesh);
STATE.internetNode.mesh = internetMesh;

const intRingGeo = new THREE.RingGeometry(7, 7.2, 32);
const intRingMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
const internetRing = new THREE.Mesh(intRingGeo, intRingMat);
internetRing.rotation.x = -Math.PI / 2;
internetRing.position.set(internetMesh.position.x, -internetMesh.position.y + 0.1, internetMesh.position.z);
scene.add(internetRing);
STATE.internetNode.ring = internetRing;


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

function resetGame(mode = 'survival') {
    STATE.sound.init();
    STATE.sound.playGameBGM();
    STATE.gameMode = mode;

    // Set budget based on mode
    if (mode === 'sandbox') {
        STATE.sandboxBudget = CONFIG.sandbox.defaultBudget;
        STATE.money = STATE.sandboxBudget;
        STATE.upkeepEnabled = CONFIG.sandbox.upkeepEnabled;
        STATE.trafficDistribution = {
            WEB: CONFIG.sandbox.trafficDistribution.WEB / 100,
            API: CONFIG.sandbox.trafficDistribution.API / 100,
            FRAUD: CONFIG.sandbox.trafficDistribution.FRAUD / 100
        };
        STATE.burstCount = CONFIG.sandbox.defaultBurstCount;
        STATE.currentRPS = CONFIG.sandbox.defaultRPS;
    } else {
        STATE.money = CONFIG.survival.startBudget;
        STATE.upkeepEnabled = true;
        STATE.trafficDistribution = { ...CONFIG.survival.trafficDistribution };
        STATE.currentRPS = 0.5;
    }

    STATE.reputation = 100;
    STATE.requestsProcessed = 0;
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.score = { total: 0, web: 0, api: 0, fraudBlocked: 0 };
    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    STATE.timeScale = 0;
    STATE.spawnTimer = 0;

    // Initialize balance overhaul state
    STATE.elapsedGameTime = 0;
    STATE.gameStartTime = performance.now();
    STATE.fraudSpikeTimer = 0;
    STATE.fraudSpikeActive = false;
    STATE.normalTrafficDist = null;

    // Remove any leftover fraud spike indicators
    const fraudWarning = document.getElementById('fraud-warning');
    if (fraudWarning) fraudWarning.remove();
    const fraudIndicator = document.getElementById('fraud-spike-indicator');
    if (fraudIndicator) fraudIndicator.remove();

    // Clear visual elements
    while (serviceGroup.children.length > 0) {
        serviceGroup.remove(serviceGroup.children[0]);
    }
    while (connectionGroup.children.length > 0) {
        connectionGroup.remove(connectionGroup.children[0]);
    }
    while (requestGroup.children.length > 0) {
        requestGroup.remove(requestGroup.children[0]);
    }
    STATE.internetNode.connections = [];
    STATE.internetNode.position.set(
        CONFIG.internetNodeStartPos.x,
        CONFIG.internetNodeStartPos.y,
        CONFIG.internetNodeStartPos.z
    );
    STATE.internetNode.mesh.position.set(
        CONFIG.internetNodeStartPos.x,
        CONFIG.internetNodeStartPos.y,
        CONFIG.internetNodeStartPos.z
    );

    // Reset UI
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-pause').classList.add('active');
    // Only add pulse-green if tutorial is not active
    if (!window.tutorial?.isActive) {
        document.getElementById('btn-play').classList.add('pulse-green');
    }

    // Update UI displays
    updateScoreUI();

    // Mark game as started
    STATE.gameStarted = true;

    // Show/hide sandbox panel and objectives panel based on mode
    const sandboxPanel = document.getElementById('sandboxPanel');
    const objectivesPanel = document.getElementById('objectivesPanel');

    if (mode === 'sandbox') {
        // Show sandbox panel, hide objectives
        if (sandboxPanel) {
            sandboxPanel.classList.remove('hidden');
            // Sync sandbox UI controls
            syncInput('budget', STATE.sandboxBudget);
            syncInput('rps', STATE.currentRPS);
            syncInput('web', STATE.trafficDistribution.WEB * 100);
            syncInput('api', STATE.trafficDistribution.API * 100);
            syncInput('fraud', STATE.trafficDistribution.FRAUD * 100);
            syncInput('burst', STATE.burstCount);
            // Reset upkeep toggle button
            const upkeepBtn = document.getElementById('upkeep-toggle');
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled ? 'Upkeep: ON' : 'Upkeep: OFF';
                upkeepBtn.classList.toggle('bg-red-900/50', STATE.upkeepEnabled);
                upkeepBtn.classList.toggle('bg-green-900/50', !STATE.upkeepEnabled);
            }
        }
        if (objectivesPanel) objectivesPanel.classList.add('hidden');
    } else {
        // Show objectives, hide sandbox panel
        if (sandboxPanel) sandboxPanel.classList.add('hidden');
        if (objectivesPanel) objectivesPanel.classList.remove('hidden');
    }

    // Ensure loop is running
    if (!STATE.animationId) {
        animate(performance.now());
    }
}

function restartGame() {
    document.getElementById('modal').classList.add('hidden');
    resetGame(STATE.gameMode);
}

// Initial setup - show menu, don't start game loop yet
setTimeout(() => {
    showMainMenu();
}, 100);


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
    const dist = STATE.trafficDistribution;
    const total = dist.WEB + dist.API + dist.FRAUD;
    if (total === 0) return TRAFFIC_TYPES.WEB;
    const r = Math.random() * total;
    if (r < dist.WEB) return TRAFFIC_TYPES.WEB;
    if (r < dist.WEB + dist.API) return TRAFFIC_TYPES.API;
    return TRAFFIC_TYPES.FRAUD;
}

function spawnRequest() {
    const type = getTrafficType();
    const req = new Request(type);
    STATE.requests.push(req);
    const conns = STATE.internetNode.connections;
    if (conns.length > 0) {
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
        STATE.sound.playFraudBlocked();
    } else if (req.type === TRAFFIC_TYPES.FRAUD && outcome === 'FRAUD_PASSED') {
        STATE.reputation += points.FRAUD_PASSED_REPUTATION;
        console.warn(`FRAUD PASSED: ${points.FRAUD_PASSED_REPUTATION} Rep. (Critical Failure)`);
    } else if (outcome === 'COMPLETED') {
        if (req.type === TRAFFIC_TYPES.WEB) {
            STATE.score.web += points.WEB_SCORE;
            STATE.score.total += points.WEB_SCORE;
            STATE.money += points.WEB_REWARD;
        } else if (req.type === TRAFFIC_TYPES.API) {
            STATE.score.api += points.API_SCORE;
            STATE.score.total += points.API_SCORE;
            STATE.money += points.API_REWARD;
        }
    } else if (outcome === 'FAILED') {
        STATE.reputation += points.FAIL_REPUTATION;
        STATE.score.total -= (req.type === TRAFFIC_TYPES.API ? points.API_SCORE : points.WEB_SCORE) / 2;
    }

    updateScoreUI();
}

function finishRequest(req) {
    STATE.requestsProcessed++;
    updateScore(req, 'COMPLETED');
    removeRequest(req);
}

function failRequest(req) {
    const failType = req.type === TRAFFIC_TYPES.FRAUD ? 'FRAUD_PASSED' : 'FAILED';
    updateScore(req, failType);
    STATE.sound.playFail();
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

function showMainMenu() {
    // Ensure sound is initialized if possible (browsers might block until interaction)
    if (!STATE.sound.ctx) STATE.sound.init();
    STATE.sound.playMenuBGM();

    document.getElementById('main-menu-modal').classList.remove('hidden');
    document.getElementById('faq-modal').classList.add('hidden');
    document.getElementById('modal').classList.add('hidden');

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById('load-btn');
    const hasSave = localStorage.getItem('serverSurvivalSave') !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? 'block' : 'none';
    }
}

let faqSource = 'menu'; // 'menu' or 'game'

window.showFAQ = (source = 'menu') => {
    faqSource = source;
    // If called from button (onclick="showFAQ()"), it defaults to 'menu' effectively unless we change the HTML.
    // But wait, the button in index.html just calls showFAQ(). 
    // We can check if main menu is visible.

    if (!document.getElementById('main-menu-modal').classList.contains('hidden')) {
        faqSource = 'menu';
        document.getElementById('main-menu-modal').classList.add('hidden');
    } else {
        faqSource = 'game';
    }

    document.getElementById('faq-modal').classList.remove('hidden');
};

window.closeFAQ = () => {
    document.getElementById('faq-modal').classList.add('hidden');
    if (faqSource === 'menu') {
        document.getElementById('main-menu-modal').classList.remove('hidden');
    }
};

window.startGame = () => {
    document.getElementById('main-menu-modal').classList.add('hidden');
    resetGame();

    // Start tutorial for new players in survival mode
    if (window.tutorial && !window.tutorial.isCompleted()) {
        setTimeout(() => {
            window.tutorial.start();
        }, 500);
    }
};

window.startSandbox = () => {
    document.getElementById('main-menu-modal').classList.add('hidden');
    resetGame('sandbox');
};

function createService(type, pos) {
    if (STATE.money < CONFIG.services[type].cost) { flashMoney(); return; }
    if (STATE.services.find(s => s.position.distanceTo(pos) < 1)) return;
    STATE.money -= CONFIG.services[type].cost;
    STATE.services.push(new Service(type, pos));
    STATE.sound.playPlace();

    // Notify tutorial
    if (window.tutorial?.isActive) {
        window.tutorial.onAction('place', { type });
    }
}

function restoreService(serviceData, pos) {
    const service = Service.restore(serviceData, pos);
    STATE.services.push(service);
    STATE.sound.playPlace();
}

function createConnection(fromId, toId) {
    if (fromId === toId) return;
    const getEntity = (id) => id === 'internet' ? STATE.internetNode : STATE.services.find(s => s.id === id);
    const from = getEntity(fromId), to = getEntity(toId);
    if (!from || !to || from.connections.includes(toId)) return;

    let valid = false;
    const t1 = from.type, t2 = to.type;

    if (t1 === 'internet' && (t2 === 'waf' || t2 === 'alb')) valid = true;
    else if (t1 === 'waf' && t2 === 'alb') valid = true;
    else if (t1 === 'waf' && t2 === 'sqs') valid = true;
    else if (t1 === 'sqs' && t2 === 'alb') valid = true;
    else if (t1 === 'alb' && t2 === 'sqs') valid = true;
    else if (t1 === 'sqs' && t2 === 'compute') valid = true;
    else if (t1 === 'alb' && t2 === 'compute') valid = true;
    else if (t1 === 'compute' && t2 === 'cache') valid = true;
    else if (t1 === 'cache' && (t2 === 'db' || t2 === 's3')) valid = true;
    else if (t1 === 'compute' && (t2 === 'db' || t2 === 's3')) valid = true;

    if (!valid) {
        new Audio('assets/sounds/click-9.mp3').play();
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
    STATE.sound.playConnect();

    // Notify tutorial
    if (window.tutorial?.isActive) {
        window.tutorial.onAction('connect', {
            from: fromId,
            fromType: t1,
            toType: t2
        });
    }
}

function deleteConnection(fromId, toId) {
    const getEntity = (id) => id === 'internet' ? STATE.internetNode : STATE.services.find(s => s.id === id);
    const from = getEntity(fromId);
    if (!from) return false;

    // Check if connection exists
    if (!from.connections.includes(toId)) return false;

    // Remove from service connections array
    from.connections = from.connections.filter(c => c !== toId);

    // Find and remove the visual mesh
    const conn = STATE.connections.find(c => c.from === fromId && c.to === toId);
    if (conn) {
        connectionGroup.remove(conn.mesh);
        conn.mesh.geometry.dispose();
        conn.mesh.material.dispose();
        STATE.connections = STATE.connections.filter(c => c !== conn);
    }

    STATE.sound.playDelete();
    return true;
}

function getConnectionAtPoint(clientX, clientY) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    // Get the click point on the ground plane
    const clickPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, clickPoint);
    clickPoint.y = 1; // Lines are at y=1

    // Check each connection for proximity to click
    const threshold = 2; // Distance threshold for clicking on a line

    for (const conn of STATE.connections) {
        const from = (conn.from === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === conn.from);
        const to = (conn.to === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === conn.to);

        if (!from || !to) continue;

        const p1 = new THREE.Vector3(from.position.x, 1, from.position.z);
        const p2 = new THREE.Vector3(to.position.x, 1, to.position.z);

        // Calculate distance from point to line segment
        const line = new THREE.Line3(p1, p2);
        const closestPoint = new THREE.Vector3();
        line.closestPointToPoint(clickPoint, true, closestPoint);

        const distance = clickPoint.distanceTo(closestPoint);

        if (distance < threshold) {
            return conn;
        }
    }

    return null;
}

function deleteObject(id) {
    const svc = STATE.services.find(s => s.id === id);
    if (!svc) return;

    STATE.services.forEach(s => s.connections = s.connections.filter(c => c !== id));
    STATE.internetNode.connections = STATE.internetNode.connections.filter(c => c !== id);
    const toRemove = STATE.connections.filter(c => c.from === id || c.to === id);
    toRemove.forEach(c => connectionGroup.remove(c.mesh));
    STATE.connections = STATE.connections.filter(c => !toRemove.includes(c));

    svc.destroy();
    STATE.services = STATE.services.filter(s => s.id !== id);
    STATE.money += Math.floor(svc.config.cost / 2);
    STATE.sound.playDelete();
}

/**
 * Calculates the percentage if failure based on the load of the node.
 * @param {number} load fractions of 1 (0 to 1) of how loaded the node is
 * @returns {number} chance of failure (0 to 1)
 */
function calculateFailChanceBasedOnLoad(load) {
    if (load <= 0.5) return 0;
    return 2 * (load - 0.5);
}

window.setTool = (t) => {
    STATE.activeTool = t; STATE.selectedNodeId = null;
    document.querySelectorAll('.service-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tool-${t}`).classList.add('active');
    new Audio('assets/sounds/click-9.mp3').play();
};

window.setTimeScale = (s) => {
    STATE.timeScale = s;
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));

    if (s === 0) {
        document.getElementById('btn-pause').classList.add('active');
        // Only add pulse-green if tutorial is not active
        if (!window.tutorial?.isActive) {
            document.getElementById('btn-play').classList.add('pulse-green');
        }
    } else if (s === 1) {
        document.getElementById('btn-play').classList.add('active');
        document.getElementById('btn-play').classList.remove('pulse-green');

        // Notify tutorial when game starts
        if (window.tutorial?.isActive) {
            window.tutorial.onAction('start_game');
        }
    } else if (s === 3) {
        document.getElementById('btn-fast').classList.add('active');
        document.getElementById('btn-play').classList.remove('pulse-green');
    }
};

window.toggleMute = () => {
    const muted = STATE.sound.toggleMute();
    const icon = document.getElementById('mute-icon');
    const menuIcon = document.getElementById('menu-mute-icon');

    const iconText = muted ? '🔇' : '🔊';
    if (icon) icon.innerText = iconText;
    if (menuIcon) menuIcon.innerText = iconText;

    const muteBtn = document.getElementById('tool-mute');
    const menuMuteBtn = document.getElementById('menu-mute-btn'); // We need to add ID to menu button

    if (muted) {
        muteBtn.classList.add('bg-red-900');
        muteBtn.classList.add('pulse-green');
        if (menuMuteBtn) menuMuteBtn.classList.add('pulse-green');
    } else {
        muteBtn.classList.remove('bg-red-900');
        muteBtn.classList.remove('pulse-green');
        if (menuMuteBtn) menuMuteBtn.classList.remove('pulse-green');
    }
};

container.addEventListener('contextmenu', (e) => e.preventDefault());

container.addEventListener('mousedown', (e) => {
    if (!STATE.isRunning) return;

    if (e.button === 2 || e.button === 1) {
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        container.style.cursor = 'grabbing';
        e.preventDefault();
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    if (STATE.activeTool === 'select') {
        const i = getIntersect(e.clientX, e.clientY);
        if (i.type === 'service') { draggedNode = STATE.services.find(s => s.id === i.id); }
        else if (i.type === 'internet') { draggedNode = STATE.internetNode; }
        if (draggedNode) {
            isDraggingNode = true;
            const hit = getIntersect(e.clientX, e.clientY);
            if (hit.pos) { dragOffset.copy(draggedNode.position).sub(hit.pos); }
            container.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }
    }
    else if (STATE.activeTool === 'delete' && i.type === 'service') deleteObject(i.id);
    else if (STATE.activeTool === 'unlink') {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            deleteConnection(conn.from, conn.to);
        } else {
            new Audio('assets/sounds/click-9.mp3').play();
        }
    }
    else if (STATE.activeTool === 'connect' && (i.type === 'service' || i.type === 'internet')) {
        if (STATE.selectedNodeId) { createConnection(STATE.selectedNodeId, i.id); STATE.selectedNodeId = null; }
        else { STATE.selectedNodeId = i.id; new Audio('assets/sounds/click-5.mp3').play(); }
    } else if (['waf', 'alb', 'lambda', 'db', 's3', 'sqs', 'cache'].includes(STATE.activeTool)) {
        // Handle upgrades for compute, db, and cache
        if ((STATE.activeTool === 'lambda' && i.type === 'service') ||
            (STATE.activeTool === 'db' && i.type === 'service') ||
            (STATE.activeTool === 'cache' && i.type === 'service')) {
            const svc = STATE.services.find(s => s.id === i.id);
            if (svc && ((STATE.activeTool === 'lambda' && svc.type === 'compute') ||
                (STATE.activeTool === 'db' && svc.type === 'db') ||
                (STATE.activeTool === 'cache' && svc.type === 'cache'))) {
                svc.upgrade();
                return;
            }
        }
        if (i.type === 'ground') {
            const typeMap = {
                'waf': 'waf',
                'alb': 'alb',
                'lambda': 'compute',
                'db': 'db',
                's3': 's3',
                'sqs': 'sqs',
                'cache': 'cache'
            };
            createService(typeMap[STATE.activeTool], snapToGrid(i.pos));
        }
    }
});

container.addEventListener('mousemove', (e) => {
    if (isDraggingNode && draggedNode) {
        const hit = getIntersect(e.clientX, e.clientY);
        if (hit.pos) {
            const newPos = hit.pos.clone().add(dragOffset);
            newPos.y = 0;

            draggedNode.position.copy(newPos);

            if (draggedNode.mesh) {
                draggedNode.mesh.position.x = newPos.x;
                draggedNode.mesh.position.z = newPos.z;
            } else {
                STATE.internetNode.mesh.position.x = newPos.x;
                STATE.internetNode.mesh.position.z = newPos.z;
                STATE.internetNode.ring.position.x = newPos.x;
                STATE.internetNode.ring.position.z = newPos.z;
            }

            updateConnectionsForNode(draggedNode.id);

            container.style.cursor = 'grabbing';
        }
        return;
    }
    if (isPanning) {
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;

        const panX = -dx * (camera.right - camera.left) / window.innerWidth * panSpeed;
        const panY = dy * (camera.top - camera.bottom) / window.innerHeight * panSpeed;

        if (isIsometric) {
            camera.position.x += panX;
            camera.position.z += panY;
            cameraTarget.x += panX;
            cameraTarget.z += panY;
            camera.lookAt(cameraTarget);
        } else {
            camera.position.x += panX;
            camera.position.z += panY;
            camera.lookAt(camera.position.x, 0, camera.position.z);
        }
        camera.updateProjectionMatrix(); lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        document.getElementById('tooltip').style.display = 'none';
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    const t = document.getElementById('tooltip');
    let cursor = 'default';

    // Reset all connection colors first
    STATE.connections.forEach(c => {
        if (c.mesh && c.mesh.material) {
            c.mesh.material.color.setHex(CONFIG.colors.line);
        }
    });

    // Handle unlink tool hover
    if (STATE.activeTool === 'unlink') {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            cursor = 'pointer';
            // Highlight the connection in red
            if (conn.mesh && conn.mesh.material) {
                conn.mesh.material.color.setHex(0xff4444);
            }

            // Get source and target names for tooltip
            const from = (conn.from === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === conn.from);
            const to = (conn.to === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === conn.to);
            const fromName = conn.from === 'internet' ? 'Internet' : (from?.config?.name || 'Unknown');
            const toName = conn.to === 'internet' ? 'Internet' : (to?.config?.name || 'Unknown');

            showTooltip(e.clientX + 15, e.clientY + 15,
                `<strong class="text-orange-400">Remove Link</strong><br>
                <span class="text-gray-300">${fromName}</span> → <span class="text-gray-300">${toName}</span><br>
                <span class="text-red-400 text-xs">Click to remove</span>`
            );
        } else {
            t.style.display = 'none';
        }
        container.style.cursor = cursor;
        return;
    }

    if (i.type === 'service') {
        const s = STATE.services.find(s => s.id === i.id);
        if (s) {
            const load = s.processing.length / s.config.capacity;
            let loadColor = load > 0.8 ? 'text-red-400' : (load > 0.4 ? 'text-yellow-400' : 'text-green-400');

            // Base tooltip content with static info
            let content = `<strong class="text-blue-300">${s.config.name}</strong>`;
            if (s.tier) content += ` <span class="text-xs text-yellow-400">T${s.tier}</span>`;

            // Add static description and upkeep if available
            if (s.config.tooltip) {
                content += `<br><span class="text-xs text-gray-400">${s.config.tooltip.desc}</span>`;
                content += `<br><span class="text-xs text-gray-500">Upkeep: <span class="text-gray-300">${s.config.tooltip.upkeep}</span></span>`;
            }

            content += `<div class="mt-1 border-t border-gray-700 pt-1">`;

            // Service-specific dynamic stats
            if (s.type === 'cache') {
                const hitRate = Math.round((s.config.cacheHitRate || 0.35) * 100);
                content += `Queue: <span class="${loadColor}">${s.queue.length}</span><br>
                Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                Hit Rate: <span class="text-green-400">${hitRate}%</span>`;
            } else if (s.type === 'sqs') {
                const maxQ = s.config.maxQueueSize || 200;
                const fillPercent = Math.round((s.queue.length / maxQ) * 100);
                const status = fillPercent > 80 ? 'Critical' : (fillPercent > 50 ? 'Busy' : 'Healthy');
                const statusColor = fillPercent > 80 ? 'text-red-400' : (fillPercent > 50 ? 'text-yellow-400' : 'text-green-400');
                content += `Buffered: <span class="${loadColor}">${s.queue.length}/${maxQ}</span><br>
                Processing: ${s.processing.length}/${s.config.capacity}<br>
                Status: <span class="${statusColor}">${status}</span>`;
            } else {
                content += `Queue: <span class="${loadColor}">${s.queue.length}</span><br>
                Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;
            }
            content += `</div>`;

            // Show upgrade option for upgradeable services
            if ((STATE.activeTool === 'lambda' && s.type === 'compute') ||
                (STATE.activeTool === 'db' && s.type === 'db') ||
                (STATE.activeTool === 'cache' && s.type === 'cache')) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = 'pointer';
                    const nextCost = tiers[s.tier].cost;
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-green-300 text-xs font-bold">Upgrade: $${nextCost}</span></div>`;
                    if (s.mesh.material.emissive) s.mesh.material.emissive.setHex(0x333333);
                } else {
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-gray-500 text-xs">Max Tier</span></div>`;
                }
            }

            showTooltip(e.clientX + 15, e.clientY + 15, content);

            // Reset previous highlights
            STATE.services.forEach(svc => {
                if (svc !== s && svc.mesh.material.emissive) svc.mesh.material.emissive.setHex(0x000000);
            });
        }
    } else {
        t.style.display = 'none';
        // Reset highlights when not hovering service
        STATE.services.forEach(svc => {
            if (svc.mesh.material.emissive) svc.mesh.material.emissive.setHex(0x000000);
        });
    }

    container.style.cursor = cursor;
});

// Helper function for showing tooltips
function showTooltip(x, y, html) {
    const t = document.getElementById('tooltip');
    t.style.display = 'block';
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    t.innerHTML = html;
}

// Setup UI tooltips
function setupUITooltips() {
    const tools = ['waf', 'sqs', 'alb', 'lambda', 'db', 'cache', 's3'];
    tools.forEach(toolId => {
        const btn = document.getElementById(`tool-${toolId}`);
        if (!btn) return;

        // Map tool ID to config service key
        const serviceKey = toolId === 'lambda' ? 'compute' : toolId;
        const config = CONFIG.services[serviceKey];

        if (config && config.tooltip) {
            btn.addEventListener('mousemove', (e) => {
                const content = `
                    <strong class="text-blue-300">${config.name}</strong> <span class="text-green-400">$${config.cost}</span><br>
                    <span class="text-xs text-gray-400">${config.tooltip.desc}</span><br>
                    <div class="mt-1 pt-1 border-t border-gray-700 flex justify-between text-xs">
                        <span class="text-gray-500">Upkeep: <span class="text-gray-300">${config.tooltip.upkeep}</span></span>
                    </div>
                `;
                showTooltip(e.clientX + 15, e.clientY - 100, content); // Show above the button
            });

            btn.addEventListener('mouseleave', () => {
                document.getElementById('tooltip').style.display = 'none';
            });
        }
    });
}

// Call setup
setupUITooltips();

container.addEventListener('mouseup', (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = 'default';
    }
    if (isDraggingNode && draggedNode) {
        isDraggingNode = false;

        const snapped = snapToGrid(draggedNode.position);

        draggedNode.position.copy(snapped);

        if (draggedNode.mesh) {
            draggedNode.mesh.position.x = snapped.x;
            draggedNode.mesh.position.z = snapped.z;
        } else {
            STATE.internetNode.mesh.position.x = snapped.x;
            STATE.internetNode.mesh.position.z = snapped.z;
            STATE.internetNode.ring.position.x = snapped.x;
            STATE.internetNode.ring.position.z = snapped.z;
        }

        updateConnectionsForNode(draggedNode.id);

        draggedNode = null;
        container.style.cursor = 'default';
        return;
    }
});

function updateConnectionsForNode(nodeId) {
    STATE.connections.forEach(c => {
        if (c.from === nodeId || c.to === nodeId) {
            const from = (c.from === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === c.from);
            const to = (c.to === 'internet') ? STATE.internetNode : STATE.services.find(s => s.id === c.to);

            if (!from || !to) return;

            const pts = [
                new THREE.Vector3(from.position.x, 1, from.position.z),
                new THREE.Vector3(to.position.x, 1, to.position.z)
            ];

            c.mesh.geometry.dispose();
            c.mesh.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        }
    });
}

function animate(time) {
    STATE.animationId = requestAnimationFrame(animate);
    if (!STATE.isRunning) return;

    // Limit dt to prevent huge jumps when tab loses focus
    // (requestAnimationFrame pauses when tab is inactive)
    const rawDt = (time - STATE.lastTime) / 1000;
    const clampedDt = Math.min(rawDt, 0.1); // Max 100ms per frame
    const dt = clampedDt * STATE.timeScale;
    STATE.lastTime = time;
    STATE.elapsedGameTime += dt;

    STATE.services.forEach(s => s.update(dt));
    STATE.requests.forEach(r => r.update(dt));

    STATE.spawnTimer += dt;
    if (STATE.currentRPS > 0 && STATE.spawnTimer > (1 / STATE.currentRPS)) {
        STATE.spawnTimer = 0;
        spawnRequest();
        // Only ramp up in survival mode - use logarithmic growth
        if (STATE.gameMode === 'survival') {
            const gameTime = STATE.elapsedGameTime;
            const targetRPS = calculateTargetRPS(gameTime);

            // Smooth transition to target
            STATE.currentRPS += (targetRPS - STATE.currentRPS) * 0.01;
            STATE.currentRPS = Math.min(STATE.currentRPS, CONFIG.survival.maxRPS);
        }
    }

    // Update fraud spike system
    updateFraudSpike(dt);

    document.getElementById('money-display').innerText = `$${Math.floor(STATE.money)}`;

    const baseUpkeep = STATE.services.reduce((sum, s) => sum + s.config.upkeep / 60, 0);
    const multiplier = typeof getUpkeepMultiplier === 'function' ? getUpkeepMultiplier() : 1.0;
    const totalUpkeep = baseUpkeep * multiplier;
    const upkeepDisplay = document.getElementById('upkeep-display');
    if (upkeepDisplay) {
        if (multiplier > 1.05) {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s (×${multiplier.toFixed(2)})`;
            upkeepDisplay.className = 'text-red-400 font-mono';
        } else {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s`;
            upkeepDisplay.className = 'text-red-400 font-mono';
        }
    }

    // Update traffic mix display
    if (STATE.gameMode === 'survival') {
        const webEl = document.getElementById('mix-web');
        const apiEl = document.getElementById('mix-api');
        const fraudEl = document.getElementById('mix-fraud');
        if (webEl) webEl.textContent = Math.round(STATE.trafficDistribution.WEB * 100) + '%';
        if (apiEl) apiEl.textContent = Math.round(STATE.trafficDistribution.API * 100) + '%';
        if (fraudEl && !STATE.fraudSpikeActive) fraudEl.textContent = Math.round(STATE.trafficDistribution.FRAUD * 100) + '%';
    }

    STATE.reputation = Math.min(100, STATE.reputation);
    document.getElementById('rep-bar').style.width = `${Math.max(0, STATE.reputation)}%`;
    document.getElementById('rps-display').innerText = `${STATE.currentRPS.toFixed(1)} req/s`;

    if (STATE.internetNode.ring) {
        if (STATE.selectedNodeId === 'internet') {
            STATE.internetNode.ring.material.opacity = 1.0;
        } else {
            STATE.internetNode.ring.material.opacity = 0.2;
        }
    }


    // Game over only in survival mode
    if (STATE.gameMode === 'survival' && (STATE.reputation <= 0 || STATE.money <= -1000)) {
        STATE.isRunning = false;
        document.getElementById('modal-title').innerText = "SYSTEM FAILURE";
        document.getElementById('modal-title').classList.add("text-red-500");
        document.getElementById('modal-desc').innerText = `Final Score: ${STATE.score.total}`;
        document.getElementById('modal').classList.remove('hidden');
        STATE.sound.playGameOver();
    }

    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -d * aspect;
    camera.right = d * aspect;
    camera.top = d;
    camera.bottom = -d;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        // Toggle main menu
        const menu = document.getElementById('main-menu-modal');
        if (menu.classList.contains('hidden')) {
            openMainMenu();
        } else if (STATE.gameStarted && STATE.isRunning) {
            resumeGame();
        }
        return;
    }
    if (event.key === 'H' || event.key === 'h') {
        document.getElementById('statsPanel').classList.toggle("hidden");
        document.getElementById('detailsPanel').classList.toggle("hidden");
        document.getElementById('objectivesPanel').classList.toggle("hidden");
    }
    if (event.key === 'R' || event.key === 'r') {
        resetCamera();
    }
    if (event.key === 'T' || event.key === 't') {
        toggleView();
    }
});

function toggleView() {
    isIsometric = !isIsometric;
    resetCamera();
}

function resetCamera() {
    if (isIsometric) {
        camera.position.set(40, 40, 40);
        cameraTarget.set(0, 0, 0);
        camera.lookAt(cameraTarget);
    } else {
        camera.position.set(0, 50, 0);
        camera.lookAt(0, 0, 0);
    }
}

// ==================== SANDBOX MODE FUNCTIONS ====================

function syncInput(name, value) {
    const slider = document.getElementById(`${name}-slider`);
    const input = document.getElementById(`${name}-input`);
    if (slider) slider.value = value;
    if (input) input.value = value;
}

window.setSandboxBudget = (value) => {
    const v = Math.max(0, parseInt(value) || 0);
    STATE.sandboxBudget = v;
    STATE.money = v;
    syncInput('budget', v);
};

window.resetBudget = () => {
    STATE.money = STATE.sandboxBudget;
};

window.setSandboxRPS = (value) => {
    const v = Math.max(0, parseFloat(value) || 0);
    STATE.currentRPS = v;
    syncInput('rps', v);
};

window.setTrafficMix = (type, value) => {
    const v = Math.max(0, Math.min(100, parseFloat(value) || 0));
    STATE.trafficDistribution[type] = v / 100;
    syncInput(type.toLowerCase(), v);
};

window.setBurstCount = (value) => {
    const v = Math.max(1, parseInt(value) || 10);
    STATE.burstCount = v;
    syncInput('burst', v);
};

window.spawnBurst = (type) => {
    for (let i = 0; i < STATE.burstCount; i++) {
        setTimeout(() => {
            const req = new Request(type);
            STATE.requests.push(req);
            const conns = STATE.internetNode.connections;
            if (conns.length > 0) {
                const entryNodes = conns.map(id => STATE.services.find(s => s.id === id));
                const wafEntry = entryNodes.find(s => s?.type === 'waf');
                const target = wafEntry || entryNodes[Math.floor(Math.random() * entryNodes.length)];
                if (target) req.flyTo(target); else failRequest(req);
            } else {
                failRequest(req);
            }
        }, i * 30);
    }
};

window.toggleUpkeep = () => {
    STATE.upkeepEnabled = !STATE.upkeepEnabled;
    const btn = document.getElementById('upkeep-toggle');
    if (btn) {
        btn.textContent = STATE.upkeepEnabled ? 'Upkeep: ON' : 'Upkeep: OFF';
        btn.classList.toggle('bg-red-900/50', STATE.upkeepEnabled);
        btn.classList.toggle('bg-green-900/50', !STATE.upkeepEnabled);
    }
};

window.clearAllServices = () => {
    STATE.services.forEach(s => s.destroy());
    STATE.services = [];
    STATE.connections.forEach(c => connectionGroup.remove(c.mesh));
    STATE.connections = [];
    STATE.internetNode.connections = [];
    STATE.requests.forEach(r => r.destroy());
    STATE.requests = [];
    STATE.money = STATE.sandboxBudget;
};

// ==================== MENU FUNCTIONS ====================

function openMainMenu() {
    // Store current time scale and pause
    STATE.previousTimeScale = STATE.timeScale;
    setTimeScale(0);

    // Hide tutorial while menu is open
    if (window.tutorial?.isActive) {
        window.tutorial.hide();
    }

    // Show resume button if game is active
    const resumeBtn = document.getElementById('resume-btn');
    if (resumeBtn) {
        if (STATE.gameStarted && STATE.isRunning) {
            resumeBtn.classList.remove('hidden');
        } else {
            resumeBtn.classList.add('hidden');
        }
    }

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById('load-btn');
    const hasSave = localStorage.getItem('serverSurvivalSave') !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? 'block' : 'none';
    }

    // Show main menu
    document.getElementById('main-menu-modal').classList.remove('hidden');
    STATE.sound.playMenuBGM();
}

window.resumeGame = () => {
    // Hide main menu, keep game paused
    document.getElementById('main-menu-modal').classList.add('hidden');
    STATE.sound.playGameBGM();

    // Restore tutorial if active
    if (window.tutorial?.isActive) {
        window.tutorial.show();
    }
};

// ==================== SAVE/LOAD FUNCTIONS ====================

window.saveGameState = () => {
    try {
        const saveData = {
            timestamp: Date.now(),
            version: '1.0',
            ...STATE,
            score: { ...STATE.score },
            trafficDistribution: { ...STATE.trafficDistribution },
            services: STATE.services.map(service => ({
                id: service.id,
                type: service.type,
                position: [service.position.x, service.position.y, service.position.z],
                connections: [...service.connections],
                tier: service.tier,
                cacheHitRate: service.config.cacheHitRate || null
            })),
            connections: STATE.connections.map(conn => ({
                from: conn.from,
                to: conn.to
            })),
            requests: [],
            internetConnections: [...STATE.internetNode.connections]
        };

        localStorage.setItem('serverSurvivalSave', JSON.stringify(saveData));

        const saveBtn = document.getElementById('btn-save');
        const originalColor = saveBtn.classList.contains('hover:border-green-500') ? '' : saveBtn.style.borderColor;
        saveBtn.style.borderColor = '#10b981'; // green-500
        saveBtn.style.color = '#10b981';
        setTimeout(() => {
            saveBtn.style.borderColor = originalColor;
            saveBtn.style.color = '';
        }, 1000);

        STATE.sound.playPlace(); // Use place sound as feedback
    } catch (error) {
        console.error('Failed to save game:', error);
        alert('Failed to save game. Please try again.');
    }
};

window.loadGameState = () => {
    try {
        const saveDataStr = localStorage.getItem('serverSurvivalSave');
        if (!saveDataStr) {
            alert('No saved game found.');
            return;
        }

        const saveData = JSON.parse(saveDataStr);

        clearCurrentGame();

        STATE.money = saveData.money || 0;
        STATE.reputation = saveData.reputation || 100;
        STATE.requestsProcessed = saveData.requestsProcessed || 0;
        STATE.score = { ...saveData.score } || { total: 0, web: 0, api: 0, fraudBlocked: 0 };
        STATE.activeTool = saveData.activeTool || 'select';
        STATE.selectedNodeId = saveData.selectedNodeId || null;
        STATE.lastTime = performance.now(); // Reset timing
        STATE.spawnTimer = saveData.spawnTimer || 0;
        STATE.currentRPS = saveData.currentRPS || 0.5;
        STATE.timeScale = saveData.timeScale || 0; // Start paused
        STATE.elapsedGameTime = saveData.elapsedGameTime ?? 0;
        STATE.isRunning = saveData.isRunning || false;
        STATE.gameStartTime = performance.now();

        STATE.gameMode = saveData.gameMode || 'survival';
        STATE.sandboxBudget = saveData.sandboxBudget || 2000;
        STATE.upkeepEnabled = saveData.upkeepEnabled !== false;
        STATE.trafficDistribution = { ...saveData.trafficDistribution } || { WEB: 0.5, API: 0.45, FRAUD: 0.05 };
        STATE.burstCount = saveData.burstCount || 10;
        STATE.gameStarted = saveData.gameStarted || true;
        STATE.previousTimeScale = saveData.previousTimeScale || 1;

        restoreServices(saveData.services);

        restoreConnections(saveData.connections, saveData.internetConnections || []);

        updateScoreUI();
        document.getElementById('money-display').innerText = `$${Math.floor(STATE.money)}`;
        document.getElementById('rep-bar').style.width = `${Math.max(0, STATE.reputation)}%`;
        document.getElementById('rps-display').innerText = `${STATE.currentRPS.toFixed(1)} req/s`;

        const sandboxPanel = document.getElementById('sandboxPanel');
        const objectivesPanel = document.getElementById('objectivesPanel');

        if (STATE.gameMode === 'sandbox') {
            if (sandboxPanel) sandboxPanel.classList.remove('hidden');
            if (objectivesPanel) objectivesPanel.classList.add('hidden');
            syncInput('budget', STATE.sandboxBudget);
            syncInput('rps', STATE.currentRPS);
            syncInput('web', STATE.trafficDistribution.WEB * 100);
            syncInput('api', STATE.trafficDistribution.API * 100);
            syncInput('fraud', STATE.trafficDistribution.FRAUD * 100);
            syncInput('burst', STATE.burstCount);
            const upkeepBtn = document.getElementById('upkeep-toggle');
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled ? 'Upkeep: ON' : 'Upkeep: OFF';
                upkeepBtn.classList.toggle('bg-red-900/50', STATE.upkeepEnabled);
                upkeepBtn.classList.toggle('bg-green-900/50', !STATE.upkeepEnabled);
            }
        } else {
            if (sandboxPanel) sandboxPanel.classList.add('hidden');
            if (objectivesPanel) objectivesPanel.classList.remove('hidden');
        }

        document.getElementById('main-menu-modal').classList.add('hidden');

        if (!STATE.animationId) {
            animate(performance.now());
        }

        STATE.sound.playPlace();

    } catch (error) {
        console.error('Failed to load game:', error);
        alert('Failed to load game. The save file may be corrupted.');
    }
};

function clearCurrentGame() {
    while (serviceGroup.children.length > 0) {
        serviceGroup.remove(serviceGroup.children[0]);
    }
    while (connectionGroup.children.length > 0) {
        connectionGroup.remove(connectionGroup.children[0]);
    }
    while (requestGroup.children.length > 0) {
        requestGroup.remove(requestGroup.children[0]);
    }

    STATE.services.forEach(s => s.destroy());
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.internetNode.connections = [];
}

function restoreServices(savedServices) {
    savedServices.forEach(serviceData => {
        const position = new THREE.Vector3(
            serviceData.position[0],
            serviceData.position[1],
            serviceData.position[2]
        );

        restoreService(serviceData, position);
    });
}

function restoreConnections(savedConnections, internetConnections) {
    internetConnections.forEach(connData => {
        createConnection(connData.from, connData.to);
    });

    savedConnections.forEach(connData => {
        createConnection(connData.from, connData.to);
    });
}
