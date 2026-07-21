// Topology / build-wire-demolish cluster (#155 PR 7): service placement and
// restore, connection creation with the valid-edge table, connection and
// service deletion (with mesh disposal and orphaned-request cleanup),
// line-pick raycasting, drag rewiring, grid snapping, and the sandbox
// clear-all. Code moved verbatim from game.js; game.js keeps a thin
// window.clearAllServices = clearAllServices assignment in its ESM-boundary
// block.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { Service } from "../entities/Service.js";
import { flashMoney, removeRequest } from "../core/actions.js";
import { updateRepairCostTable } from "../core/economy.js";
// Runtime-only cycle (game.js ⇄ topology.js) — established pattern: these
// are top-level consts in game.js (scene groups + raycasting singletons),
// only dereferenced at runtime, long after both modules evaluate.
import {
    camera,
    connectionGroup,
    mouse,
    plane,
    raycaster,
} from "../../game.js";

function snapToGrid(vec) {
    const s = CONFIG.tileSize;
    return new THREE.Vector3(
        Math.round(vec.x / s) * s,
        0,
        Math.round(vec.z / s) * s
    );
}

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
    // Reject the reverse edge of an existing link. ALB⇄SQS is the only pair valid
    // in both directions, and having both at once loops requests forever (SQS
    // pushes to ALB, ALB's generic forwarding pushes back) — they never reach
    // finishRequest/failRequest and leak. Either single direction stays legal.
    if (to.connections && to.connections.includes(fromId)) return;

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
    else if (t1 === "internet" && t2 === "cdn") valid = true;
    else if (t1 === "cdn" && t2 === "s3") valid = true;
    // API Gateway connections
    else if (t1 === "internet" && t2 === "apigw") valid = true;
    else if (t1 === "waf" && t2 === "apigw") valid = true;
    else if (t1 === "apigw" && t2 === "alb") valid = true;
    else if (t1 === "apigw" && t2 === "sqs") valid = true;
    else if (t1 === "apigw" && t2 === "compute") valid = true;
    // NoSQL connections
    else if (t1 === "compute" && t2 === "nosql") valid = true;
    else if (t1 === "cache" && t2 === "nosql") valid = true;
    // Search Engine connections
    else if (t1 === "compute" && t2 === "search") valid = true;
    else if (t1 === "cache" && t2 === "search") valid = true;
    // Read Replica connections
    else if (t1 === "compute" && t2 === "replica") valid = true;
    else if (t1 === "cache" && t2 === "replica") valid = true;
    else if (t1 === "replica" && t2 === "db") valid = true;
    else if (t1 === "replica" && t2 === "nosql") valid = true;
    // Serverless Function connections (same topology as Compute)
    else if (t1 === "alb" && t2 === "serverless") valid = true;
    else if (t1 === "sqs" && t2 === "serverless") valid = true;
    else if (t1 === "apigw" && t2 === "serverless") valid = true;
    else if (t1 === "serverless" && t2 === "cache") valid = true;
    else if (t1 === "serverless" && t2 === "db") valid = true;
    else if (t1 === "serverless" && t2 === "nosql") valid = true;
    else if (t1 === "serverless" && t2 === "s3") valid = true;
    else if (t1 === "serverless" && t2 === "search") valid = true;
    else if (t1 === "serverless" && t2 === "replica") valid = true;

    if (!valid) {
        new Audio("assets/sounds/click-9.mp3").play();
        console.error(i18n.t('invalid_topology_detailed'));
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
    // Properly dispose geometry and materials to prevent memory leak
    toRemove.forEach((c) => {
        connectionGroup.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh.material.dispose();
    });
    STATE.connections = STATE.connections.filter((c) => !toRemove.includes(c));

    // Clean up any requests tied to this service — sitting in its queue, in its
    // processing slots, or in flight toward it. Without this they'd be stranded
    // on the destroyed service (whose update() never runs again) and freeze in
    // the scene forever. Collected from every source and de-duped, then removed
    // cleanly (no reputation penalty — the player is restructuring, not dropping
    // production traffic).
    const orphaned = new Set([
        ...svc.queue,
        ...svc.processing.map((job) => job.req),
        ...STATE.requests.filter((r) => r.target === svc),
    ]);
    orphaned.forEach((r) => removeRequest(r));

    svc.destroy();
    STATE.services = STATE.services.filter((s) => s.id !== id);
    STATE.money += Math.floor(svc.config.cost / 2);
    STATE.sound.playDelete();
    updateRepairCostTable();
}

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

function clearAllServices() {
    STATE.services.forEach((s) => s.destroy());
    STATE.services = [];
    STATE.connections.forEach((c) => {
        connectionGroup.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh.material.dispose();
    });
    STATE.connections = [];
    STATE.internetNode.connections = [];
    STATE.requests.forEach((r) => r.destroy());
    STATE.requests = [];
    STATE.money = STATE.sandboxBudget;
}

export {
    clearAllServices,
    createConnection,
    createService,
    deleteConnection,
    deleteObject,
    getConnectionAtPoint,
    restoreService,
    snapToGrid,
    updateConnectionsForNode,
};
