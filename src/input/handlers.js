// Input layer (#155 PR 8): the pointer/keyboard/camera handlers from
// game.js — canvas raycast picking, wheel zoom, the upgrade indicator,
// held-key tracking, the big mousedown/mousemove/mouseup drag/pan/orbit/
// connect/place handlers with their state, hover + toolbar tooltips, window
// resize, the document-level shortcuts (Esc/H/R/T), and the view toggle /
// camera reset / turntable orbit (#231). Code moved verbatim from game.js; importing this module registers
// every listener as a side effect (no events can fire until the module
// graph finishes evaluating, so registration order is unobservable).
// game.js's animate loop reads the exported input state via live bindings.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { addInterventionWarning } from "../core/events.js";
import {
    canAutoscale,
    instanceCount,
    toggleAutoscaling,
    warmingCount,
} from "../sim/autoscaling.js";
import { SERVICE_CATEGORIES, setToolbarCategory } from "../ui/toolbar.js";
import {
    createConnection,
    createService,
    deleteConnection,
    deleteObject,
    getConnectionAtPoint,
    snapToGrid,
    updateConnectionsForNode,
} from "../sim/topology.js";
// Runtime-only cycle (game.js ⇄ handlers.js) — established pattern: these
// are top-level consts / hoisted declarations in game.js, only dereferenced
// at event time (or, for resetCamera's camera/cameraTarget reads, when
// game.js's own body calls it), long after both modules evaluate.
import {
    applyCameraFrustum,
    camera,
    cameraTarget,
    mouse,
    openMainMenu,
    plane,
    raycaster,
    renderer,
    serviceGroup,
} from "../../game.js";

const container = document.getElementById("canvas-container");

// Tool id → CONFIG.services type for ground placement. This map IS the
// placement gate: a click places iff the active tool has an entry here.
// It used to be shadowed by a separate hardcoded allowlist that silently
// drifted — five services were selectable in the toolbar but no-ops on the
// canvas, which made Level 15 unwinnable (#227). tests/sim/placement.test.mjs
// pins this map against CONFIG.services so it cannot drift again.
export const PLACEMENT_TYPE_MAP = {
    waf: "waf",
    alb: "alb",
    lambda: "compute",
    db: "db",
    nosql: "nosql",
    s3: "s3",
    sqs: "sqs",
    cache: "cache",
    apigw: "apigw",
    cdn: "cdn",
    search: "search",
    replica: "replica",
    serverless: "serverless",
    monitor: "monitor",
    dlq: "dlq",
    pubsub: "pubsub",
    auth: "auth",
    scheduler: "scheduler",
    notify: "notify",
    container: "container",
    stream: "stream",
    dns: "dns",
    warehouse: "warehouse",
    gpu: "gpu",
    infgw: "infgw",
    power: "power",
};

let isDraggingNode = false;
let draggedNode = null;
let dragOffset = new THREE.Vector3();
let dragStartPos = new THREE.Vector3();

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

// Camera orbit (#231): the isometric view rotates around cameraTarget on a
// turntable — ONE azimuth angle, elevation fixed. A free trackball (Blender
// style) would fight the orthographic projection and grid readability, so
// pitch stays put. Session state only, like zoom — nothing persisted.
const DEFAULT_AZIMUTH = Math.PI / 4; // camera at (+40, 40, +40) — the classic view
const ORBIT_RADIUS = Math.SQRT2 * 40; // horizontal distance to the target
const ORBIT_HEIGHT = 40; // fixed elevation — the isometric feel
let cameraAzimuth = DEFAULT_AZIMUTH;
let isOrbiting = false;

// The one writer of camera.position in isometric view: pan moves
// cameraTarget, orbit moves the angle, reset does both — and they all funnel
// through here instead of hard-setting the position in three places.
function applyCameraOrbit() {
    if (isIsometric) {
        // Looking down at an angle: the default up vector is correct, but it
        // must be RESTORED here — the top-down branch below rotates it, and a
        // T toggle back would otherwise inherit a tilted horizon.
        camera.up.set(0, 1, 0);
        camera.position.set(
            cameraTarget.x + ORBIT_RADIUS * Math.cos(cameraAzimuth),
            cameraTarget.y + ORBIT_HEIGHT,
            cameraTarget.z + ORBIT_RADIUS * Math.sin(cameraAzimuth)
        );
        camera.lookAt(cameraTarget);
    } else {
        // Top-down rotation (#231 follow-up): looking straight down, azimuth
        // can't move the eye — it spins the camera's UP vector instead, which
        // rotates the grid on screen. delta = 0 reproduces the pre-rotation
        // orientation (screen-up = -z, "north up") exactly.
        const delta = cameraAzimuth - DEFAULT_AZIMUTH;
        camera.up.set(-Math.sin(delta), 0, -Math.cos(delta));
        camera.lookAt(camera.position.x, 0, camera.position.z);
    }
}

// Q/E and drag-orbit both land here. In isometric view the eye orbits the
// target; in top-down the grid spins in place (up-vector rotation) — same
// azimuth state, so T toggles between the two without losing the angle,
// and R resets both.
function orbitCamera(deltaRadians) {
    cameraAzimuth += deltaRadians;
    applyCameraOrbit();
}

