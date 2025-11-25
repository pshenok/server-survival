
STATE.sound = new SoundService();


const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

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

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

function resetGame(mode = 'survival') {
    STATE.sound.init();
    STATE.sound.playGameBGM();
    STATE.gameMode = mode;
    STATE.money = CONFIG.survival.startBudget;
    STATE.reputation = 100;
    STATE.requestsProcessed = 0;
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.score = { total: 0, web: 0, api: 0, fraudBlocked: 0 };
    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    STATE.timeScale = 0;
    STATE.currentRPS = 0.5;
    STATE.spawnTimer = 0;

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

    // Reset UI
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-pause').classList.add('active');
    document.getElementById('btn-play').classList.add('pulse-green');

    // Update UI displays
    updateScoreUI();

    // Ensure loop is running
    if (!STATE.animationId) {
        animate(performance.now());
    }
}

function restartGame() {
    document.getElementById('modal').classList.add('hidden');
    resetGame();
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
};

function createService(type, pos) {
    if (STATE.money < CONFIG.services[type].cost) { flashMoney(); return; }
    if (STATE.services.find(s => s.position.distanceTo(pos) < 1)) return;
    STATE.money -= CONFIG.services[type].cost;
    STATE.services.push(new Service(type, pos));
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
    else if (t1 === 'alb' && t2 === 'compute') valid = true;
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
        document.getElementById('btn-play').classList.add('pulse-green');
    } else if (s === 1) {
        document.getElementById('btn-play').classList.add('active');
        document.getElementById('btn-play').classList.remove('pulse-green');
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
    if (STATE.activeTool === 'delete' && i.type === 'service') deleteObject(i.id);
    else if (STATE.activeTool === 'connect' && (i.type === 'service' || i.type === 'internet')) {
        if (STATE.selectedNodeId) { createConnection(STATE.selectedNodeId, i.id); STATE.selectedNodeId = null; }
        else { STATE.selectedNodeId = i.id; new Audio('assets/sounds/click-5.mp3').play(); }
    } else if (['waf', 'alb', 'lambda', 'db', 's3'].includes(STATE.activeTool)) {
        if ((STATE.activeTool === 'lambda' && i.type === 'service') || (STATE.activeTool === 'db' && i.type === 'service')) {
            const svc = STATE.services.find(s => s.id === i.id);
            if (svc && ((STATE.activeTool === 'lambda' && svc.type === 'compute') || (STATE.activeTool === 'db' && svc.type === 'db'))) {
                svc.upgrade();
                return;
            }
        }
        if (i.type === 'ground') {
            createService({ 'waf': 'waf', 'alb': 'alb', 'lambda': 'compute', 'db': 'db', 's3': 's3' }[STATE.activeTool], snapToGrid(i.pos));
        }
    }
});

container.addEventListener('mousemove', (e) => {
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
    camera.updateProjectionMatrix();        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        document.getElementById('tooltip').style.display = 'none';
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    const t = document.getElementById('tooltip');
    let cursor = 'default';

    if (i.type === 'service') {
        const s = STATE.services.find(s => s.id === i.id);
        if (s) {
            t.style.display = 'block'; t.style.left = e.clientX + 15 + 'px'; t.style.top = e.clientY + 15 + 'px';

            const load = s.processing.length / s.config.capacity;
            let loadColor = load > 0.8 ? 'text-red-400' : (load > 0.4 ? 'text-yellow-400' : 'text-green-400');

            t.innerHTML = `<strong class="text-blue-300">${s.config.name}</strong> <span class="text-xs text-yellow-400">T${s.tier || 1}</span><br>
            Queue: <span class="${loadColor}">${s.queue.length}</span><br>
            Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;

            // Reset previous highlights
            STATE.services.forEach(svc => {
                if (svc.mesh.material.emissive) svc.mesh.material.emissive.setHex(0x000000);
            });

            if ((STATE.activeTool === 'lambda' && s.type === 'compute') || (STATE.activeTool === 'db' && s.type === 'db')) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = 'pointer';
                    const nextCost = tiers[s.tier].cost;
                    t.innerHTML += `<br><span class="text-green-300 text-xs font-bold">Upgrade: $${nextCost}</span>`;

                    if (s.mesh.material.emissive) s.mesh.material.emissive.setHex(0x333333);
                } else {
                    t.innerHTML += `<br><span class="text-gray-500 text-xs">Max Tier</span>`;
                }
            }
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

container.addEventListener('mouseup', (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = 'default';
    }
});



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

    const totalUpkeep = STATE.services.reduce((sum, s) => sum + s.config.upkeep / 60, 0);
    const upkeepDisplay = document.getElementById('upkeep-display');
    if (upkeepDisplay) upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s`;

    STATE.reputation = Math.min(100, STATE.reputation);
    document.getElementById('rep-bar').style.width = `${Math.max(0, STATE.reputation)}%`;
    document.getElementById('rps-display').innerText = `${STATE.currentRPS.toFixed(1)} req/s`;


    if (STATE.reputation <= 0 || STATE.money <= -1000) {
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