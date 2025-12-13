STATE.sound = new SoundService();

// ==================== UTILITY FUNCTIONS ====================

// Format time as h:m:s, m:s, or just s depending on duration
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);

    if (hours > 0) {
        return `${hours}h ${mins}m ${secs}s`;
    } else if (mins > 0) {
        return `${mins}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// ==================== BALANCE OVERHAUL FUNCTIONS ====================

function calculateTargetRPS(gameTimeSeconds) {
    // Aggressive growth curve for constant engagement
    // Combines logarithmic base with linear acceleration
    const base = CONFIG.survival.baseRPS;
    const logGrowth = Math.log(1 + gameTimeSeconds / 20) * 2.2;
    const linearBoost = gameTimeSeconds * 0.008; // Adds ~0.5 RPS per minute
    let targetRPS = base + logGrowth + linearBoost;

    // Apply milestone acceleration for faster late-game scaling
    if (CONFIG.survival.rpsAcceleration && STATE.intervention) {
        const milestones = CONFIG.survival.rpsAcceleration.milestones;
        let multiplier = 1.0;

        for (let i = 0; i < milestones.length; i++) {
            if (gameTimeSeconds >= milestones[i].time) {
                multiplier = milestones[i].multiplier;
                if (STATE.intervention.currentMilestoneIndex < i + 1) {
                    STATE.intervention.currentMilestoneIndex = i + 1;
                    // Add warning when milestone is reached
                    addInterventionWarning(
                        `⚡ RPS SURGE! Traffic ×${multiplier.toFixed(1)}`,
                        "danger",
                        5000
                    );
                }
            }
        }

        STATE.intervention.rpsMultiplier = multiplier;
        targetRPS *= multiplier;
    }

    return targetRPS;
}

function getUpkeepMultiplier() {
    if (STATE.gameMode !== "survival") return 1.0;
    if (!CONFIG.survival.upkeepScaling.enabled) return 1.0;

    // Use simulated elapsed time so timeScale affects upkeep ramp
    const gameTime =
        STATE.elapsedGameTime ?? (performance.now() - STATE.gameStartTime) / 1000;
    const progress = Math.min(
        gameTime / CONFIG.survival.upkeepScaling.scaleTime,
        1.0
    );

    const base = CONFIG.survival.upkeepScaling.baseMultiplier;
    const max = CONFIG.survival.upkeepScaling.maxMultiplier;

    // Smooth curve from base to max
    let multiplier = base + (max - base) * progress;

    // Apply random event cost spike if active
    if (STATE.intervention?.costMultiplier) {
        multiplier *= STATE.intervention.costMultiplier;
    }

    return multiplier;
}

function updateMaliciousSpike(dt) {
    if (STATE.gameMode !== "survival") return;
    if (!CONFIG.survival.maliciousSpike.enabled) return;

    STATE.maliciousSpikeTimer += dt;

    const interval = CONFIG.survival.maliciousSpike.interval;
    const duration = CONFIG.survival.maliciousSpike.duration;
    const warning = CONFIG.survival.maliciousSpike.warningTime;

    const cycleTime = STATE.maliciousSpikeTimer % interval;

    // Warning phase
    if (
        cycleTime >= interval - warning &&
        cycleTime < interval - warning + dt &&
        !STATE.maliciousSpikeActive
    ) {
        showMaliciousWarning();
    }

    // Start spike
    if (cycleTime < dt && STATE.maliciousSpikeTimer > warning) {
        startMaliciousSpike();
    }

    // End spike
    if (
        STATE.maliciousSpikeActive &&
        cycleTime >= duration &&
        cycleTime < duration + dt
    ) {
        endMaliciousSpike();
    }
}

function showMaliciousWarning() {
    const existing = document.getElementById("malicious-warning");
    if (existing) existing.remove();

    // Visual warning
    const warning = document.createElement("div");
    warning.id = "malicious-warning";
    warning.className =
        "fixed top-1/3 left-1/2 transform -translate-x-1/2 text-center z-50 pointer-events-none";
    warning.innerHTML = `
        <div class="text-red-500 text-2xl font-bold animate-pulse">⚠️ DDoS INCOMING ⚠️</div>
        <div class="text-red-300 text-sm">Attack spike in 5 seconds!</div>
    `;
    document.body.appendChild(warning);

    STATE.sound.playTone(400, "sawtooth", 0.3);
    STATE.sound.playTone(300, "sawtooth", 0.3, 0.15);

    setTimeout(() => warning.remove(), 4000);
}

function startMaliciousSpike() {
    const existing = document.getElementById("malicious-spike-indicator");
    if (existing) existing.remove();

    STATE.maliciousSpikeActive = true;

    // Store normal distribution
    STATE.normalTrafficDist = { ...STATE.trafficDistribution };

    const maliciousPct = CONFIG.survival.maliciousSpike.maliciousPercent;
    const remaining = 1 - maliciousPct;

    const otherTotal = 1 - STATE.normalTrafficDist.MALICIOUS;
    STATE.trafficDistribution = {
        STATIC: (STATE.normalTrafficDist.STATIC / otherTotal) * remaining,
        READ: (STATE.normalTrafficDist.READ / otherTotal) * remaining,
        WRITE: (STATE.normalTrafficDist.WRITE / otherTotal) * remaining,
        UPLOAD: (STATE.normalTrafficDist.UPLOAD / otherTotal) * remaining,
        SEARCH: (STATE.normalTrafficDist.SEARCH / otherTotal) * remaining,
        MALICIOUS: maliciousPct,
    };

    // Visual indicator
    const indicator = document.createElement("div");
    indicator.id = "malicious-spike-indicator";
    indicator.className =
        "fixed top-4 left-1/2 transform -translate-x-1/2 z-40 pointer-events-none";
    indicator.innerHTML = `
        <div class="bg-red-900/80 border-2 border-red-500 rounded-lg px-4 py-2 animate-pulse">
            <span class="text-red-400 font-bold">🔥 DDoS ATTACK ACTIVE 🔥</span>
        </div>
    `;
    document.body.appendChild(indicator);

    // Update mix display
    const maliciousEl = document.getElementById("mix-malicious");
    if (maliciousEl)
        maliciousEl.className = "text-red-500 font-bold animate-pulse";
}

function endMaliciousSpike() {
    STATE.maliciousSpikeActive = false;

    // Restore normal distribution
    if (STATE.normalTrafficDist) {
        STATE.trafficDistribution = { ...STATE.normalTrafficDist };
        STATE.normalTrafficDist = null;
    }

    // Remove indicator
    const indicator = document.getElementById("malicious-spike-indicator");
    if (indicator) indicator.remove();

    // Reset mix display styling
    const maliciousEl = document.getElementById("mix-malicious");
    if (maliciousEl) maliciousEl.className = "text-red-400";

    STATE.sound.playSuccess();
}

// ==================== INTERVENTION MECHANICS ====================

function addInterventionWarning(message, type = "warning", duration = 4000) {
    const warningsContainer = document.getElementById("intervention-warnings");
    if (!warningsContainer) return;

    const warning = document.createElement("div");
    const typeStyles = {
        warning: "warning-warning",
        danger: "warning-danger",
        info: "warning-info",
    };

    warning.className = `intervention-warning ${typeStyles[type] || typeStyles.warning
        } border-2 rounded-lg px-6 py-3 mb-2 shadow-lg`;
    warning.innerHTML = `
        <div class="flex items-center gap-3">
            <span class="text-2xl">${type === "danger" ? "⚠️" : type === "info" ? "✅" : "📢"
        }</span>
            <span class="font-bold text-lg">${message}</span>
        </div>
    `;
    warningsContainer.appendChild(warning);

    // Play warning sound
    if (type === "danger") {
        STATE.sound?.playTone(200, "sawtooth", 0.4);
        STATE.sound?.playTone(150, "sawtooth", 0.4, 0.1);
    } else if (type === "warning") {
        STATE.sound?.playTone(400, "sine", 0.2);
    }

    // Add to state for tracking
    if (STATE.intervention) {
        STATE.intervention.warnings.push({ message, type, time: Date.now() });
    }

    // Animate out before removing
    setTimeout(() => {
        warning.style.transition = "all 0.3s ease-out";
        warning.style.opacity = "0";
        warning.style.transform = "translateY(-20px)";
        setTimeout(() => warning.remove(), 300);
    }, duration - 300);
}

function updateTrafficShift(dt) {
    if (STATE.gameMode !== "survival") return;
    if (!CONFIG.survival.trafficShift?.enabled) return;
    if (!STATE.intervention) return;

    STATE.intervention.trafficShiftTimer += dt;

    const config = CONFIG.survival.trafficShift;
    const interval = config.interval;
    const duration = config.duration;

    // Check if shift should start
    if (
        !STATE.intervention.trafficShiftActive &&
        STATE.intervention.trafficShiftTimer >= interval
    ) {
        startTrafficShift();
    }

    // Check if shift should end
    if (
        STATE.intervention.trafficShiftActive &&
        STATE.intervention.trafficShiftTimer >= interval + duration
    ) {
        endTrafficShift();
        STATE.intervention.trafficShiftTimer = 0; // Reset for next cycle
    }
}

function startTrafficShift() {
    if (!STATE.intervention || STATE.maliciousSpikeActive) return;

    const config = CONFIG.survival.trafficShift;
    const shifts = config.shifts;

    // Pick a random shift
    const shift = shifts[Math.floor(Math.random() * shifts.length)];
    STATE.intervention.currentShift = shift;
    STATE.intervention.trafficShiftActive = true;

    // Store original distribution
    STATE.intervention.originalTrafficDist = { ...STATE.trafficDistribution };

    // Apply the shift
    const newDist = { ...STATE.trafficDistribution };
    const boostAmount = 0.25; // Boost the specified type by 25%

    // Reduce all others proportionally to make room
    const totalOthers = Object.entries(newDist)
        .filter(([key]) => key !== shift.type)
        .reduce((sum, [, val]) => sum + val, 0);

    Object.keys(newDist).forEach((key) => {
        if (key === shift.type) {
            newDist[key] = Math.min(0.6, newDist[key] + boostAmount);
        } else {
            newDist[key] *= 1 - boostAmount / totalOthers;
        }
    });

    STATE.trafficDistribution = newDist;

    addInterventionWarning(
        `📊 ${shift.name} - ${shift.type} traffic surging!`,
        "warning",
        5000
    );
    STATE.sound?.playTone(500, "sine", 0.2);
}

function endTrafficShift() {
    if (!STATE.intervention) return;

    STATE.intervention.trafficShiftActive = false;

    // Restore original distribution
    if (STATE.intervention.originalTrafficDist) {
        STATE.trafficDistribution = { ...STATE.intervention.originalTrafficDist };
        STATE.intervention.originalTrafficDist = null;
    }

    STATE.intervention.currentShift = null;
}

function updateRandomEvents(dt) {
    if (STATE.gameMode !== "survival") return;
    if (!CONFIG.survival.randomEvents?.enabled) return;
    if (!STATE.intervention) return;

    STATE.intervention.randomEventTimer += dt;

    const config = CONFIG.survival.randomEvents;

    // Check if event should trigger
    if (STATE.intervention.randomEventTimer >= config.checkInterval) {
        STATE.intervention.randomEventTimer = 0;

        // 30% chance to trigger an event
        if (Math.random() < 0.3) {
            triggerRandomEvent();
        }
    }

    // Check if active event should end
    if (
        STATE.intervention.activeEvent &&
        Date.now() >= STATE.intervention.eventEndTime
    ) {
        endRandomEvent();
    }
}

function triggerRandomEvent() {
    if (!STATE.intervention || STATE.intervention.activeEvent) return;

    const config = CONFIG.survival.randomEvents;
    const eventType =
        config.types[Math.floor(Math.random() * config.types.length)];
    const duration = 30000; // 30 second events

    STATE.intervention.activeEvent = eventType;
    STATE.intervention.eventEndTime = Date.now() + duration;
    STATE.intervention.eventDuration = duration;

    switch (eventType) {
        case "COST_SPIKE":
            addInterventionWarning(
                "💰 CLOUD COST SPIKE! Upkeep doubled for 30s",
                "danger",
                8000
            );
            STATE.intervention.costMultiplier = 2.0;
            break;

        case "CAPACITY_DROP":
            addInterventionWarning(
                "⚡ RESOURCE THROTTLING! Capacity reduced for 30s",
                "danger",
                8000
            );
            STATE.services.forEach((s) => {
                s.tempCapacityReduction = 0.5; // 50% capacity
            });
            break;

        case "TRAFFIC_BURST":
            addInterventionWarning(
                "🚀 TRAFFIC BURST! 3× requests for 30s",
                "warning",
                8000
            );
            STATE.intervention.trafficBurstMultiplier = 3.0;
            break;

        case "SERVICE_OUTAGE":
            // Pick a random service to temporarily disable
            const services = STATE.services.filter((s) => s.type !== "waf");
            if (services.length > 0) {
                const target = services[Math.floor(Math.random() * services.length)];
                target.isDisabled = true;
                target.mesh.material.opacity = 0.3;
                target.mesh.material.transparent = true;
                addInterventionWarning(
                    `🔧 ${target.type.toUpperCase()} OUTAGE! Service offline for 30s`,
                    "danger",
                    8000
                );
            }
            break;
    }

    // Show active event bar
    showActiveEventBar(eventType);

    STATE.sound?.playTone(300, "sawtooth", 0.3);
}

function endRandomEvent() {
    if (!STATE.intervention || !STATE.intervention.activeEvent) return;

    const eventType = STATE.intervention.activeEvent;

    switch (eventType) {
        case "COST_SPIKE":
            STATE.intervention.costMultiplier = 1.0;
            break;

        case "CAPACITY_DROP":
            STATE.services.forEach((s) => {
                s.tempCapacityReduction = 1.0;
            });
            break;

        case "TRAFFIC_BURST":
            STATE.intervention.trafficBurstMultiplier = 1.0;
            break;

        case "SERVICE_OUTAGE":
            STATE.services.forEach((s) => {
                if (s.isDisabled) {
                    s.isDisabled = false;
                    s.mesh.material.opacity = 1.0;
                    s.mesh.material.transparent = false;
                }
            });
            break;
    }

    // Hide active event bar
    hideActiveEventBar();

    STATE.intervention.activeEvent = null;
    addInterventionWarning("✅ Event ended", "info", 2000);
    STATE.sound?.playSuccess();
}

function showActiveEventBar(eventType) {
    const bar = document.getElementById("active-event-bar");
    const icon = document.getElementById("active-event-icon");
    const text = document.getElementById("active-event-text");

    if (!bar) return;

    const eventConfig = {
        COST_SPIKE: { icon: "💰", text: "COST SPIKE ACTIVE", color: "bg-red-600" },
        CAPACITY_DROP: {
            icon: "⚡",
            text: "CAPACITY REDUCED",
            color: "bg-orange-600",
        },
        TRAFFIC_BURST: {
            icon: "🚀",
            text: "TRAFFIC BURST",
            color: "bg-yellow-600",
        },
        SERVICE_OUTAGE: {
            icon: "🔧",
            text: "SERVICE OUTAGE",
            color: "bg-purple-600",
        },
    };

    const config = eventConfig[eventType] || eventConfig["COST_SPIKE"];

    bar.className = `fixed top-0 left-0 right-0 h-8 z-40 ${config.color}`;
    icon.textContent = config.icon;
    text.textContent = config.text;
    bar.classList.remove("hidden");
}

function hideActiveEventBar() {
    const bar = document.getElementById("active-event-bar");
    if (bar) bar.classList.add("hidden");
}

function updateActiveEventTimer() {
    if (!STATE.intervention?.activeEvent) return;

    const timerEl = document.getElementById("active-event-timer");
    const progressEl = document.getElementById("active-event-progress");

    const remaining = Math.max(0, STATE.intervention.eventEndTime - Date.now());
    const remainingSec = Math.ceil(remaining / 1000);

    if (timerEl) {
        timerEl.textContent = formatTime(remainingSec);
    }

    if (progressEl && STATE.intervention.eventDuration) {
        const progress = (remaining / STATE.intervention.eventDuration) * 100;
        progressEl.style.width = `${Math.max(0, progress)}%`;
    }
}

function updateServiceHealthIndicators() {
    if (STATE.gameMode !== "survival") return;
    if (!CONFIG.survival.degradation?.enabled) return;

    const healthContainer = document.getElementById("service-health-list");
    if (!healthContainer) return;

    const criticalServices = STATE.services.filter(
        (s) => s.health < (CONFIG.survival.degradation?.criticalHealth || 30)
    );

    if (criticalServices.length === 0) {
        healthContainer.innerHTML =
            '<div class="text-green-400 text-xs">All services healthy</div>';
        return;
    }

    healthContainer.innerHTML = criticalServices
        .map(
            (s) => `
        <div class="flex justify-between items-center text-xs mb-1">
            <span class="text-red-400">${s.type.toUpperCase()}</span>
            <span class="text-red-300">${Math.round(s.health)}% HP</span>
        </div>
    `
        )
        .join("");
}

function updateRepairCostTable() {
    const table = document.getElementById("repair-cost-table");
    const rows = document.getElementById("repair-cost-rows");

    if (!table || !rows) return;

    if (STATE.services.length === 0) {
        table.classList.add("hidden");
        return;
    }

    table.classList.remove("hidden");

    const repairPercent = CONFIG.survival.degradation?.repairCostPercent || 0.15;
    const autoRepairPercent =
        CONFIG.survival.degradation?.autoRepairCostPercent || 0.1;

    rows.innerHTML = STATE.services
        .map((s) => {
            const repairCost = Math.ceil(s.config.cost * repairPercent);
            const autoRepairCost = (s.config.cost * autoRepairPercent).toFixed(1);
            const healthColor =
                s.health < 40
                    ? "text-red-400"
                    : s.health < 70
                        ? "text-yellow-400"
                        : "text-green-400";

            return `
            <div class="grid grid-cols-3 gap-1 text-gray-300">
                <span class="${healthColor}">${s.type
                    .substring(0, 6)
                    .toUpperCase()}</span>
                <span class="text-center text-yellow-400">$${repairCost}</span>
                <span class="text-right text-orange-400" title="$${s.config.cost
                } × 10%">$${autoRepairCost}</span>
            </div>
        `;
        })
        .join("");
}

function updateFinancesDisplay() {
    if (!STATE.finances) return;

    const f = STATE.finances;

    // Income by request type - labels, colors, and per-request rates
    const incomeTypes = [
        {
            key: "STATIC",
            label: "Static",
            color: "text-blue-400",
            rate: CONFIG.trafficTypes.STATIC.reward,
        },
        {
            key: "READ",
            label: "DB Read",
            color: "text-green-400",
            rate: CONFIG.trafficTypes.READ.reward,
        },
        {
            key: "WRITE",
            label: "DB Write",
            color: "text-yellow-400",
            rate: CONFIG.trafficTypes.WRITE.reward,
        },
        {
            key: "UPLOAD",
            label: "Upload",
            color: "text-purple-400",
            rate: CONFIG.trafficTypes.UPLOAD.reward,
        },
        {
            key: "SEARCH",
            label: "Search",
            color: "text-cyan-400",
            rate: CONFIG.trafficTypes.SEARCH.reward,
        },
        { key: "blocked", label: "Blocked", color: "text-red-400", rate: 0.5 },
    ];

    // Update income details with per-request rate and count
    const incomeDetails = document.getElementById("income-details");
    if (incomeDetails) {
        let incomeHtml =
            '<div class="grid grid-cols-4 gap-1 text-gray-500 mb-1 text-[10px]"><span>Type</span><span class="text-center">Count</span><span class="text-center">/req</span><span class="text-right">Total</span></div>';
        let hasIncome = false;
        incomeTypes.forEach((t) => {
            const value =
                t.key === "blocked" ? f.income.blocked : f.income.byType[t.key] || 0;
            const count = f.income.countByType[t.key] || 0;
            if (value > 0 || count > 0) {
                hasIncome = true;
                incomeHtml += `<div class="grid grid-cols-4 gap-1"><span class="${t.color
                    }">${t.label
                    }</span><span class="text-center text-gray-500">${count}</span><span class="text-center text-gray-400">$${t.rate.toFixed(
                        2
                    )}</span><span class="text-right text-gray-300">$${Math.floor(
                        value
                    )}</span></div>`;
            }
        });
        if (!hasIncome) {
            incomeHtml = '<div class="text-gray-600 italic">No income yet</div>';
        }
        incomeDetails.innerHTML = incomeHtml;
    }

    // Update income total
    const incomeTotal = document.getElementById("income-total");
    if (incomeTotal)
        incomeTotal.textContent = `$${Math.floor(f.income.total || 0)}`;

    // Expense categories - services with costs
    const serviceTypes = [
        {
            key: "waf",
            label: "WAF",
            color: "text-red-400",
            cost: CONFIG.services.waf.cost,
        },
        {
            key: "alb",
            label: "ALB",
            color: "text-blue-400",
            cost: CONFIG.services.alb.cost,
        },
        {
            key: "compute",
            label: "Compute",
            color: "text-green-400",
            cost: CONFIG.services.compute.cost,
        },
        {
            key: "db",
            label: "Database",
            color: "text-yellow-400",
            cost: CONFIG.services.db.cost,
        },
        {
            key: "s3",
            label: "S3",
            color: "text-purple-400",
            cost: CONFIG.services.s3.cost,
        },
        {
            key: "cache",
            label: "Cache",
            color: "text-orange-400",
            cost: CONFIG.services.cache.cost,
        },
        {
            key: "sqs",
            label: "SQS",
            color: "text-cyan-400",
            cost: CONFIG.services.sqs.cost,
        },
    ];

    const repairPercent = CONFIG.survival.degradation?.repairCostPercent || 0.15;

    // Update expense details with service cost, repair cost and count
    const expenseDetails = document.getElementById("expense-details");
    if (expenseDetails) {
        let expenseHtml = "";

        // Breakdown by service type (includes purchase + upkeep + repairs)
        let hasServiceExpenses = false;
        serviceTypes.forEach((t) => {
            const value = f.expenses.byService[t.key] || 0;
            const count = f.expenses.countByService[t.key] || 0;
            const repairCost = Math.ceil(t.cost * repairPercent);
            if (value > 0 || count > 0) {
                hasServiceExpenses = true;
                expenseHtml += `<div class="grid grid-cols-5 gap-1"><span class="${t.color
                    }">${t.label
                    }</span><span class="text-center text-gray-500">${count}</span><span class="text-center text-gray-400">$${t.cost
                    }</span><span class="text-center text-yellow-400">$${repairCost}</span><span class="text-right text-gray-300">$${Math.floor(
                        value
                    )}</span></div>`;
            }
        });

        // Add header if we have service expenses
        if (hasServiceExpenses) {
            expenseHtml =
                '<div class="grid grid-cols-5 gap-1 text-gray-500 mb-1 text-[10px]"><span>Service</span><span class="text-center">#</span><span class="text-center">Cost</span><span class="text-center">Repair</span><span class="text-right">Spent</span></div>' +
                expenseHtml;
        }

        // Auto-repair overhead (if enabled)
        if (f.expenses.autoRepair > 0) {
            expenseHtml += `<div class="flex justify-between mt-1 pt-1 border-t border-gray-700"><span class="text-orange-400">Auto-Repair</span><span class="text-gray-300">$${Math.floor(
                f.expenses.autoRepair
            )}</span></div>`;
        }

        if (!expenseHtml) {
            expenseHtml = '<div class="text-gray-600 italic">No expenses yet</div>';
        }
        expenseDetails.innerHTML = expenseHtml;
    }

    // Calculate totals
    const totalExpenses =
        f.expenses.services +
        f.expenses.upkeep +
        f.expenses.repairs +
        f.expenses.autoRepair;
    const expenseTotal = document.getElementById("expense-total");
    if (expenseTotal) expenseTotal.textContent = `$${Math.floor(totalExpenses)}`;

    // Update net profit
    const totalIncome = f.income.total || f.income.requests + f.income.blocked;
    const netProfit = totalIncome - totalExpenses;
    const netProfitEl = document.getElementById("net-profit");
    if (netProfitEl) {
        netProfitEl.textContent = `${netProfit >= 0 ? "+" : ""}$${Math.floor(
            netProfit
        )}`;
        netProfitEl.className = `text-right font-bold ${netProfit >= 0 ? "text-green-400" : "text-red-400"
            }`;
    }
}

// ==================== END INTERVENTION MECHANICS ====================

// ==================== END BALANCE OVERHAUL FUNCTIONS ====================

const container = document.getElementById("canvas-container");
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.008);

let isDraggingNode = false;
let draggedNode = null;
let dragOffset = new THREE.Vector3();

const aspect = window.innerWidth / window.innerHeight;
const d = 50;
const camera = new THREE.OrthographicCamera(
    -d * aspect,
    d * aspect,
    d,
    -d,
    1,
    1000
);
const cameraTarget = new THREE.Vector3(0, 0, 0);
let isIsometric = true;
resetCamera();

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

const gridHelper = new THREE.GridHelper(
    CONFIG.gridSize * CONFIG.tileSize,
    CONFIG.gridSize,
    CONFIG.colors.grid,
    CONFIG.colors.grid
);
scene.add(gridHelper);

const serviceGroup = new THREE.Group();
const connectionGroup = new THREE.Group();
const requestGroup = new THREE.Group();
scene.add(serviceGroup);
scene.add(connectionGroup);
scene.add(requestGroup);

const internetGeo = new THREE.BoxGeometry(6, 1, 10);
const internetMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    emissive: 0x00ffff,
    emissiveIntensity: 0.7,
    roughness: 0.2,
});
const internetMesh = new THREE.Mesh(internetGeo, internetMat);
internetMesh.position.copy(STATE.internetNode.position);
internetMesh.castShadow = true;
internetMesh.receiveShadow = true;
scene.add(internetMesh);
STATE.internetNode.mesh = internetMesh;

const intRingGeo = new THREE.RingGeometry(7, 7.2, 32);
const intRingMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
});
const internetRing = new THREE.Mesh(intRingGeo, intRingMat);
internetRing.rotation.x = -Math.PI / 2;
internetRing.position.set(
    internetMesh.position.x,
    -internetMesh.position.y + 0.1,
    internetMesh.position.z
);
scene.add(internetRing);
STATE.internetNode.ring = internetRing;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

function resetGame(mode = "survival") {
    STATE.sound.init();
    STATE.sound.playGameBGM();
    STATE.gameMode = mode;

    // Set budget based on mode
    if (mode === "sandbox") {
        STATE.sandboxBudget = CONFIG.sandbox.defaultBudget;
        STATE.money = STATE.sandboxBudget;
        STATE.upkeepEnabled = CONFIG.sandbox.upkeepEnabled;
        STATE.trafficDistribution = {
            STATIC: CONFIG.sandbox.trafficDistribution.STATIC / 100,
            READ: CONFIG.sandbox.trafficDistribution.READ / 100,
            WRITE: CONFIG.sandbox.trafficDistribution.WRITE / 100,
            UPLOAD: CONFIG.sandbox.trafficDistribution.UPLOAD / 100,
            SEARCH: CONFIG.sandbox.trafficDistribution.SEARCH / 100,
            MALICIOUS: CONFIG.sandbox.trafficDistribution.MALICIOUS / 100,
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
    STATE.score = { total: 0, storage: 0, database: 0, maliciousBlocked: 0 };
    STATE.failures = {
        STATIC: 0,
        READ: 0,
        WRITE: 0,
        UPLOAD: 0,
        SEARCH: 0,
        MALICIOUS: 0,
    };
    STATE.isRunning = true;
    STATE.lastTime = performance.now();
    STATE.timeScale = 0;
    STATE.spawnTimer = 0;

    // Hide failures panel on reset
    const failuresPanel = document.getElementById("failures-panel");
    if (failuresPanel) failuresPanel.classList.add("hidden");

    // Initialize balance overhaul state
    STATE.elapsedGameTime = 0;
    STATE.gameStartTime = performance.now();
    STATE.maliciousSpikeTimer = 0;
    STATE.maliciousSpikeActive = false;
    STATE.normalTrafficDist = null;
    STATE.autoRepairEnabled = false;

    // Initialize detailed finance tracking
    STATE.finances = {
        income: {
            byType: {
                STATIC: 0,
                READ: 0,
                WRITE: 0,
                UPLOAD: 0,
                SEARCH: 0,
            },
            countByType: {
                STATIC: 0,
                READ: 0,
                WRITE: 0,
                UPLOAD: 0,
                SEARCH: 0,
                blocked: 0,
            },
            requests: 0, // Total from all request types
            blocked: 0, // From blocking attacks
            total: 0, // Grand total income
        },
        expenses: {
            services: 0, // One-time service purchase costs
            upkeep: 0, // Running upkeep costs
            repairs: 0, // Manual repair costs
            autoRepair: 0, // Auto-repair overhead costs
            byService: {
                // Breakdown by service type (upkeep + repairs)
                waf: 0,
                alb: 0,
                compute: 0,
                db: 0,
                s3: 0,
                cache: 0,
                sqs: 0,
            },
            countByService: {
                // Count of each service purchased
                waf: 0,
                alb: 0,
                compute: 0,
                db: 0,
                s3: 0,
                cache: 0,
                sqs: 0,
            },
        },
    };

    // Reset auto-repair toggle UI
    const autoRepairBtn = document.getElementById("auto-repair-toggle");
    if (autoRepairBtn) {
        autoRepairBtn.textContent = "Auto-Repair: OFF";
        autoRepairBtn.classList.remove("text-green-400");
        autoRepairBtn.classList.add("text-gray-400");
    }

    // Reset repair cost table
    const repairTable = document.getElementById("repair-cost-table");
    if (repairTable) repairTable.classList.add("hidden");

    const maliciousWarning = document.getElementById("malicious-warning");
    if (maliciousWarning) maliciousWarning.remove();
    const maliciousIndicator = document.getElementById(
        "malicious-spike-indicator"
    );
    if (maliciousIndicator) maliciousIndicator.remove();

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
    document
        .querySelectorAll(".time-btn")
        .forEach((b) => b.classList.remove("active"));
    document.getElementById("btn-pause").classList.add("active");
    // Only add pulse-green if tutorial is not active
    if (!window.tutorial?.isActive) {
        document.getElementById("btn-play").classList.add("pulse-green");
    }

    // Update UI displays
    updateScoreUI();

    // Mark game as started
    STATE.gameStarted = true;

    // Show/hide sandbox panel and objectives panel based on mode
    const sandboxPanel = document.getElementById("sandboxPanel");
    const objectivesPanel = document.getElementById("objectivesPanel");

    if (mode === "sandbox") {
        // Show sandbox panel, hide objectives
        if (sandboxPanel) {
            sandboxPanel.classList.remove("hidden");
            // Sync sandbox UI controls
            syncInput("budget", STATE.sandboxBudget);
            syncInput("rps", STATE.currentRPS);
            syncInput("static", STATE.trafficDistribution.STATIC * 100);
            syncInput("read", STATE.trafficDistribution.READ * 100);
            syncInput("write", STATE.trafficDistribution.WRITE * 100);
            syncInput("upload", STATE.trafficDistribution.UPLOAD * 100);
            syncInput("search", STATE.trafficDistribution.SEARCH * 100);
            syncInput("malicious", STATE.trafficDistribution.MALICIOUS * 100);
            syncInput("burst", STATE.burstCount);
            // Reset upkeep toggle button
            const upkeepBtn = document.getElementById("upkeep-toggle");
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled
                    ? "Upkeep: ON"
                    : "Upkeep: OFF";
                upkeepBtn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
                upkeepBtn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
            }
        }
        if (objectivesPanel) objectivesPanel.classList.add("hidden");
    } else {
        // Show objectives, hide sandbox panel
        if (sandboxPanel) sandboxPanel.classList.add("hidden");
        if (objectivesPanel) objectivesPanel.classList.remove("hidden");
    }

    // Ensure loop is running
    if (!STATE.animationId) {
        animate(performance.now());
    }
}

function restartGame() {
    document.getElementById("modal").classList.add("hidden");
    resetGame(STATE.gameMode);
}

function toggleAutoRepair() {
    STATE.autoRepairEnabled = !STATE.autoRepairEnabled;
    const btn = document.getElementById("auto-repair-toggle");
    if (btn) {
        if (STATE.autoRepairEnabled) {
            btn.textContent = "Auto-Repair: ON";
            btn.classList.remove("text-gray-400");
            btn.classList.add("text-green-400");
            addInterventionWarning("Auto-repair enabled (+10% upkeep)", "info", 2000);
        } else {
            btn.textContent = "Auto-Repair: OFF";
            btn.classList.remove("text-green-400");
            btn.classList.add("text-gray-400");
            addInterventionWarning("Auto-repair disabled", "info", 2000);
        }
    }
    updateRepairCostTable();
}

function processAutoRepair(dt) {
    if (!STATE.autoRepairEnabled || STATE.gameMode !== "survival") return;

    const config = CONFIG.survival.degradation;
    if (!config?.enabled) return;

    STATE.services.forEach((service) => {
        if (service.health < 100) {
            // Gradually heal - 5 health per second when auto-repair is on
            service.health = Math.min(100, service.health + 5 * dt);
            service.updateHealthVisual();
        }
    });
}

function getAutoRepairUpkeep() {
    if (!STATE.autoRepairEnabled) return 0;

    const percent = CONFIG.survival.degradation?.autoRepairCostPercent || 0.1;
    // 10% of total service cost per second
    const totalServiceCost = STATE.services.reduce(
        (sum, s) => sum + s.config.cost,
        0
    );
    return (totalServiceCost * percent) / 60; // Per second
}

function retryWithSameArchitecture() {
    document.getElementById("modal").classList.add("hidden");

    // Save current architecture with indices for connection mapping
    const savedServices = STATE.services.map((s, idx) => ({
        type: s.type,
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        index: idx,
        cost: s.config.cost, // Save the cost for budget calculation
    }));

    // Calculate total cost of saved architecture
    const totalArchitectureCost = savedServices.reduce(
        (sum, s) => sum + s.cost,
        0
    );

    // Save connections with indices instead of IDs
    const savedConnections = STATE.connections.map((c) => ({
        fromIndex:
            c.from === "internet"
                ? -1
                : STATE.services.findIndex((s) => s.id === c.from),
        toIndex:
            c.to === "internet" ? -1 : STATE.services.findIndex((s) => s.id === c.to),
    }));

    // Reset game state but keep mode
    resetGame(STATE.gameMode);

    // Deduct the architecture cost from starting budget (simulate buying services)
    STATE.money -= totalArchitectureCost;
    if (STATE.finances) {
        STATE.finances.expenses.services = totalArchitectureCost;
    }

    // Rebuild services in same order (bypass cost check since we already deducted)
    savedServices.forEach((saved) => {
        const pos = new THREE.Vector3(
            saved.position.x,
            saved.position.y,
            saved.position.z
        );
        // Create service directly without cost check for retry
        const service = new Service(saved.type, pos);
        service.mesh.position.set(saved.position.x, 0, saved.position.z);
        STATE.services.push(service);
    });

    // Update repair cost table after all services are created
    updateRepairCostTable();

    // Rebuild connections using indices
    savedConnections.forEach((saved) => {
        const fromId =
            saved.fromIndex === -1 ? "internet" : STATE.services[saved.fromIndex]?.id;
        const toId =
            saved.toIndex === -1 ? "internet" : STATE.services[saved.toIndex]?.id;

        if (fromId && toId) {
            createConnection(fromId, toId);
        }
    });

    addInterventionWarning("🔄 Architecture restored! Try again!", "info", 3000);
    STATE.sound?.playPlace();
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
        return { type: "service", id: obj.userData.id, obj: obj };
    }

    const intInter = raycaster.intersectObject(STATE.internetNode.mesh);
    if (intInter.length > 0)
        return { type: "internet", id: "internet", obj: STATE.internetNode.mesh };

    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    return { type: "ground", pos: target };
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
    const types = Object.keys(dist);
    const total = types.reduce((sum, type) => sum + (dist[type] || 0), 0);
    if (total === 0) return TRAFFIC_TYPES.STATIC;

    const r = Math.random() * total;
    let cumulative = 0;

    for (const type of types) {
        cumulative += dist[type] || 0;
        if (r < cumulative) {
            return TRAFFIC_TYPES[type] || type;
        }
    }

    return TRAFFIC_TYPES.STATIC;
}

function spawnRequest() {
    const type = getTrafficType();
    const req = new Request(type);
    STATE.requests.push(req);
    const conns = STATE.internetNode.connections;
    if (conns.length > 0) {
        const entryNodes = conns.map((id) =>
            STATE.services.find((s) => s.id === id)
        );
        const wafEntry = entryNodes.find((s) => s?.type === "waf");
        const target =
            wafEntry || entryNodes[Math.floor(Math.random() * entryNodes.length)];

        if (target) req.flyTo(target);
        else failRequest(req);
    } else failRequest(req);
}

function updateScore(req, outcome) {
    const points = CONFIG.survival.SCORE_POINTS;
    const typeConfig = req.typeConfig || CONFIG.trafficTypes[req.type];

    if (outcome === "MALICIOUS_BLOCKED") {
        STATE.score.maliciousBlocked += points.MALICIOUS_BLOCKED_SCORE;
        STATE.score.total += points.MALICIOUS_BLOCKED_SCORE;
        // Add small reward for blocking attacks
        const blockReward = 0.5;
        STATE.money += blockReward;
        if (STATE.finances) {
            STATE.finances.income.blocked += blockReward;
            STATE.finances.income.total += blockReward;
            STATE.finances.income.countByType.blocked =
                (STATE.finances.income.countByType.blocked || 0) + 1;
        }
        STATE.sound.playFraudBlocked();
    } else if (
        req.type === TRAFFIC_TYPES.MALICIOUS &&
        outcome === "MALICIOUS_PASSED"
    ) {
        STATE.reputation += points.MALICIOUS_PASSED_REPUTATION;
        STATE.failures.MALICIOUS++;
        console.warn(
            `MALICIOUS PASSED: ${points.MALICIOUS_PASSED_REPUTATION} Rep. (Critical Failure)`
        );
    } else if (outcome === "COMPLETED") {
        let reward = typeConfig.reward;
        const score = typeConfig.score;

        if (req.cached) {
            reward *= 1 + points.CACHE_HIT_BONUS;
        }

        if (typeConfig.destination === "s3") {
            STATE.score.storage += score;
        } else if (typeConfig.destination === "db") {
            STATE.score.database += score;
        }

        STATE.score.total += score;
        STATE.money += reward;
        if (STATE.finances) {
            STATE.finances.income.requests += reward;
            STATE.finances.income.total += reward;
            // Track by request type
            const reqType = req.type || "STATIC";
            STATE.finances.income.byType[reqType] =
                (STATE.finances.income.byType[reqType] || 0) + reward;
            STATE.finances.income.countByType[reqType] =
                (STATE.finances.income.countByType[reqType] || 0) + 1;
        }
        STATE.reputation += points.SUCCESS_REPUTATION || 0.5; // Gain reputation on success
    } else if (outcome === "FAILED") {
        STATE.reputation += points.FAIL_REPUTATION;
        STATE.score.total -= (typeConfig.score || 5) / 2;
        if (STATE.failures[req.type] !== undefined) {
            STATE.failures[req.type]++;
        }
    }

    updateScoreUI();
}

function finishRequest(req) {
    STATE.requestsProcessed++;
    updateScore(req, "COMPLETED");
    removeRequest(req);
}

function failRequest(req) {
    const failType =
        req.type === TRAFFIC_TYPES.MALICIOUS ? "MALICIOUS_PASSED" : "FAILED";
    updateScore(req, failType);
    STATE.sound.playFail();
    req.mesh.material.color.setHex(CONFIG.colors.requestFail);
    setTimeout(() => removeRequest(req), 500);
}

function removeRequest(req) {
    req.destroy();
    STATE.requests = STATE.requests.filter((r) => r !== req);
}

function updateScoreUI() {
    document.getElementById("total-score-display").innerText = STATE.score.total;
    document.getElementById("score-storage").innerText = STATE.score.storage;
    document.getElementById("score-database").innerText = STATE.score.database;
    document.getElementById("score-malicious").innerText =
        STATE.score.maliciousBlocked;
}

function flashMoney() {
    const el = document.getElementById("money-display");
    el.classList.add("text-red-500");
    setTimeout(() => el.classList.remove("text-red-500"), 300);
}

function showMainMenu() {
    // Ensure sound is initialized if possible (browsers might block until interaction)
    if (!STATE.sound.ctx) STATE.sound.init();
    STATE.sound.playMenuBGM();

    document.getElementById("main-menu-modal").classList.remove("hidden");
    document.getElementById("faq-modal").classList.add("hidden");
    document.getElementById("modal").classList.add("hidden");

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById("load-btn");
    const hasSave = localStorage.getItem("serverSurvivalSave") !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? "block" : "none";
    }
}

let faqSource = "menu"; // 'menu' or 'game'

window.showFAQ = (source = "menu") => {
    faqSource = source;
    // If called from button (onclick="showFAQ()"), it defaults to 'menu' effectively unless we change the HTML.
    // But wait, the button in index.html just calls showFAQ().
    // We can check if main menu is visible.

    if (
        !document.getElementById("main-menu-modal").classList.contains("hidden")
    ) {
        faqSource = "menu";
        document.getElementById("main-menu-modal").classList.add("hidden");
    } else {
        faqSource = "game";
    }

    document.getElementById("faq-modal").classList.remove("hidden");
};

window.closeFAQ = () => {
    document.getElementById("faq-modal").classList.add("hidden");
    if (faqSource === "menu") {
        document.getElementById("main-menu-modal").classList.remove("hidden");
    }
};

window.togglePanel = (contentId, iconId) => {
    const content = document.getElementById(contentId);
    const icon = document.getElementById(iconId);
    if (content) {
        content.classList.toggle('hidden');
        if (icon) {
            icon.innerText = content.classList.contains('hidden') ? '▼' : '▲';
        }
    }
};

window.startGame = () => {
    document.getElementById("main-menu-modal").classList.add("hidden");
    resetGame();

    if (window.tutorial) {
        setTimeout(() => {
            window.tutorial.start();
        }, 500);
    }
};

window.startSandbox = () => {
    document.getElementById("main-menu-modal").classList.add("hidden");
    resetGame("sandbox");
};

function createService(type, pos) {
    if (STATE.money < CONFIG.services[type].cost) {
        flashMoney();
        return;
    }
    if (STATE.services.find((s) => s.position.distanceTo(pos) < 1)) return;
    const cost = CONFIG.services[type].cost;
    STATE.money -= cost;
    if (STATE.finances) {
        STATE.finances.expenses.services += cost;
        STATE.finances.expenses.byService[type] =
            (STATE.finances.expenses.byService[type] || 0) + cost;
        STATE.finances.expenses.countByService[type] =
            (STATE.finances.expenses.countByService[type] || 0) + 1;
    }
    STATE.services.push(new Service(type, pos));
    STATE.sound.playPlace();
    updateRepairCostTable();

    // Notify tutorial
    if (window.tutorial?.isActive) {
        window.tutorial.onAction("place", { type });
    }
}

function restoreService(serviceData, pos) {
    const service = Service.restore(serviceData, pos);
    STATE.services.push(service);
    STATE.sound.playPlace();
}

function createConnection(fromId, toId) {
    if (fromId === toId) return;
    const getEntity = (id) =>
        id === "internet"
            ? STATE.internetNode
            : STATE.services.find((s) => s.id === id);
    const from = getEntity(fromId),
        to = getEntity(toId);
    if (!from || !to || from.connections.includes(toId)) return;

    let valid = false;
    const t1 = from.type,
        t2 = to.type;

    if (t1 === "internet" && (t2 === "waf" || t2 === "alb")) valid = true;
    else if (t1 === "waf" && t2 === "alb") valid = true;
    else if (t1 === "waf" && t2 === "sqs") valid = true;
    else if (t1 === "sqs" && t2 === "alb") valid = true;
    else if (t1 === "alb" && t2 === "sqs") valid = true;
    else if (t1 === "sqs" && t2 === "compute") valid = true;
    else if (t1 === "alb" && t2 === "compute") valid = true;
    else if (t1 === "compute" && t2 === "cache") valid = true;
    else if (t1 === "cache" && (t2 === "db" || t2 === "s3")) valid = true;
    else if (t1 === "compute" && (t2 === "db" || t2 === "s3")) valid = true;

    if (!valid) {
        new Audio("assets/sounds/click-9.mp3").play();
        console.error(
            "Invalid connection topology: WAF/ALB from Internet -> WAF -> ALB -> Compute -> (RDS/S3)"
        );
        return;
    }

    new Audio("assets/sounds/click-5.mp3").play();

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
        window.tutorial.onAction("connect", {
            from: fromId,
            fromType: t1,
            toType: t2,
        });
    }
}

function deleteConnection(fromId, toId) {
    const getEntity = (id) =>
        id === "internet"
            ? STATE.internetNode
            : STATE.services.find((s) => s.id === id);
    const from = getEntity(fromId);
    if (!from) return false;

    // Check if connection exists
    if (!from.connections.includes(toId)) return false;

    // Remove from service connections array
    from.connections = from.connections.filter((c) => c !== toId);

    // Find and remove the visual mesh
    const conn = STATE.connections.find(
        (c) => c.from === fromId && c.to === toId
    );
    if (conn) {
        connectionGroup.remove(conn.mesh);
        conn.mesh.geometry.dispose();
        conn.mesh.material.dispose();
        STATE.connections = STATE.connections.filter((c) => c !== conn);
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
        const from =
            conn.from === "internet"
                ? STATE.internetNode
                : STATE.services.find((s) => s.id === conn.from);
        const to =
            conn.to === "internet"
                ? STATE.internetNode
                : STATE.services.find((s) => s.id === conn.to);

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
    const svc = STATE.services.find((s) => s.id === id);
    if (!svc) return;

    STATE.services.forEach(
        (s) => (s.connections = s.connections.filter((c) => c !== id))
    );
    STATE.internetNode.connections = STATE.internetNode.connections.filter(
        (c) => c !== id
    );
    const toRemove = STATE.connections.filter(
        (c) => c.from === id || c.to === id
    );
    toRemove.forEach((c) => connectionGroup.remove(c.mesh));
    STATE.connections = STATE.connections.filter((c) => !toRemove.includes(c));

    svc.destroy();
    STATE.services = STATE.services.filter((s) => s.id !== id);
    STATE.money += Math.floor(svc.config.cost / 2);
    STATE.sound.playDelete();
    updateRepairCostTable();
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
    STATE.activeTool = t;
    STATE.selectedNodeId = null;
    document
        .querySelectorAll(".service-btn")
        .forEach((b) => b.classList.remove("active"));
    document.getElementById(`tool-${t}`).classList.add("active");
    new Audio("assets/sounds/click-9.mp3").play();
};

window.setTimeScale = (s) => {
    STATE.timeScale = s;
    document
        .querySelectorAll(".time-btn")
        .forEach((b) => b.classList.remove("active"));

    if (s === 0) {
        document.getElementById("btn-pause").classList.add("active");
        // Only add pulse-green if tutorial is not active
        if (!window.tutorial?.isActive) {
            document.getElementById("btn-play").classList.add("pulse-green");
        }
    } else if (s === 1) {
        document.getElementById("btn-play").classList.add("active");
        document.getElementById("btn-play").classList.remove("pulse-green");

        // Notify tutorial when game starts
        if (window.tutorial?.isActive) {
            window.tutorial.onAction("start_game");
        }
    } else if (s === 3) {
        document.getElementById("btn-fast").classList.add("active");
        document.getElementById("btn-play").classList.remove("pulse-green");
    }
};

window.toggleMute = () => {
    const muted = STATE.sound.toggleMute();
    const icon = document.getElementById("mute-icon");
    const menuIcon = document.getElementById("menu-mute-icon");

    const iconText = muted ? "🔇" : "🔊";
    if (icon) icon.innerText = iconText;
    if (menuIcon) menuIcon.innerText = iconText;

    const muteBtn = document.getElementById("tool-mute");
    const menuMuteBtn = document.getElementById("menu-mute-btn"); // We need to add ID to menu button

    if (muted) {
        muteBtn.classList.add("bg-red-900");
        muteBtn.classList.add("pulse-green");
        if (menuMuteBtn) menuMuteBtn.classList.add("pulse-green");
    } else {
        muteBtn.classList.remove("bg-red-900");
        muteBtn.classList.remove("pulse-green");
        if (menuMuteBtn) menuMuteBtn.classList.remove("pulse-green");
    }
};

let currentZoom = 1;
const minZoom = 0.5;
const maxZoom = 3.0;
const zoomSpeed = 0.001;

container.addEventListener("wheel", (e) => {
    e.preventDefault();

    // Zoom logic
    const zoomDelta = e.deltaY * -zoomSpeed;
    const newZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom + zoomDelta));

    if (newZoom !== currentZoom) {
        currentZoom = newZoom;

        // For OrthographicCamera, zoom is applied via dividing the frustum or using the zoom property
        // Three.js OrthographicCamera has a .zoom property
        camera.zoom = currentZoom;
        camera.updateProjectionMatrix();
    }
}, { passive: false });

// Keyboard navigation
const keysPressed = {};

window.addEventListener("keydown", (e) => {
    keysPressed[e.key] = true;
});

window.addEventListener("keyup", (e) => {
    keysPressed[e.key] = false;
});

container.addEventListener("contextmenu", (e) => e.preventDefault());

container.addEventListener("mousedown", (e) => {
    if (!STATE.isRunning) return;

    if (e.button === 2 || e.button === 1) {
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        container.style.cursor = "grabbing";
        e.preventDefault();
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    if (STATE.activeTool === "select") {
        const i = getIntersect(e.clientX, e.clientY);
        if (i.type === "service") {
            const svc = STATE.services.find((s) => s.id === i.id);
            // Check if service needs repair (double-click logic could be added)
            if (svc && svc.health < 80 && CONFIG.survival.degradation?.enabled) {
                // Repair on click when damaged
                if (svc.repair()) {
                    addInterventionWarning(
                        `🔧 ${svc.type.toUpperCase()} repaired!`,
                        "info",
                        2000
                    );
                    return;
                }
            }
            draggedNode = svc;
        } else if (i.type === "internet") {
            draggedNode = STATE.internetNode;
        }
        if (draggedNode) {
            isDraggingNode = true;
            const hit = getIntersect(e.clientX, e.clientY);
            if (hit.pos) {
                dragOffset.copy(draggedNode.position).sub(hit.pos);
            }
            container.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }
    } else if (STATE.activeTool === "delete" && i.type === "service")
        deleteObject(i.id);
    else if (STATE.activeTool === "unlink") {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            deleteConnection(conn.from, conn.to);
        } else {
            new Audio("assets/sounds/click-9.mp3").play();
        }
    } else if (
        STATE.activeTool === "connect" &&
        (i.type === "service" || i.type === "internet")
    ) {
        if (STATE.selectedNodeId) {
            createConnection(STATE.selectedNodeId, i.id);
            STATE.selectedNodeId = null;
        } else {
            STATE.selectedNodeId = i.id;
            new Audio("assets/sounds/click-5.mp3").play();
        }
    } else if (
        ["waf", "alb", "lambda", "db", "s3", "sqs", "cache"].includes(
            STATE.activeTool
        )
    ) {
        // Handle upgrades for compute, db, and cache
        if (
            (STATE.activeTool === "lambda" && i.type === "service") ||
            (STATE.activeTool === "db" && i.type === "service") ||
            (STATE.activeTool === "cache" && i.type === "service")
        ) {
            const svc = STATE.services.find((s) => s.id === i.id);
            if (
                svc &&
                ((STATE.activeTool === "lambda" && svc.type === "compute") ||
                    (STATE.activeTool === "db" && svc.type === "db") ||
                    (STATE.activeTool === "cache" && svc.type === "cache"))
            ) {
                svc.upgrade();
                return;
            }
        }
        if (i.type === "ground") {
            const typeMap = {
                waf: "waf",
                alb: "alb",
                lambda: "compute",
                db: "db",
                s3: "s3",
                sqs: "sqs",
                cache: "cache",
            };
            createService(typeMap[STATE.activeTool], snapToGrid(i.pos));
        }
    }
});

container.addEventListener("mousemove", (e) => {
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

            container.style.cursor = "grabbing";
        }
        return;
    }
    if (isPanning) {
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;

        const panX =
            ((-dx * (camera.right - camera.left)) / window.innerWidth) * panSpeed;
        const panY =
            ((dy * (camera.top - camera.bottom)) / window.innerHeight) * panSpeed;

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
        camera.updateProjectionMatrix();
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        document.getElementById("tooltip").style.display = "none";
        return;
    }

    const i = getIntersect(e.clientX, e.clientY);
    const t = document.getElementById("tooltip");
    let cursor = "default";

    // Reset all connection colors first
    STATE.connections.forEach((c) => {
        if (c.mesh && c.mesh.material) {
            c.mesh.material.color.setHex(CONFIG.colors.line);
        }
    });

    // Handle unlink tool hover
    if (STATE.activeTool === "unlink") {
        const conn = getConnectionAtPoint(e.clientX, e.clientY);
        if (conn) {
            cursor = "pointer";
            // Highlight the connection in red
            if (conn.mesh && conn.mesh.material) {
                conn.mesh.material.color.setHex(0xff4444);
            }

            // Get source and target names for tooltip
            const from =
                conn.from === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === conn.from);
            const to =
                conn.to === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === conn.to);
            const fromName =
                conn.from === "internet" ? "Internet" : from?.config?.name || "Unknown";
            const toName =
                conn.to === "internet" ? "Internet" : to?.config?.name || "Unknown";

            showTooltip(
                e.clientX + 15,
                e.clientY + 15,
                `<strong class="text-orange-400">Remove Link</strong><br>
                <span class="text-gray-300">${fromName}</span> → <span class="text-gray-300">${toName}</span><br>
                <span class="text-red-400 text-xs">Click to remove</span>`
            );
        } else {
            t.style.display = "none";
        }
        container.style.cursor = cursor;
        return;
    }

    if (i.type === "service") {
        const s = STATE.services.find((s) => s.id === i.id);
        if (s) {
            const load = s.processing.length / s.config.capacity;
            let loadColor =
                load > 0.8
                    ? "text-red-400"
                    : load > 0.4
                        ? "text-yellow-400"
                        : "text-green-400";

            // Base tooltip content with static info
            let content = `<strong class="text-blue-300">${s.config.name}</strong>`;
            if (s.tier)
                content += ` <span class="text-xs text-yellow-400">T${s.tier}</span>`;

            // Show health percentage
            const healthColor =
                s.health < 40
                    ? "text-red-400"
                    : s.health < 70
                        ? "text-yellow-400"
                        : "text-green-400";
            content += ` <span class="${healthColor}">${Math.round(
                s.health
            )}%</span>`;

            // Add static description and upkeep if available
            if (s.config.tooltip) {
                content += `<br><span class="text-xs text-gray-400">${s.config.tooltip.desc}</span>`;
                content += `<br><span class="text-xs text-gray-500">Upkeep: <span class="text-gray-300">${s.config.tooltip.upkeep}</span></span>`;
            }

            content += `<div class="mt-1 border-t border-gray-700 pt-1">`;

            // Service-specific dynamic stats
            if (s.type === "cache") {
                const hitRate = Math.round((s.config.cacheHitRate || 0.35) * 100);
                content += `Queue: <span class="${loadColor}">${s.queue.length}</span><br>
                Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                Hit Rate: <span class="text-green-400">${hitRate}%</span>`;
            } else if (s.type === "sqs") {
                const maxQ = s.config.maxQueueSize || 200;
                const fillPercent = Math.round((s.queue.length / maxQ) * 100);
                const status =
                    fillPercent > 80 ? "Critical" : fillPercent > 50 ? "Busy" : "Healthy";
                const statusColor =
                    fillPercent > 80
                        ? "text-red-400"
                        : fillPercent > 50
                            ? "text-yellow-400"
                            : "text-green-400";
                content += `Buffered: <span class="${loadColor}">${s.queue.length}/${maxQ}</span><br>
                Processing: ${s.processing.length}/${s.config.capacity}<br>
                Status: <span class="${statusColor}">${status}</span>`;
            } else {
                content += `Queue: <span class="${loadColor}">${s.queue.length}</span><br>
                Load: <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;
            }
            content += `</div>`;

            // Show upgrade option for upgradeable services
            if (
                (STATE.activeTool === "lambda" && s.type === "compute") ||
                (STATE.activeTool === "db" && s.type === "db") ||
                (STATE.activeTool === "cache" && s.type === "cache")
            ) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = "pointer";
                    const nextCost = tiers[s.tier].cost;
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-green-300 text-xs font-bold">Upgrade: $${nextCost}</span></div>`;
                    if (s.mesh.material.emissive)
                        s.mesh.material.emissive.setHex(0x333333);
                } else {
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-gray-500 text-xs">Max Tier</span></div>`;
                }
            }

            showTooltip(e.clientX + 15, e.clientY + 15, content);

            // Reset previous highlights
            STATE.services.forEach((svc) => {
                if (svc !== s && svc.mesh.material.emissive)
                    svc.mesh.material.emissive.setHex(0x000000);
            });
        }
    } else {
        t.style.display = "none";
        // Reset highlights when not hovering service
        STATE.services.forEach((svc) => {
            if (svc.mesh.material.emissive)
                svc.mesh.material.emissive.setHex(0x000000);
        });
    }

    container.style.cursor = cursor;
});