// Screen-relative pan: +rightUnits slides the view along the screen's X axis,
// +upUnits along its Y (world units on the ground plane). In isometric view
// the basis rotates WITH the azimuth — after a 90° orbit "up" is still "away
// from the camera" — which is why callers can't just add to x/z anymore.
function panCameraScreen(rightUnits, upUnits) {
    if (isIsometric) {
        const cos = Math.cos(cameraAzimuth);
        const sin = Math.sin(cameraAzimuth);
        // Ground projections at azimuth θ: screen-right = (sin θ, -cos θ),
        // screen-up = (-cos θ, -sin θ). At the default 45° these reproduce
        // the old hardcoded (±1, ±1) key-pan diagonals exactly.
        cameraTarget.x += sin * rightUnits - cos * upUnits;
        cameraTarget.z += -cos * rightUnits - sin * upUnits;
        applyCameraOrbit();
    } else {
        // Same idea top-down: the pan basis rotates with the spun grid, so
        // "up" always slides the board toward the top of the SCREEN. At
        // delta = 0 this is the old (+x, -z) mapping exactly.
        const delta = cameraAzimuth - DEFAULT_AZIMUTH;
        const cos = Math.cos(delta);
        const sin = Math.sin(delta);
        camera.position.x += cos * rightUnits - sin * upUnits;
        camera.position.z += -sin * rightUnits - cos * upUnits;
        applyCameraOrbit();
    }
}

// A screen-space drag delta (pixels) to a camera pan. Shared by the mouse
// pan-drag and the two-finger touch pan (#12) — both just measure how far a
// pointer moved between frames and hand the pixels here.
function panByScreenDelta(dx, dy) {
    const panX = ((-dx * (camera.right - camera.left)) / window.innerWidth) * panSpeed;
    const panY = ((dy * (camera.top - camera.bottom)) / window.innerHeight) * panSpeed;
    // panX slides along the screen's X, panY along its Y — panCameraScreen
    // rotates that into world XZ by the current azimuth (#231), so dragging
    // behaves the same from any angle. Both signs are negative-of-delta:
    // screen Y grows downward, which is why the vertical term needs +dy
    // rather than the -dy it would take in world space (#242).
    panCameraScreen(panX, panY);
}

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

let currentZoom = 1;
const minZoom = 0.5;
const maxZoom = 3.0;
const zoomSpeed = 0.001;

// Shared by the wheel and the touch pinch (#12) — both just compute a target
// zoom level by their own means and hand it here for the clamp + apply.
function setZoom(target) {
    const clamped = Math.max(minZoom, Math.min(maxZoom, target));
    if (clamped !== currentZoom) {
        currentZoom = clamped;
        // For OrthographicCamera, zoom is applied via dividing the frustum or using the zoom property
        // Three.js OrthographicCamera has a .zoom property
        camera.zoom = currentZoom;
        camera.updateProjectionMatrix();
    }
}

container.addEventListener("wheel", (e) => {
    e.preventDefault();
    setZoom(currentZoom + e.deltaY * -zoomSpeed);
}, { passive: false });

// Upgrade Indicator Logic
// Upgrade Indicator Logic
let hoveredUpgradeService = null;
let hideUpgradeTimer = null;
const upgradeIndicator = document.getElementById("upgrade-indicator");
const upgradeCostEl = document.getElementById("upgrade-cost");

if (upgradeIndicator) {
    upgradeIndicator.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent map click
        if (hoveredUpgradeService) {
            hoveredUpgradeService.upgrade();

            // Immediate UI update
            const tiers = CONFIG.services[hoveredUpgradeService.type].tiers;
            if (hoveredUpgradeService.tier < tiers.length) {
                const nextCost = tiers[hoveredUpgradeService.tier].cost;
                upgradeCostEl.textContent = `$${nextCost}`;

                if (STATE.money < nextCost) {
                    upgradeCostEl.classList.remove("bg-green-600", "border-green-400");
                    upgradeCostEl.classList.add("bg-red-600", "border-red-400");
                } else {
                    upgradeCostEl.classList.remove("bg-red-600", "border-red-400");
                    upgradeCostEl.classList.add("bg-green-600", "border-green-400");
                }
            } else {
                // Max tier reached - hide immediately
                hoveredUpgradeService = null;
                upgradeIndicator.classList.add("hidden");
                if (hideUpgradeTimer) {
                    clearTimeout(hideUpgradeTimer);
                    hideUpgradeTimer = null;
                }
            }
        }
    });

    // Prevent hiding when hovering the indicator itself
    upgradeIndicator.addEventListener("mouseenter", () => {
        if (hideUpgradeTimer) {
            clearTimeout(hideUpgradeTimer);
            hideUpgradeTimer = null;
        }
    });

    // Start hide timer when leaving indicator
    upgradeIndicator.addEventListener("mouseleave", () => {
        if (hoveredUpgradeService) {
            hideUpgradeTimer = setTimeout(() => {
                hoveredUpgradeService = null;
                upgradeIndicator.classList.add("hidden");
                hideUpgradeTimer = null;
            }, 300);
        }
    });
}

