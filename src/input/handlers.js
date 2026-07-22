// Input layer (#155 PR 8): the pointer/keyboard/camera handlers from
// game.js — canvas raycast picking, wheel zoom, the upgrade indicator,
// held-key tracking, the big mousedown/mousemove/mouseup drag/pan/connect/
// place handlers with their state, hover + toolbar tooltips, window resize,
// the document-level shortcuts (Esc/H/R/T), and the view toggle / camera
// reset. Code moved verbatim from game.js; importing this module registers
// every listener as a side effect (no events can fire until the module
// graph finishes evaluating, so registration order is unobservable).
// game.js's animate loop reads the exported input state via live bindings.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { addInterventionWarning } from "../core/events.js";
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
    camera,
    cameraTarget,
    d,
    mouse,
    openMainMenu,
    plane,
    raycaster,
    renderer,
    serviceGroup,
} from "../../game.js";

const container = document.getElementById("canvas-container");

let isDraggingNode = false;
let draggedNode = null;
let dragOffset = new THREE.Vector3();
let dragStartPos = new THREE.Vector3();

let isPanning = false;
let lastMouseX = 0;
let lastMouseY = 0;
const panSpeed = 0.1;

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
        ["waf", "alb", "lambda", "db", "nosql", "s3", "sqs", "cache", "cdn", "apigw", "search", "replica", "serverless"].includes(
            STATE.activeTool
        )
    ) {
        // Handle upgrades for compute, db, cache, apigw, and nosql
        if (
            (STATE.activeTool === "lambda" && i.type === "service") ||
            (STATE.activeTool === "db" && i.type === "service") ||
            (STATE.activeTool === "cache" && i.type === "service") ||
            (STATE.activeTool === "apigw" && i.type === "service") ||
            (STATE.activeTool === "nosql" && i.type === "service") ||
            (STATE.activeTool === "search" && i.type === "service") ||
            (STATE.activeTool === "replica" && i.type === "service")
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
                    (STATE.activeTool === "replica" && svc.type === "replica"))
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
                nosql: "nosql",
                s3: "s3",
                sqs: "sqs",
                cache: "cache",
                apigw: "apigw",
                cdn: "cdn",
                search: "search",
                replica: "replica",
                serverless: "serverless",
            };

            const serviceType = typeMap[STATE.activeTool];
            if (serviceType) {
                createService(serviceType, snapToGrid(i.pos));
            }
        }
    }
});

// Last known pointer position over the canvas — lets the animate loop
// refresh the hover tooltip in real time while the mouse is stationary (#173).
let lastPointerPos = null;
container.addEventListener("mouseleave", () => {
    lastPointerPos = null;
});

container.addEventListener("mousemove", (e) => {
    lastPointerPos = { x: e.clientX, y: e.clientY };
    if (isDraggingNode && draggedNode) {
        const hit = getIntersect(e.clientX, e.clientY);
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
                conn.from === "internet" ? i18n.t('internet') : from?.config?.name || i18n.t('unknown');
            const toName =
                conn.to === "internet" ? i18n.t('internet') : to?.config?.name || i18n.t('unknown');

            showTooltip(
                e.clientX + 15,
                e.clientY + 15,
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
                const hitRate = Math.round((s.config.cacheHitRate || 0.35) * 100);
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
            } else {
                content += `${i18n.t('queue_label')} <span class="${loadColor}">${s.queue.length}</span><br>
                ${i18n.t('load_label')} <span class="${loadColor}">${s.processing.length}/${s.config.capacity}</span>`;
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
                (STATE.activeTool === "replica" && s.type === "replica")
            ) {
                const tiers = CONFIG.services[s.type].tiers;
                if (s.tier < tiers.length) {
                    cursor = "pointer";
                    const nextCost = tiers[s.tier].cost;
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-green-300 text-xs font-bold">${i18n.t('upgrade_label')} $${nextCost}</span></div>`;
                    if (s.mesh.material.emissive)
                        s.mesh.material.emissive.setHex(0x333333);
                } else {
                    content += `<div class="mt-1 pt-1 border-t border-gray-700"><span class="text-gray-500 text-xs">${i18n.t('max_tier')}</span></div>`;
                }
            }

            // SHOW UPGRADE INDICATOR (Green Arrow)
            if (["compute", "db", "cache", "apigw", "nosql", "search", "replica"].includes(s.type)) {
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

        // Hide upgrade indicator if visible (with delay)
        if (hoveredUpgradeService && !hideUpgradeTimer) {
            hideUpgradeTimer = setTimeout(() => {
                hoveredUpgradeService = null;
                if (upgradeIndicator) upgradeIndicator.classList.add("hidden");
                hideUpgradeTimer = null;
            }, 300);
        }
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
    const tools = ["waf", "apigw", "sqs", "alb", "lambda", "db", "nosql", "cache", "s3", "cdn", "search", "replica", "serverless"];
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

// Call setup
setupUITooltips();

container.addEventListener("mouseup", (e) => {
    if (e.button === 2 || e.button === 1) {
        isPanning = false;
        container.style.cursor = "default";
    }
    if (isDraggingNode && draggedNode) {
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
        return;
    }
});

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
    if (isIsometric) {
        camera.position.set(40, 40, 40);
        cameraTarget.set(0, 0, 0);
        camera.lookAt(cameraTarget);
    } else {
        camera.position.set(0, 50, 0);
        camera.lookAt(0, 0, 0);
    }
}

export {
    container,
    isDraggingNode,
    isIsometric,
    isPanning,
    keysPressed,
    lastPointerPos,
    resetCamera,
};