// Helper function for showing tooltips
function showTooltip(x, y, html) {
    const t = document.getElementById("tooltip");
    t.style.display = "block";
    t.style.left = x + "px";
    t.style.top = y + "px";
    t.innerHTML = html;
}

// Setup UI tooltips
function setupUITooltips() {
    const tools = ["waf", "sqs", "alb", "lambda", "db", "cache", "s3"];
    tools.forEach((toolId) => {
        const btn = document.getElementById(`tool-${toolId}`);
        if (!btn) return;

        // Map tool ID to config service key
        const serviceKey = toolId === "lambda" ? "compute" : toolId;
        const config = CONFIG.services[serviceKey];

        if (config && config.tooltip) {
            btn.addEventListener("mousemove", (e) => {
                const content = `
                    <strong class="text-blue-300">${config.name}</strong> <span class="text-green-400">$${config.cost}</span><br>
                    <span class="text-xs text-gray-400">${config.tooltip.desc}</span><br>
                    <div class="mt-1 pt-1 border-t border-gray-700 flex justify-between text-xs">
                        <span class="text-gray-500">Upkeep: <span class="text-gray-300">${config.tooltip.upkeep}</span></span>
                    </div>
                `;
                showTooltip(e.clientX + 15, e.clientY - 100, content); // Show above the button
            });

            btn.addEventListener("mouseleave", () => {
                document.getElementById("tooltip").style.display = "none";
            });
        }
    });
}