// Auto-Scaling toggle (#195). Same hover/hide-timer pattern as the upgrade
// indicator above, but for Compute only: it floats UNDER the node, shows
// "AUTO n/max" while the group is on, and pulses with a "+n warming" hint
// while instances are cold-starting. The animate loop replays the last
// mousemove at ~4 Hz (#173), so the counters tick live without extra wiring.
let hoveredAsgService = null;
let hideAsgTimer = null;
const asgIndicator = document.getElementById("asg-indicator");
const asgBadge = document.getElementById("asg-badge");
const asgLabel = document.getElementById("asg-label");
const asgWarmingEl = document.getElementById("asg-warming");

const ASG_ON_CLASSES = ["bg-teal-900/80", "text-teal-200", "border-teal-400"];
const ASG_OFF_CLASSES = ["bg-gray-800", "text-gray-300", "border-gray-500"];

function hideAsgIndicator() {
    hoveredAsgService = null;
    if (asgIndicator) asgIndicator.classList.add("hidden");
    hideAsgTimer = null;
}

function scheduleAsgHide() {
    if (hoveredAsgService && !hideAsgTimer) {
        hideAsgTimer = setTimeout(hideAsgIndicator, 300);
    }
}

function paintAsgIndicator(service) {
    if (!asgIndicator || !asgBadge || !asgLabel || !asgWarmingEl) return;
    const max = CONFIG.autoscaling.maxInstances;
    const warming = warmingCount(service);

    asgLabel.textContent = service.asgEnabled
        ? `${i18n.t("asg_label")} ${instanceCount(service)}/${max}`
        : `${i18n.t("asg_label")} ${i18n.t("asg_off")}`;
    asgIndicator.title = service.asgEnabled
        ? i18n.t("asg_disable_tip")
        : i18n.t("asg_enable_tip");

    asgBadge.classList.remove(...ASG_ON_CLASSES, ...ASG_OFF_CLASSES);
    asgBadge.classList.add(...(service.asgEnabled ? ASG_ON_CLASSES : ASG_OFF_CLASSES));
    asgBadge.classList.toggle("animate-pulse", warming > 0);

    asgWarmingEl.textContent = warming > 0 ? i18n.t("asg_warming", { n: warming }) : "";
    asgWarmingEl.classList.toggle("hidden", warming === 0);
}

function showAsgIndicator(service) {
    if (!asgIndicator) return;
    if (hideAsgTimer) {
        clearTimeout(hideAsgTimer);
        hideAsgTimer = null;
    }
    hoveredAsgService = service;

    // Project the node's base to screen space so the badge sits below it.
    const pos = service.mesh.position.clone();
    pos.y -= 1.5;
    pos.project(camera);
    asgIndicator.style.left = `${(pos.x * 0.5 + 0.5) * container.clientWidth}px`;
    asgIndicator.style.top = `${(pos.y * -0.5 + 0.5) * container.clientHeight}px`;
    asgIndicator.classList.remove("hidden");

    paintAsgIndicator(service);
}

if (asgIndicator) {
    asgIndicator.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let the map handler place/select behind it
        if (!hoveredAsgService) return;
        // The node may have been deleted while the badge was still up.
        if (!STATE.services.includes(hoveredAsgService)) {
            hideAsgIndicator();
            return;
        }
        toggleAutoscaling(hoveredAsgService);
        STATE.sound?.playPlace();
        paintAsgIndicator(hoveredAsgService);
    });

    asgIndicator.addEventListener("mouseenter", () => {
        if (hideAsgTimer) {
            clearTimeout(hideAsgTimer);
            hideAsgTimer = null;
        }
    });

    asgIndicator.addEventListener("mouseleave", scheduleAsgHide);
}

// Keyboard navigation
const keysPressed = {};

window.addEventListener("keydown", (e) => {
    keysPressed[e.key] = true;
});

window.addEventListener("keyup", (e) => {
    keysPressed[e.key] = false;
});

// Clear all held keys when the window loses focus — otherwise a keyup missed
// during an alt-tab / focus switch leaves the key "stuck" and the camera pans
// forever until that key is pressed and released again.
window.addEventListener("blur", () => {
    for (const k in keysPressed) keysPressed[k] = false;
});

container.addEventListener("contextmenu", (e) => e.preventDefault());

// The tool logic that fires on a primary click/tap: place, select-and-grab,
// connect, delete, unlink, upgrade. Factored out so a touch tap (#12) reaches
// exactly this code rather than a second copy of it — the mouse-only button-2/
// button-1 orbit/pan gesture below is the only part that stays in the mouse
// listener, since touch has no equivalent "other button" to check.
// `preventDefault` defaults to a no-op: it is only ever called from the
// drag-grab branch (to stop text-selection drag on desktop), and the touch
// listener passes the real one.
function handlePrimaryDown(clientX, clientY, preventDefault = () => {}) {
    if (!STATE.isRunning) return;

    const i = getIntersect(clientX, clientY);
    if (STATE.activeTool === "select") {
        const i = getIntersect(clientX, clientY);
        if (i.type === "service") {
            const svc = STATE.services.find((s) => s.id === i.id);
            // Use criticalHealth from config for consistency
            const criticalHealth = CONFIG.survival.degradation?.criticalHealth || 40;
            if (svc && svc.health < criticalHealth && CONFIG.survival.degradation?.enabled) {
                // Repair on click when damaged below critical threshold
                if (svc.repair()) {
                    addInterventionWarning(
                        i18n.t('repaired_msg', { type: i18n.t(svc.type) }),
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
            dragStartPos.copy(draggedNode.position);
            const hit = getIntersect(clientX, clientY);
            if (hit.pos) {
                dragOffset.copy(draggedNode.position).sub(hit.pos);
            }
            container.style.cursor = "grabbing";
            preventDefault();
            return;
        }
    } else if (STATE.activeTool === "delete" && i.type === "service")
        deleteObject(i.id);
    else if (STATE.activeTool === "unlink") {
        const conn = getConnectionAtPoint(clientX, clientY);
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
    } else if (PLACEMENT_TYPE_MAP[STATE.activeTool]) {
        // Handle upgrades for compute, db, cache, apigw, and nosql
        if (
            (STATE.activeTool === "lambda" && i.type === "service") ||
            (STATE.activeTool === "db" && i.type === "service") ||
            (STATE.activeTool === "cache" && i.type === "service") ||
            (STATE.activeTool === "apigw" && i.type === "service") ||
            (STATE.activeTool === "nosql" && i.type === "service") ||
            (STATE.activeTool === "search" && i.type === "service") ||
            (STATE.activeTool === "replica" && i.type === "service") ||
            (STATE.activeTool === "gpu" && i.type === "service")
        ) {
            const svc = STATE.services.find((s) => s.id === i.id);
            if (
                svc &&
                ((STATE.activeTool === "lambda" && svc.type === "compute") ||
                    (STATE.activeTool === "db" && svc.type === "db") ||
                    (STATE.activeTool === "cache" && svc.type === "cache") ||
                    (STATE.activeTool === "apigw" && svc.type === "apigw") ||
                    (STATE.activeTool === "nosql" && svc.type === "nosql") ||
                    (STATE.activeTool === "search" && svc.type === "search") ||
                    (STATE.activeTool === "replica" && svc.type === "replica") ||
                    (STATE.activeTool === "gpu" && svc.type === "gpu"))
            ) {
                svc.upgrade();
                return;
            }
        }
        if (i.type === "ground") {
            createService(PLACEMENT_TYPE_MAP[STATE.activeTool], snapToGrid(i.pos));
        }
    }
}

container.addEventListener("mousedown", (e) => {
    if (!STATE.isRunning) return;

    if (e.button === 2 || e.button === 1) {
        // Middle-drag (or Shift+right-drag, for mice without a wheel button)
        // orbits — the CAD convention the issue asked for (#231); plain
        // right-drag stays the pan it has always been. Works in BOTH views
        // since the top-down grid spins too (community follow-up on #231).
        isOrbiting = e.button === 1 || e.shiftKey;
        isPanning = !isOrbiting;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        container.style.cursor = "grabbing";
        e.preventDefault();
        return;
    }

    handlePrimaryDown(e.clientX, e.clientY, () => e.preventDefault());
});

// Last known pointer position over the canvas — lets the animate loop
// refresh the hover tooltip in real time while the mouse is stationary (#173).
let lastPointerPos = null;
container.addEventListener("mouseleave", () => {
    lastPointerPos = null;
});

// The whole hover/drag/pan/orbit continuation for a moving pointer — node
// drag, camera pan, camera orbit, and (when none of those claim the move) the
// hover tooltip + upgrade-indicator + connection-highlight tail. None of it
// reads anything off the event but the coordinates, so a touch drag (#12)
// calls this directly with a finger's clientX/clientY: dragging a grabbed
// node behaves identically, and if nothing is grabbed the branches above
// fall through to the same hover tail a mouse would — showing tooltip/
// upgrade info under a stationary finger, which is harmless and often useful
// mid-drag on touch too.
function handlePointerMove(clientX, clientY) {
    lastPointerPos = { x: clientX, y: clientY };
    if (isDraggingNode && draggedNode) {
        const hit = getIntersect(clientX, clientY);
        if (hit.pos) {
            const newPos = hit.pos.clone().add(dragOffset);
            newPos.y = 0;

            draggedNode.position.copy(newPos);

            if (draggedNode === STATE.internetNode) {
                STATE.internetNode.mesh.position.x = newPos.x;
                STATE.internetNode.mesh.position.z = newPos.z;
                STATE.internetNode.ring.position.x = newPos.x;
                STATE.internetNode.ring.position.z = newPos.z;
            } else if (draggedNode.mesh) {
                draggedNode.mesh.position.x = newPos.x;
                draggedNode.mesh.position.z = newPos.z;
            }

            updateConnectionsForNode(draggedNode.id);

            container.style.cursor = "grabbing";
        }
        return;
    }
    if (isOrbiting) {
        const dx = clientX - lastMouseX;
        // Turntable-grab feel: a full-width drag is one full revolution, and
        // the near edge of the board follows the cursor.
        orbitCamera((dx * 2 * Math.PI) / window.innerWidth);
        lastMouseX = clientX;
        lastMouseY = clientY;
        document.getElementById("tooltip").style.display = "none";
        return;
    }
    if (isPanning) {
        const dx = clientX - lastMouseX;
        const dy = clientY - lastMouseY;
        panByScreenDelta(dx, dy);
        lastMouseX = clientX;
        lastMouseY = clientY;
        document.getElementById("tooltip").style.display = "none";
        return;
    }

    const i = getIntersect(clientX, clientY);
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
        const conn = getConnectionAtPoint(clientX, clientY);
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
                conn.from === "internet" ? i18n.t('internet') : from?.config?.name || i18n.t('unknown');
            const toName =
                conn.to === "internet" ? i18n.t('internet') : to?.config?.name || i18n.t('unknown');

            showTooltip(
                clientX + 15,
                clientY + 15,
                `<strong class="text-orange-400">${i18n.t('remove_link')}</strong><br>
                <span class="text-gray-300">${fromName}</span> → <span class="text-gray-300">${toName}</span><br>
                <span class="text-red-400 text-xs">${i18n.t('click_to_remove')}</span>`
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
            let content = `<strong class="text-blue-300">${i18n.t(s.type)}</strong>`;
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
                content += `<br><span class="text-xs text-gray-400">${i18n.t(s.type + '_desc')}</span>`;
                content += `<br><span class="text-xs text-gray-500">${i18n.t('upkeep_label')} <span class="text-gray-300">${i18n.t(s.config.tooltip.upkeep.toLowerCase().replace(' ', '_'))}</span></span>`;
            }

            content += `<div class="mt-1 border-t border-gray-700 pt-1">`;

            // Service-specific dynamic stats
            if (s.type === "apigw") {
                const rateLimit = s.config.rateLimit || 20;
                const rateUsed = s.rateCounter || 0;
                const rateColor = rateUsed > rateLimit ? "text-red-400" : rateUsed > rateLimit * 0.7 ? "text-yellow-400" : "text-green-400";
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                ${i18n.t('rate_limit_label')} <span class="${rateColor}">${rateUsed}/${rateLimit} RPS</span>`;
            } else if (s.type === "cache") {
                // Show the rate the SIM will actually roll for the commonest
                // cacheable traffic (READ), not the raw tier quality — the
                // tier is a multiplier against tier 1, so printing it bare
                // used to advertise 35% while READs were being cached at 40%.
                const base = CONFIG.services.cache.cacheHitRate;
                const quality = (s.config.cacheHitRate || base) / base;
                const readRate = CONFIG.trafficTypes.READ.cacheHitRate;
                const hitRate = Math.round(Math.min(0.95, readRate * quality) * 100);
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span><br>
                ${i18n.t('hit_rate_label')} <span class="text-green-400">${hitRate}%</span>`;
            } else if (s.type === "sqs") {
                const maxQ = s.config.maxQueueSize || 200;
                const fillPercent = Math.round((s.queue.length / maxQ) * 100);
                const status =
                    fillPercent > 80 ? i18n.t('status_critical') : fillPercent > 50 ? i18n.t('status_busy') : i18n.t('status_healthy');
                const statusColor =
                    fillPercent > 80
                        ? "text-red-400"
                        : fillPercent > 50
                            ? "text-yellow-400"
                            : "text-green-400";
                content += `${i18n.t('buffered_label')} <span class="${loadColor}">${s.queue.length}/${maxQ}</span><br>
                ${i18n.t('processing_label')} ${s.processing.length}/${s.config.capacity}<br>
                ${i18n.t('status_label')} <span class="${statusColor}">${status}</span>`;
            } else if (s.type === "gpu") {
                // The AI Wave (#87): batch fill, bad answers with the tier's
                // printed risk, and the model-load state — the three numbers
                // that explain what a GPU is doing.
                const size = s.config.batchSize || 8;
                const fill = s.batch ? s.batch.length : 0;
                const fillColor = fill >= size ? "text-green-400" : fill > 0 ? "text-yellow-400" : "text-gray-400";
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('gpu_batch_fill', { n: `<span class="${fillColor}">${fill}</span>`, size })}<br>
                ${i18n.t('gpu_bad_answers', { n: s.badAnswers || 0, pct: Math.round((s.config.qualityRisk || 0) * 100) })}`;
                if (s.modelLoading) {
                    const left = Math.max(0, Math.ceil((s.config.loadTimeSec || 0) - (s.modelLoadTimer || 0)));
                    content += `<br><span class="text-amber-300">${i18n.t('gpu_loading', { s: left })}</span>`;
                }
            } else if (s.type === "infgw") {
                // The AI Wave (#87): held backlog vs cap, the deadline, and
                // how many entries have already expired against it.
                content += `${i18n.t('infgw_held', { n: s.pending ? s.pending.length : 0, cap: s.config.maxQueueSize || 20 })}<br>
                ${i18n.t('infgw_deadline', { s: s.config.deadlineSec })}<br>
                ${i18n.t('infgw_expired', { n: s.expiredCount || 0 })}`;
            } else {
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.getEffectiveCapacity()}</span>`;
            }
            // Circuit-breaker line (#196) — shown whenever the breaker is not
            // closed, and deliberately NOT gated on the Monitoring service:
            // the breaker changes where traffic goes, so the player has to be
            // able to see it acting even without the metrics dashboard.
            if (s.breakerState === "open" || s.breakerState === "half-open") {
                const open = s.breakerState === "open";
                const color = open ? "text-red-400" : "text-amber-300";
                const label = open ? i18n.t('breaker_open') : i18n.t('breaker_half');
                content += `<br>${i18n.t('breaker_label')} <span class="${color} font-bold">${label}</span>`;
            }
            // ASG fleet line (#195) — only once the group is actually on.
            if (s.asgEnabled) {
                const warming = warmingCount(s);
                content += `<br>${i18n.t('asg_label')} <span class="text-teal-300">${instanceCount(s)}/${CONFIG.autoscaling.maxInstances}</span>`;
                if (warming > 0) {
                    content += ` <span class="text-amber-300">${i18n.t('asg_warming', { n: warming })}</span>`;
                }
            }
            content += `</div>`;

            // Show upgrade option for upgradeable services
            if (
                (STATE.activeTool === "lambda" && s.type === "compute") ||
                (STATE.activeTool === "db" && s.type === "db") ||
                (STATE.activeTool === "cache" && s.type === "cache") ||
                (STATE.activeTool === "apigw" && s.type === "apigw") ||
                (STATE.activeTool === "nosql" && s.type === "nosql") ||
                (STATE.activeTool === "search" && s.type === "search") ||
                (STATE.activeTool === "replica" && s.type === "replica") ||
                (STATE.activeTool === "gpu" && s.type === "gpu")
            ) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = "pointer";
                    const nextCost = tiers[s.tier].cost;
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-green-300 text-xs font-bold">${i18n.t('upgrade_label')} $${nextCost}</span></div>`;
                    // GPU tiers sell QUALITY as much as size (#87) — the
                    // percentage is printed right on the upgrade card.
                    if (s.type === "gpu") {
                        const next = tiers[s.tier];
                        content += `<div><span class="text-fuchsia-300 text-xs">${i18n.t('gpu_upgrade_quality', { size: next.batchSize, pct: Math.round(next.qualityRisk * 100) })}</span></div>`;
                    }
                    if (s.mesh.material.emissive)
                        s.mesh.material.emissive.setHex(0x333333);
                } else {
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-gray-500 text-xs">${i18n.t('max_tier')}</span></div>`;
                }
            }

            // SHOW UPGRADE INDICATOR (Green Arrow)
            if (["compute", "db", "cache", "apigw", "nosql", "search", "replica", "gpu"].includes(s.type)) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    // Clear any pending hide timer since we are hovering a valid service
                    if (hideUpgradeTimer) {
                        clearTimeout(hideUpgradeTimer);
                        hideUpgradeTimer = null;
                    }

                    hoveredUpgradeService = s;
                    const nextCost = tiers[s.tier].cost;

                    // Project 3D position to 2D screen
                    const pos = s.mesh.position.clone();
                    pos.y += 3; // Offset above service
                    pos.project(camera);

                    const x = (pos.x * .5 + .5) * container.clientWidth;
                    const y = (pos.y * -.5 + .5) * container.clientHeight;

                    if (upgradeIndicator && upgradeCostEl) {
                        upgradeIndicator.style.left = `${x}px`;
                        upgradeIndicator.style.top = `${y}px`;
                        upgradeIndicator.classList.remove("hidden");
                        upgradeCostEl.textContent = `$${nextCost}`;

                        // Color code cost
                        if (STATE.money < nextCost) {
                            upgradeCostEl.classList.remove("bg-green-600", "border-green-400");
                            upgradeCostEl.classList.add("bg-red-600", "border-red-400");
                        } else {
                            upgradeCostEl.classList.remove("bg-red-600", "border-red-400");
                            upgradeCostEl.classList.add("bg-green-600", "border-green-400");
                        }
                    }
                } else {
                    // Max tier
                    if (hoveredUpgradeService === s) {
                        hoveredUpgradeService = null;
                        if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                    }
                }
            } else {
                // Not an upgradeable service or different type - trigger hide
                if (hoveredUpgradeService && !hideUpgradeTimer) {
                    hideUpgradeTimer = setTimeout(() => {
                        hoveredUpgradeService = null;
                        if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                        hideUpgradeTimer = null;
                    }, 300);
                }
            }

            // AUTO toggle (#195): Compute only.
            if (canAutoscale(s)) {
                showAsgIndicator(s);
            } else {
                scheduleAsgHide();
            }

            showTooltip(clientX + 15, clientY + 15, content);

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

        // Hide upgrade indicator if visible (with delay)
        if (hoveredUpgradeService && !hideUpgradeTimer) {
            hideUpgradeTimer = setTimeout(() => {
                hoveredUpgradeService = null;
                if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                hideUpgradeTimer = null;
            }, 300);
        }

        // Same for the AUTO toggle (#195).
        scheduleAsgHide();
    }

    container.style.cursor = cursor;
}