// Call setup
setupUITooltips();

container.addEventListener("mouseup", (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = "default";
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
        container.style.cursor = "default";
        return;
    }
});

function updateConnectionsForNode(nodeId) {
    STATE.connections.forEach((c) => {
        if (c.from === nodeId || c.to === nodeId) {
            const from =
                c.from === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === c.from);
            const to =
                c.to === "internet"
                    ? STATE.internetNode
                    : STATE.services.find((s) => s.id === c.to);

            if (!from || !to) return;

            const pts = [
                new THREE.Vector3(from.position.x, 1, from.position.z),
                new THREE.Vector3(to.position.x, 1, to.position.z),
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

    // Keyboard panning
    const moveSpeed = 50 * clampedDt; // Use unscaled time so we can move while paused
    // If zoomed in (zoom > 1), we might want to move slower, or just keep it constant world space
    // Constant world space is usually better.
    // Three.js OrthographicCamera zoom does not affect world coordinates directly, 
    // so moving camera.position by X moves it by X world units regardless of zoom.

    // Adjust speed based on zoom? Often players expect faster panning when zoomed out.
    // Let's try constant world speed first, maybe scale by 1/zoom if needed.
    const effectivePanSpeed = moveSpeed / camera.zoom;

    if (keysPressed["ArrowUp"] || keysPressed["w"] || keysPressed["W"]) {
        // Move camera target and position "up" (-Z in isometric-ish view? No, usually up is -Z in 3D)
        // Check pan logic: panY adds to Z. So Up should probably correspond to -Z.
        // Let's match the mouse panning logic:
        // dy (mouse down) -> panY (positive) -> z += panY.
        // So moving mouse down moves camera +Z.
        // Thus Up key should move camera -Z.
        if (isIsometric) {
            camera.position.x -= effectivePanSpeed;
            camera.position.z -= effectivePanSpeed;
            cameraTarget.x -= effectivePanSpeed;
            cameraTarget.z -= effectivePanSpeed;
        } else {
            camera.position.z -= effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowDown"] || keysPressed["s"] || keysPressed["S"]) {
        if (isIsometric) {
            camera.position.x += effectivePanSpeed;
            camera.position.z += effectivePanSpeed;
            cameraTarget.x += effectivePanSpeed;
            cameraTarget.z += effectivePanSpeed;
        } else {
            camera.position.z += effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowLeft"] || keysPressed["a"] || keysPressed["A"]) {
        // Mouse: dx (right) -> panX (negative) -> x += panX.
        // So moving mouse right moves camera -X.
        // Thus Right key should move camera +X? No wait.
        // If I drag mouse right, I expect world to move right? Or camera to move left?
        // Standard RTS: Mouse right -> Camera moves right -> World moves left.
        // Wait, the pan logic: dx = e.clientX - lastMouseX. If I move mouse right, dx > 0.
        // panX = (-dx...) -> panX < 0.
        // camera.x += panX (so camera decreases X).
        // So dragging mouse right moves camera LEFT. This is "drag the world" style.
        // For KEYS, pressing Right should move camera RIGHT.
        // So Right key should contain the OPPOSITE sign of panX for right-drag.
        // mouse right -> camera left.
        // key right -> camera right (x increasing).

        if (isIsometric) {
            camera.position.x -= effectivePanSpeed;
            camera.position.z += effectivePanSpeed;
            cameraTarget.x -= effectivePanSpeed;
            cameraTarget.z += effectivePanSpeed;
        } else {
            camera.position.x -= effectivePanSpeed;
        }
    }
    if (keysPressed["ArrowRight"] || keysPressed["d"] || keysPressed["D"]) {
        if (isIsometric) {
            camera.position.x += effectivePanSpeed;
            camera.position.z -= effectivePanSpeed;
            cameraTarget.x += effectivePanSpeed;
            cameraTarget.z -= effectivePanSpeed;
        } else {
            camera.position.x += effectivePanSpeed;
        }
    }

    if (isIsometric && (keysPressed["ArrowUp"] || keysPressed["w"] || keysPressed["W"] ||
        keysPressed["ArrowDown"] || keysPressed["s"] || keysPressed["S"] ||
        keysPressed["ArrowLeft"] || keysPressed["a"] || keysPressed["A"] ||
        keysPressed["ArrowRight"] || keysPressed["d"] || keysPressed["D"])) {
        camera.lookAt(cameraTarget);
    } else if (!isIsometric) {
        // Simple top down
        // already handled by pos update
    }

    STATE.services.forEach((s) => s.update(dt));
    STATE.requests.forEach((r) => r.update(dt));

    STATE.spawnTimer += dt;
    // Apply traffic burst multiplier from random events
    const effectiveRPS =
        STATE.currentRPS * (STATE.intervention?.trafficBurstMultiplier || 1.0);
    if (effectiveRPS > 0) {
        const spawnInterval = 1 / effectiveRPS;
        // Spawn multiple requests if timeScale causes large dt jumps
        // This ensures correct spawn rate even when fast forwarding
        while (STATE.spawnTimer >= spawnInterval) {
            STATE.spawnTimer -= spawnInterval;
            spawnRequest();
        }
        // Only ramp up in survival mode - use logarithmic growth
        if (STATE.gameMode === "survival") {
            const gameTime = STATE.elapsedGameTime;
            const targetRPS = calculateTargetRPS(gameTime);

            // Smooth transition to target
            STATE.currentRPS += (targetRPS - STATE.currentRPS) * 0.01;
            STATE.currentRPS = Math.min(STATE.currentRPS, CONFIG.survival.maxRPS);
        }
    }

    updateMaliciousSpike(dt);

    // Intervention mechanics updates
    updateTrafficShift(dt);
    updateRandomEvents(dt);
    updateServiceHealthIndicators();
    updateActiveEventTimer();
    processAutoRepair(dt);
    updateFinancesDisplay();

    document.getElementById("money-display").innerText = `$${Math.floor(
        STATE.money
    )}`;

    const baseUpkeep = STATE.services.reduce(
        (sum, s) => sum + s.config.upkeep / 60,
        0
    );
    const multiplier =
        typeof getUpkeepMultiplier === "function" ? getUpkeepMultiplier() : 1.0;
    const autoRepairCost =
        typeof getAutoRepairUpkeep === "function" ? getAutoRepairUpkeep() : 0;
    const totalUpkeep = baseUpkeep * multiplier + autoRepairCost;

    // Deduct auto-repair cost and track it
    if (autoRepairCost > 0 && STATE.upkeepEnabled) {
        const cost = autoRepairCost * dt;
        STATE.money -= cost;
        if (STATE.finances) STATE.finances.expenses.autoRepair += cost;
    }

    const upkeepDisplay = document.getElementById("upkeep-display");
    if (upkeepDisplay) {
        if (autoRepairCost > 0) {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s (+repair)`;
            upkeepDisplay.className = "text-orange-400 font-mono";
        } else if (multiplier > 1.05) {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(
                2
            )}/s (×${multiplier.toFixed(2)})`;
            upkeepDisplay.className = "text-red-400 font-mono";
        } else {
            upkeepDisplay.innerText = `-$${totalUpkeep.toFixed(2)}/s`;
            upkeepDisplay.className = "text-red-400 font-mono";
        }
    }

    if (STATE.gameMode === "survival") {
        const staticEl = document.getElementById("mix-static");
        const readEl = document.getElementById("mix-read");
        const writeEl = document.getElementById("mix-write");
        const uploadEl = document.getElementById("mix-upload");
        const searchEl = document.getElementById("mix-search");
        const maliciousEl = document.getElementById("mix-malicious");

        if (staticEl)
            staticEl.textContent =
                Math.round((STATE.trafficDistribution.STATIC || 0) * 100) + "%";
        if (readEl)
            readEl.textContent =
                Math.round((STATE.trafficDistribution.READ || 0) * 100) + "%";
        if (writeEl)
            writeEl.textContent =
                Math.round((STATE.trafficDistribution.WRITE || 0) * 100) + "%";
        if (uploadEl)
            uploadEl.textContent =
                Math.round((STATE.trafficDistribution.UPLOAD || 0) * 100) + "%";
        if (searchEl)
            searchEl.textContent =
                Math.round((STATE.trafficDistribution.SEARCH || 0) * 100) + "%";
        if (maliciousEl && !STATE.maliciousSpikeActive)
            maliciousEl.textContent =
                Math.round((STATE.trafficDistribution.MALICIOUS || 0) * 100) + "%";
    }

    STATE.reputation = Math.min(100, STATE.reputation);
    document.getElementById("rep-bar").style.width = `${Math.max(
        0,
        STATE.reputation
    )}%`;
    document.getElementById("rep-display").textContent = `${Math.round(
        Math.max(0, STATE.reputation)
    )}%`;
    document.getElementById(
        "rps-display"
    ).innerText = `${STATE.currentRPS.toFixed(1)} req/s`;

    // Update elapsed time
    const elapsedEl = document.getElementById("elapsed-time");
    if (elapsedEl) {
        elapsedEl.textContent = formatTime(STATE.elapsedGameTime);
    }

    // Update next RPS milestone (survival mode only)
    const rpsNextEl = document.getElementById("rps-next");
    const rpsCountdownEl = document.getElementById("rps-countdown");
    const rpsMilestoneRow = document.getElementById("rps-milestone-row");

    if (STATE.gameMode === "survival" && rpsMilestoneRow) {
        rpsMilestoneRow.style.display = "flex";

        // Show next RPS acceleration milestone instead of arbitrary integer
        const milestones = CONFIG.survival.rpsAcceleration?.milestones || [];
        const currentTime = STATE.elapsedGameTime;

        // Find next upcoming milestone
        let nextMilestone = null;
        for (const m of milestones) {
            if (m.time > currentTime) {
                nextMilestone = m;
                break;
            }
        }

        if (rpsNextEl && rpsCountdownEl) {
            if (nextMilestone) {
                const timeRemaining = Math.max(0, nextMilestone.time - currentTime);

                rpsNextEl.textContent = `×${nextMilestone.multiplier.toFixed(1)}`;
                rpsCountdownEl.textContent = formatTime(timeRemaining);
            } else {
                // All milestones reached
                rpsNextEl.textContent = "MAX";
                rpsCountdownEl.textContent = "--";
            }
        }
    } else if (rpsMilestoneRow) {
        rpsMilestoneRow.style.display = "none";
    }

    // Update failures panel with table format
    const totalFailures = Object.values(STATE.failures).reduce(
        (a, b) => a + b,
        0
    );
    const failuresPanel = document.getElementById("failures-panel");
    const points = CONFIG.survival.SCORE_POINTS;
    if (totalFailures > 0 && failuresPanel) {
        failuresPanel.classList.remove("hidden");
        document.getElementById(
            "failures-total"
        ).textContent = `${totalFailures} total`;

        // Update counts
        document.getElementById("fail-malicious").textContent =
            STATE.failures.MALICIOUS;
        document.getElementById("fail-static").textContent = STATE.failures.STATIC;
        document.getElementById("fail-read").textContent = STATE.failures.READ;
        document.getElementById("fail-write").textContent = STATE.failures.WRITE;
        document.getElementById("fail-upload").textContent = STATE.failures.UPLOAD;
        document.getElementById("fail-search").textContent = STATE.failures.SEARCH;

        // Update reputation loss (malicious = -8, others = -2)
        document.getElementById("fail-malicious-rep").textContent =
            STATE.failures.MALICIOUS * Math.abs(points.MALICIOUS_PASSED_REPUTATION);
        document.getElementById("fail-static-rep").textContent =
            STATE.failures.STATIC * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-read-rep").textContent =
            STATE.failures.READ * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-write-rep").textContent =
            STATE.failures.WRITE * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-upload-rep").textContent =
            STATE.failures.UPLOAD * Math.abs(points.FAIL_REPUTATION);
        document.getElementById("fail-search-rep").textContent =
            STATE.failures.SEARCH * Math.abs(points.FAIL_REPUTATION);

        // Hide rows with 0 failures
        document.getElementById("fail-row-malicious").style.display =
            STATE.failures.MALICIOUS > 0 ? "" : "none";
        document.getElementById("fail-row-static").style.display =
            STATE.failures.STATIC > 0 ? "" : "none";
        document.getElementById("fail-row-read").style.display =
            STATE.failures.READ > 0 ? "" : "none";
        document.getElementById("fail-row-write").style.display =
            STATE.failures.WRITE > 0 ? "" : "none";
        document.getElementById("fail-row-upload").style.display =
            STATE.failures.UPLOAD > 0 ? "" : "none";
        document.getElementById("fail-row-search").style.display =
            STATE.failures.SEARCH > 0 ? "" : "none";
    }

    if (STATE.internetNode.ring) {
        if (STATE.selectedNodeId === "internet") {
            STATE.internetNode.ring.material.opacity = 1.0;
        } else {
            STATE.internetNode.ring.material.opacity = 0.2;
        }
    }

    // Game over only in survival mode
    if (
        STATE.gameMode === "survival" &&
        (STATE.reputation <= 0 || STATE.money <= -1000)
    ) {
        STATE.isRunning = false;

        // Determine failure reason and generate tips
        const failureAnalysis = analyzeFailure();

        document.getElementById("modal-title").innerText = "SYSTEM FAILURE";
        document.getElementById("modal-title").classList.add("text-red-500");
        document.getElementById("modal-desc").innerHTML = `
            <div class="text-left space-y-3">
                <div class="text-center text-2xl font-bold text-yellow-400 mb-2">Final Score: ${STATE.score.total
            }</div>
                <div class="text-center text-sm text-gray-400 mb-4">Survived: ${formatTime(
                STATE.elapsedGameTime || 0
            )}</div>
                
                <div class="bg-red-900/30 border border-red-500/50 rounded-lg p-3">
                    <div class="text-red-400 font-bold text-sm uppercase mb-1">⚠️ Failure Reason</div>
                    <div class="text-white">${failureAnalysis.reason}</div>
                </div>
                
                <div class="bg-blue-900/30 border border-blue-500/50 rounded-lg p-3">
                    <div class="text-blue-400 font-bold text-sm uppercase mb-1">📊 Analysis</div>
                    <div class="text-gray-300 text-sm">${failureAnalysis.description
            }</div>
                </div>
                
                <div class="bg-green-900/30 border border-green-500/50 rounded-lg p-3">
                    <div class="text-green-400 font-bold text-sm uppercase mb-1">💡 Tips for Next Time</div>
                    <ul class="text-gray-300 text-sm list-disc list-inside space-y-1">
                        ${failureAnalysis.tips
                .map((tip) => `<li>${tip}</li>`)
                .join("")}
                    </ul>
                </div>
            </div>
        `;
        document.getElementById("modal").classList.remove("hidden");
        STATE.sound.playGameOver();
    }

    renderer.render(scene, camera);
}

// Analyze why the player failed and generate helpful tips
function analyzeFailure() {
    const result = {
        reason: "",
        description: "",
        tips: [],
    };

    // Determine primary failure reason
    if (STATE.reputation <= 0) {
        result.reason = "Reputation Collapsed";

        // Check what caused reputation loss
        const totalFailures = Object.values(STATE.failures).reduce(
            (a, b) => a + b,
            0
        );
        const maliciousFailures = STATE.failures.MALICIOUS || 0;

        if (maliciousFailures > totalFailures * 0.3) {
            result.description = `Too many malicious requests got through (${maliciousFailures} attacks passed). Each unblocked attack costs -5 reputation.`;
            result.tips.push("Add a WAF (Firewall) as your first line of defense");
            result.tips.push("Multiple WAFs can handle traffic spikes better");
        } else {
            const worstFailure = Object.entries(STATE.failures)
                .filter(([k]) => k !== "MALICIOUS")
                .sort((a, b) => b[1] - a[1])[0];

            if (worstFailure && worstFailure[1] > 0) {
                result.description = `Too many ${worstFailure[0]} requests failed (${worstFailure[1]} failures). Failed requests damage your reputation.`;

                if (worstFailure[0] === "STATIC" || worstFailure[0] === "UPLOAD") {
                    result.tips.push(
                        "Add more S3 Storage nodes for STATIC/UPLOAD traffic"
                    );
                } else {
                    result.tips.push("Add more Database nodes or upgrade existing ones");
                    result.tips.push("Use Cache to reduce database load");
                }
            } else {
                result.description =
                    "Requests were failing faster than your infrastructure could handle.";
            }
        }

        result.tips.push("Add Queue (SQS) to buffer traffic during spikes");
        result.tips.push("Monitor the health panel and repair damaged services");
    } else if (STATE.money <= -1000) {
        result.reason = "Bankruptcy";
        result.description = `You ran out of money ($${Math.floor(
            STATE.money
        )}). Upkeep costs exceeded your income from processed requests.`;

        // Analyze spending
        if (STATE.finances) {
            const upkeepRatio =
                STATE.finances.expenses.upkeep / (STATE.finances.income.total || 1);
            if (upkeepRatio > 0.8) {
                result.tips.push("Your upkeep costs were too high relative to income");
                result.tips.push(
                    "Start with fewer services and scale up as income grows"
                );
            }

            if (STATE.finances.expenses.repairs > STATE.finances.income.total * 0.2) {
                result.tips.push(
                    "Repair costs were eating into profits - enable Auto-Repair early"
                );
            }
        }

        result.tips.push("Focus on processing more requests to increase income");
        result.tips.push("Use Cache to speed up request processing");
        result.tips.push("Cheaper services (WAF, S3) have lower upkeep");
    }

    // Add general tips based on game state
    if (STATE.services.length < 3) {
        result.tips.push("Build a complete pipeline: WAF → ALB → Compute → DB/S3");
    }

    if (!STATE.services.some((s) => s.type === "cache")) {
        result.tips.push("Add Cache to improve hit rates and reduce DB load");
    }

    // Limit tips to 4
    result.tips = result.tips.slice(0, 4);

    return result;
}

window.addEventListener("resize", () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -d * aspect;
    camera.right = d * aspect;
    camera.top = d;
    camera.bottom = -d;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        // Toggle main menu
        const menu = document.getElementById("main-menu-modal");
        if (menu.classList.contains("hidden")) {
            openMainMenu();
        } else if (STATE.gameStarted && STATE.isRunning) {
            resumeGame();
        }
        return;
    }
    if (event.key === "H" || event.key === "h") {
        document.getElementById("statsPanel").classList.toggle("hidden");
        document.getElementById("detailsPanel").classList.toggle("hidden");
        document.getElementById("objectivesPanel").classList.toggle("hidden");
    }
    if (event.key === "R" || event.key === "r") {
        resetCamera();
    }
    if (event.key === "T" || event.key === "t") {
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
    syncInput("budget", v);
};

window.resetBudget = () => {
    STATE.money = STATE.sandboxBudget;
};

window.setSandboxRPS = (value) => {
    const v = Math.max(0, parseFloat(value) || 0);
    STATE.currentRPS = v;
    syncInput("rps", v);
};

window.setTrafficMix = (type, value) => {
    const v = Math.max(0, Math.min(100, parseFloat(value) || 0));
    STATE.trafficDistribution[type] = v / 100;
    syncInput(type.toLowerCase(), v);
};

window.setBurstCount = (value) => {
    const v = Math.max(1, parseInt(value) || 10);
    STATE.burstCount = v;
    syncInput("burst", v);
};

window.spawnBurst = (type) => {
    for (let i = 0; i < STATE.burstCount; i++) {
        setTimeout(() => {
            const req = new Request(type);
            STATE.requests.push(req);
            const conns = STATE.internetNode.connections;
            if (conns.length > 0) {
                const entryNodes = conns.map((id) =>
                    STATE.services.find((s) => s.id === id)
                );
                const wafEntry = entryNodes.find((s) => s?.type === "waf");
                const target =
                    wafEntry || entryNodes[Math.floor(Math.random() * entryNodes.length)];
                if (target) req.flyTo(target);
                else failRequest(req);
            } else {
                failRequest(req);
            }
        }, i * 30);
    }
};

window.toggleUpkeep = () => {
    STATE.upkeepEnabled = !STATE.upkeepEnabled;
    const btn = document.getElementById("upkeep-toggle");
    if (btn) {
        btn.textContent = STATE.upkeepEnabled ? "Upkeep: ON" : "Upkeep: OFF";
        btn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
        btn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
    }
};

window.clearAllServices = () => {
    STATE.services.forEach((s) => s.destroy());
    STATE.services = [];
    STATE.connections.forEach((c) => connectionGroup.remove(c.mesh));
    STATE.connections = [];
    STATE.internetNode.connections = [];
    STATE.requests.forEach((r) => r.destroy());
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
    const resumeBtn = document.getElementById("resume-btn");
    if (resumeBtn) {
        if (STATE.gameStarted && STATE.isRunning) {
            resumeBtn.classList.remove("hidden");
        } else {
            resumeBtn.classList.add("hidden");
        }
    }

    // Check for saved game and show/hide load button
    const loadBtn = document.getElementById("load-btn");
    const hasSave = localStorage.getItem("serverSurvivalSave") !== null;
    if (loadBtn) {
        loadBtn.style.display = hasSave ? "block" : "none";
    }

    // Show main menu
    document.getElementById("main-menu-modal").classList.remove("hidden");
    STATE.sound.playMenuBGM();
}

window.resumeGame = () => {
    // Hide main menu, keep game paused
    document.getElementById("main-menu-modal").classList.add("hidden");
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
            version: "2.0",
            ...STATE,
            score: { ...STATE.score },
            trafficDistribution: { ...STATE.trafficDistribution },
            services: STATE.services.map((service) => ({
                id: service.id,
                type: service.type,
                position: [service.position.x, service.position.y, service.position.z],
                connections: [...service.connections],
                tier: service.tier,
                cacheHitRate: service.config.cacheHitRate || null,
            })),
            connections: STATE.connections.map((conn) => ({
                from: conn.from,
                to: conn.to,
            })),
            requests: [],
            internetConnections: [...STATE.internetNode.connections],
        };

        localStorage.setItem("serverSurvivalSave", JSON.stringify(saveData));

        const saveBtn = document.getElementById("btn-save");
        const originalColor = saveBtn.classList.contains("hover:border-green-500")
            ? ""
            : saveBtn.style.borderColor;
        saveBtn.style.borderColor = "#10b981"; // green-500
        saveBtn.style.color = "#10b981";
        setTimeout(() => {
            saveBtn.style.borderColor = originalColor;
            saveBtn.style.color = "";
        }, 1000);

        STATE.sound.playPlace(); // Use place sound as feedback
    } catch (error) {
        console.error("Failed to save game:", error);
        alert("Failed to save game. Please try again.");
    }
};

function migrateOldSave(saveData) {
    if (saveData.trafficDistribution) {
        const oldDist = saveData.trafficDistribution;
        if ("WEB" in oldDist || "API" in oldDist || "FRAUD" in oldDist) {
            saveData.trafficDistribution = {
                STATIC: oldDist.WEB || 0,
                READ: (oldDist.API || 0) * 0.5,
                WRITE: (oldDist.API || 0) * 0.3,
                UPLOAD: 0.05,
                SEARCH: (oldDist.API || 0) * 0.2,
                MALICIOUS: oldDist.FRAUD || 0,
            };
        }
    }

    if (saveData.score) {
        const oldScore = saveData.score;
        if ("web" in oldScore || "api" in oldScore || "fraudBlocked" in oldScore) {
            saveData.score = {
                total: oldScore.total || 0,
                storage: oldScore.web || 0,
                database: oldScore.api || 0,
                maliciousBlocked: oldScore.fraudBlocked || 0,
            };
        }
    }

    if ("fraudSpikeTimer" in saveData) {
        saveData.maliciousSpikeTimer = saveData.fraudSpikeTimer;
        delete saveData.fraudSpikeTimer;
    }
    if ("fraudSpikeActive" in saveData) {
        saveData.maliciousSpikeActive = saveData.fraudSpikeActive;
        delete saveData.fraudSpikeActive;
    }

    return saveData;
}

window.loadGameState = () => {
    try {
        const saveDataStr = localStorage.getItem("serverSurvivalSave");
        if (!saveDataStr) {
            alert("No saved game found.");
            return;
        }

        let saveData = JSON.parse(saveDataStr);

        if (!saveData.version || saveData.version === "1.0") {
            saveData = migrateOldSave(saveData);
        }

        clearCurrentGame();

        STATE.money = saveData.money || 0;
        STATE.reputation = saveData.reputation || 100;
        STATE.requestsProcessed = saveData.requestsProcessed || 0;
        STATE.score = { ...saveData.score } || {
            total: 0,
            storage: 0,
            database: 0,
            maliciousBlocked: 0,
        };
        STATE.activeTool = saveData.activeTool || "select";
        STATE.selectedNodeId = saveData.selectedNodeId || null;
        STATE.lastTime = performance.now(); // Reset timing
        STATE.spawnTimer = saveData.spawnTimer || 0;
        STATE.currentRPS = saveData.currentRPS || 0.5;
        STATE.timeScale = saveData.timeScale || 0; // Start paused
        STATE.elapsedGameTime = saveData.elapsedGameTime ?? 0;
        STATE.isRunning = saveData.isRunning || false;
        STATE.gameStartTime = performance.now();

        STATE.gameMode = saveData.gameMode || "survival";
        STATE.sandboxBudget = saveData.sandboxBudget || 2000;
        STATE.upkeepEnabled = saveData.upkeepEnabled !== false;
        STATE.trafficDistribution = { ...saveData.trafficDistribution } || {
            STATIC: 0.3,
            READ: 0.2,
            WRITE: 0.15,
            UPLOAD: 0.05,
            SEARCH: 0.1,
            MALICIOUS: 0.2,
        };
        STATE.burstCount = saveData.burstCount || 10;
        STATE.gameStarted = saveData.gameStarted || true;
        STATE.previousTimeScale = saveData.previousTimeScale || 1;

        restoreServices(saveData.services);

        restoreConnections(
            saveData.connections,
            saveData.internetConnections || []
        );

        updateScoreUI();
        document.getElementById("money-display").innerText = `$${Math.floor(
            STATE.money
        )}`;
        document.getElementById("rep-bar").style.width = `${Math.max(
            0,
            STATE.reputation
        )}%`;
        document.getElementById(
            "rps-display"
        ).innerText = `${STATE.currentRPS.toFixed(1)} req/s`;

        const sandboxPanel = document.getElementById("sandboxPanel");
        const objectivesPanel = document.getElementById("objectivesPanel");

        if (STATE.gameMode === "sandbox") {
            if (sandboxPanel) sandboxPanel.classList.remove("hidden");
            if (objectivesPanel) objectivesPanel.classList.add("hidden");
            syncInput("budget", STATE.sandboxBudget);
            syncInput("rps", STATE.currentRPS);
            syncInput("static", (STATE.trafficDistribution.STATIC || 0) * 100);
            syncInput("read", (STATE.trafficDistribution.READ || 0) * 100);
            syncInput("write", (STATE.trafficDistribution.WRITE || 0) * 100);
            syncInput("upload", (STATE.trafficDistribution.UPLOAD || 0) * 100);
            syncInput("search", (STATE.trafficDistribution.SEARCH || 0) * 100);
            syncInput("malicious", (STATE.trafficDistribution.MALICIOUS || 0) * 100);
            syncInput("burst", STATE.burstCount);
            const upkeepBtn = document.getElementById("upkeep-toggle");
            if (upkeepBtn) {
                upkeepBtn.textContent = STATE.upkeepEnabled
                    ? "Upkeep: ON"
                    : "Upkeep: OFF";
                upkeepBtn.classList.toggle("bg-red-900/50", STATE.upkeepEnabled);
                upkeepBtn.classList.toggle("bg-green-900/50", !STATE.upkeepEnabled);
            }
        } else {
            if (sandboxPanel) sandboxPanel.classList.add("hidden");
            if (objectivesPanel) objectivesPanel.classList.remove("hidden");
        }

        document.getElementById("main-menu-modal").classList.add("hidden");

        if (!STATE.animationId) {
            animate(performance.now());
        }

        STATE.sound.playPlace();
    } catch (error) {
        console.error("Failed to load game:", error);
        alert("Failed to load game. The save file may be corrupted.");
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

    STATE.services.forEach((s) => s.destroy());
    STATE.services = [];
    STATE.requests = [];
    STATE.connections = [];
    STATE.internetNode.connections = [];
}

function restoreServices(savedServices) {
    savedServices.forEach((serviceData) => {
        const position = new THREE.Vector3(
            serviceData.position[0],
            serviceData.position[1],
            serviceData.position[2]
        );

        restoreService(serviceData, position);
    });
}

function restoreConnections(savedConnections, internetConnections) {
    internetConnections.forEach((connData) => {
        createConnection(connData.from, connData.to);
    });

    savedConnections.forEach((connData) => {
        createConnection(connData.from, connData.to);
    });
}