container.addEventListener("mousemove", (e) => {
    handlePointerMove(e.clientX, e.clientY);
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
    const tools = ["waf", "apigw", "sqs", "alb", "lambda", "db", "nosql", "cache", "s3", "cdn", "search", "replica", "serverless", "monitor", "dlq", "pubsub", "auth", "scheduler", "notify", "container", "stream", "dns", "warehouse"];
    tools.forEach((toolId) => {
        const btn = document.getElementById(`tool-${toolId}`);
        if (!btn) return;

        // Map tool ID to config service key
        const serviceKey = toolId === "lambda" ? "compute" : toolId;
        const config = CONFIG.services[serviceKey];

        if (config && config.tooltip) {
            btn.addEventListener("mousemove", (e) => {
                const content = `
                    <strong class="text-blue-300">${i18n.t(serviceKey)}</strong> <span class="text-green-400">$${config.cost}</span><br>
                    <span class="text-xs text-gray-400">${i18n.t(serviceKey + '_desc')}</span><br>
                    <div class="mt-1 pt-1 border-t border-gray-700 flex justify-between text-xs">
                        <span class="text-gray-500">${i18n.t('upkeep_label')} <span class="text-gray-300">${i18n.t(config.tooltip.upkeep.toLowerCase().replace(' ', '_'))}</span></span>
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

// Call setup. The service buttons are re-created every time the player
// switches category (toolbar categories, 2026-07-24), and listeners die with
// the nodes they were attached to — so re-run the wiring on every render.
// The toolbar module cannot call this directly: it is imported BY this file
// (for the 1-5 shortcuts below), so the signal travels back as an event.
setupUITooltips();
window.addEventListener("toolbarRendered", setupUITooltips);

// Drops the node currently being dragged onto its nearest grid tile. No-op
// if nothing is being dragged. Shared by every way a grab can end — mouse
// release, touch release, touch cancel — since it only ever acts on the
// module's own drag state and takes nothing from the event that ended it.
function finishNodeDrag() {
    if (!(isDraggingNode && draggedNode)) return;
    isDraggingNode = false;

    let snapped = snapToGrid(draggedNode.position);

    // Reject a drop onto a tile already occupied by another service —
    // otherwise the two overlap and whichever mesh the raycaster hits first
    // makes the other permanently unselectable (can't delete/upgrade it).
    const occupied = STATE.services.some(
        (s) => s !== draggedNode && s.position.distanceTo(snapped) < 1
    );
    if (occupied) {
        snapped = snapToGrid(dragStartPos);
    }

    draggedNode.position.copy(snapped);

    if (draggedNode === STATE.internetNode) {
        STATE.internetNode.mesh.position.x = snapped.x;
        STATE.internetNode.mesh.position.z = snapped.z;
        STATE.internetNode.ring.position.x = snapped.x;
        STATE.internetNode.ring.position.z = snapped.z;
    } else if (draggedNode.mesh) {
        draggedNode.mesh.position.x = snapped.x;
        draggedNode.mesh.position.z = snapped.z;
    }

    updateConnectionsForNode(draggedNode.id);

    draggedNode = null;
    container.style.cursor = "default";
}

// The pointer can be RELEASED ANYWHERE. This handler lived only on
// #canvas-container, and the HUD panels are pointer-events-auto siblings of
// the canvas, so letting go over the Finances panel — or off the window edge,
// which delivers no mouseup at all to the container — left isDraggingNode,
// draggedNode, isPanning and isOrbiting armed with nothing holding them.
//
// Nothing cleared them afterwards either: resetGame did not, so the state
// crossed the run boundary. Grab the Internet node, release over a panel,
// start a new run, and the node teleported on the first mouse MOVE with
// nobody clicking — measured from x -40 to x 0.
//
// Bound to the window as well as the container. The release on the canvas
// bubbles to both, and every branch below is guarded on the flag it clears,
// so running twice is a no-op the second time.
function handlePointerRelease(e) {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        isOrbiting = false;
        container.style.cursor = "default";
    }
    finishNodeDrag();
}

container.addEventListener("mouseup", handlePointerRelease);
window.addEventListener("mouseup", handlePointerRelease);

// A release that happens with the window unfocused (dragged off the edge and
// let go) delivers no mouseup at all. Coming back to the page is the next
// moment we can know the button is not held any more.
window.addEventListener("blur", () => handlePointerRelease({ button: 0 }));

// Ends any drag/pan in progress. Called by resetGame: a run boundary is not
// a place for the pointer to still be holding something from the last one.
// Covers touch too — it never introduced state of its own, only new ways to
// arm the same isDraggingNode/isPanning/isOrbiting flags this already clears.
export function endPointerInteraction() {
    const wasActive = isDraggingNode || isPanning || isOrbiting;
    isDraggingNode = false;
    draggedNode = null;
    isPanning = false;
    isOrbiting = false;
    if (container) container.style.cursor = "default";
    return wasActive;
}

// Touch input (#12). The board is otherwise unreachable on a touchscreen —
// every gesture above is mouse-only, and a synthetic click from a tap covers
// menu buttons but never a drag.
//
// One finger is the primary pointer: a tap reaches handlePrimaryDown exactly
// like a left click, and dragging (after grabbing a node) reaches
// handlePointerMove exactly like a mouse drag. Two fingers is unambiguously a
// camera gesture — there is no second mouse button to reserve it for, so it
// takes over pan (from the midpoint) and zoom (from the finger spacing) at
// once, the way every touch map app combines them. A pinch starting while a
// node is held drops the node rather than dragging it AND zooming, since a
// service half-dragged, half-zoomed has no sensible position to land on.
function touchMidpoint(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
}
function touchDistance(t0, t1) {
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
}

let pinchStartDist = 0;
let pinchStartZoom = 1;

container.addEventListener("touchstart", (e) => {
    if (!STATE.isRunning) return;

    if (e.touches.length >= 2) {
        if (isDraggingNode) {
            isDraggingNode = false;
            draggedNode = null;
        }
        isPanning = true;
        const mid = touchMidpoint(e.touches[0], e.touches[1]);
        lastMouseX = mid.x;
        lastMouseY = mid.y;
        pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        pinchStartZoom = currentZoom;
        e.preventDefault();
        return;
    }

    // Always prevented, not just from inside the node-grab branch the way the
    // mouse path does it: on a real touchscreen a tap that does NOT call
    // preventDefault can still trigger the browser's own delayed synthetic
    // click and page-scroll gestures a few hundred ms later, on top of
    // whatever the game already did with it. The mouse path never had that
    // problem to guard against, which is why it only calls it when starting
    // a drag.
    e.preventDefault();
    const t = e.touches[0];
    handlePrimaryDown(t.clientX, t.clientY, () => {});
}, { passive: false });

container.addEventListener("touchmove", (e) => {
    if (e.touches.length >= 2) {
        const mid = touchMidpoint(e.touches[0], e.touches[1]);
        panByScreenDelta(mid.x - lastMouseX, mid.y - lastMouseY);
        lastMouseX = mid.x;
        lastMouseY = mid.y;

        const dist = touchDistance(e.touches[0], e.touches[1]);
        if (pinchStartDist > 0) {
            setZoom(pinchStartZoom * (dist / pinchStartDist));
        }
        e.preventDefault();
        return;
    }

    // A single-finger move only ever means something while a node is being
    // dragged — touch has no hover to drive the tooltip tail, and a stray
    // single-finger move (a slightly shaky tap) should not smear a tooltip
    // across the screen the way it harmlessly does under a mouse.
    if (isDraggingNode) {
        handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
        e.preventDefault();
    }
}, { passive: false });

container.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) {
        isPanning = false;
        pinchStartDist = 0;
    }
    if (e.touches.length === 0) {
        finishNodeDrag();
    }
});

// touchcancel fires with NO touchend at all — the OS interrupting the
// gesture (an incoming call, a system-reserved edge swipe) is the touch
// equivalent of the off-window release #288 fixed for the mouse above, and
// deserves the same answer: give up whatever the pointer was holding rather
// than leave it armed for the next touch to inherit.
container.addEventListener("touchcancel", () => {
    isPanning = false;
    pinchStartDist = 0;
    endPointerInteraction();
});

window.addEventListener("resize", () => {
    // The frustum math lives in game.js and is shared with the initial camera
    // (#12). It used to be written out twice, which is how the two copies came
    // to disagree about what a portrait viewport should show.
    applyCameraFrustum();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// True while the player is typing into one of the sandbox panel's fields —
// the digit shortcuts below must not steal those keystrokes. (The older
// Esc/H/R/T shortcuts have never had this guard; left exactly as they were,
// widening them is not this change's business.)
function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable === true
    );
}

document.addEventListener("keydown", (event) => {
    // Keys 1-5 switch service-palette categories. Bare digits only: Cmd/Ctrl+1
    // is the browser's own tab switch, and Alt-digits are OS shortcuts.
    if (
        event.key >= "1" &&
        event.key <= "5" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
    ) {
        const category = SERVICE_CATEGORIES[Number(event.key) - 1];
        if (category) setToolbarCategory(category.id);
        return;
    }
    if (event.key === "Escape") {
        // Toggle main menu
        const menu = document.getElementById("main-menu-modal");
        if (menu.classList.contains("hidden")) {
            openMainMenu();
        } else if (STATE.gameStarted && STATE.isRunning) {
            window.resumeGame();
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

// Isometric vs top-down view flag. Lives here (not in game.js) because
// toggleView reassigns it — imported bindings are read-only, so the writer
// must own the declaration; game.js's animate loop reads it live.
let isIsometric = true;

function toggleView() {
    isIsometric = !isIsometric;
    resetCamera();
}

function resetCamera() {
    // Azimuth resets in BOTH views: R snaps back to the classic angle, and
    // since toggleView routes through here, T never re-enters either view
    // with a stale rotation.
    cameraAzimuth = DEFAULT_AZIMUTH;
    if (isIsometric) {
        cameraTarget.set(0, 0, 0);
    } else {
        camera.position.set(0, 50, 0);
    }
    applyCameraOrbit();
}

export {
    container,
    isDraggingNode,
    isIsometric,
    isPanning,
    keysPressed,
    lastPointerPos,
    orbitCamera,
    panCameraScreen,
    resetCamera,
};
