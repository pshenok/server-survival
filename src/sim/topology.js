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
// Power-gate refusals (#87) surface as intervention warnings. Runtime-only
// cycle (topology.js -> events.js -> game.js -> topology.js) — established
// pattern: hoisted function declarations, dereferenced only at runtime.
import { addInterventionWarning } from "../core/events.js";
import { updateRepairCostTable } from "../core/economy.js";
import { isRoutable } from "./circuit-breaker.js";
// The power grid (#87): STATE.power is re-derived after every placement and
// demolition, and the two gates below consult it — see src/sim/power.js.
import {
    hasPowerHeadroom,
    recomputePower,
    substationRemovalStrandsGpus,
} from "./power.js";
// Failure badges (#156) are anchored to services; wiping the board must
// dispose their textures too — see the note in ui/failure-badges.js.
import { clearFailureBadges } from "../ui/failure-badges.js";
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
    // Power placement gate (#87): a GPU cannot go on the grid past the cap —
    // boundary INCLUSIVE, so a draw landing exactly on the cap is legal (see
    // src/sim/power.js). Checked before any money moves.
    if (type === "gpu" && !hasPowerHeadroom()) {
        addInterventionWarning(i18n.t("power_gate_blocked"), "danger", 3000);
        return;
    }
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
    recomputePower();
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

// The static edge allowlist, factored out of createConnection so the share
// link decoder (#157) can pre-filter a hostile payload against the SAME table
// instead of copying it. Pure over the two type strings — the stateful guards
// (existing edge, reverse edge, entity lookup) stay in createConnection.
function isValidEdge(t1, t2) {
    let valid = false;

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
    // ===== Sandbox archetypes, batch 1 (#197) =====
    // Every edge below was checked against the reverse-edge guard (#192, covers
    // 2-cycles) AND for longer loops: the DLQ and Notification are pure sinks
    // (no outgoing edges), the Scheduler is a pure source (no incoming edges),
    // and Pub/Sub / Auth only forward "downward" to nodes that never route back
    // up to them — so no request can loop.
    //
    // Dead-Letter Queue — a failure SINK, wired FROM the nodes whose final
    // failures it should catch. It has no outgoing edges and is never a normal
    // forward target (genericForward / apigw exclude it); the edge is used only
    // by failOrPark's lookup.
    else if ((t1 === "compute" || t1 === "serverless" || t1 === "alb" || t1 === "apigw") && t2 === "dlq") valid = true;
    // Pub/Sub Topic — fed by a load balancer or API gateway, fans out to
    // independent subscribers (processors, a terminal sink, or storage).
    else if ((t1 === "alb" || t1 === "apigw") && t2 === "pubsub") valid = true;
    else if (t1 === "pubsub" && (t2 === "compute" || t2 === "serverless" || t2 === "notify" || t2 === "s3")) valid = true;
    // Auth / Identity — sits in-line: fed from the edge (Internet or WAF),
    // forwards survivors to the load balancer / gateway / compute tier.
    else if ((t1 === "internet" || t1 === "waf") && t2 === "auth") valid = true;
    else if (t1 === "auth" && (t2 === "alb" || t2 === "apigw" || t2 === "compute" || t2 === "serverless")) valid = true;
    // Scheduler / Cron — a traffic SOURCE: no incoming edges, injects its bursts
    // into a queue / balancer / compute / serverless downstream.
    else if (t1 === "scheduler" && (t2 === "sqs" || t2 === "alb" || t2 === "compute" || t2 === "serverless")) valid = true;
    // Notification — a terminal sink for WRITE-ish events, fed by a balancer,
    // a fan-out topic, or a scheduler.
    else if ((t1 === "alb" || t1 === "pubsub" || t1 === "scheduler") && t2 === "notify") valid = true;
    // ===== Sandbox archetypes, batch 2 (#198) =====
    // Reverse-edge guard (#192) covers 2-cycles; longer loops are ruled out
    // because every edge below forwards strictly "downward": Container mirrors
    // Compute's fan-in/out, Stream and DNS only forward to nodes that never
    // route back up to them, and the Warehouse is a pure terminal sink.
    //
    // Container Cluster — Compute's economic sibling: fed the same way (LB /
    // Queue / API GW) and forwarding to the same data tier.
    else if ((t1 === "alb" || t1 === "sqs" || t1 === "apigw") && t2 === "container") valid = true;
    else if (t1 === "container" && (t2 === "cache" || t2 === "db" || t2 === "s3" || t2 === "nosql" || t2 === "search" || t2 === "replica")) valid = true;
    // Stream — high-throughput ordered ingestion: fed from the front tier,
    // forwarding each partition to its own processor / sink downstream.
    else if ((t1 === "alb" || t1 === "apigw") && t2 === "stream") valid = true;
    else if (t1 === "stream" && (t2 === "compute" || t2 === "serverless" || t2 === "container" || t2 === "s3" || t2 === "notify" || t2 === "warehouse")) valid = true;
    // GeoDNS — the front-most entry: a valid Internet target, fanning out to
    // the independent regional front-doors (WAF / ALB / API GW).
    else if (t1 === "internet" && t2 === "dns") valid = true;
    else if (t1 === "dns" && (t2 === "waf" || t2 === "alb" || t2 === "apigw")) valid = true;
    // Data Warehouse — analytics sink: fed by a fan-out copy (Pub/Sub), a
    // scheduled batch load (Scheduler), or a Stream. Pure terminal, no outgoing.
    else if ((t1 === "pubsub" || t1 === "scheduler" || t1 === "stream") && t2 === "warehouse") valid = true;
    // ===== The AI Wave (#87) =====
    // Reverse-edge guard (#192) covers 2-cycles; longer loops are ruled out
    // because every edge here forwards strictly "downward": the Inference
    // Gateway only forwards to GPUs, and a GPU is a pure terminal sink (no
    // outgoing edges). The Substation ("power") has NO rows at all — it is
    // unwireable like Monitoring, which also keeps it out of any region
    // subtree during a region outage.
    //
    // Inference Gateway — fed by the front tier and the compute tier, owns
    // the deadline queue, forwards only to GPUs.
    else if ((t1 === "alb" || t1 === "apigw" || t1 === "compute" || t1 === "serverless" || t1 === "container") && t2 === "infgw") valid = true;
    else if (t1 === "infgw" && t2 === "gpu") valid = true;
    // GPU Cluster — also reachable directly from the compute tier (the
    // "direct-wired GPU" the gateway's concept card argues against).
    else if ((t1 === "compute" || t1 === "serverless" || t1 === "container") && t2 === "gpu") valid = true;

    return valid;
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

    const t1 = from.type,
        t2 = to.type;

    if (!isValidEdge(t1, t2)) {
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

    // Power deletion gate (#87, anti-cheese): refuse to remove a Substation
    // whose loss would leave the powered GPUs past the reduced cap —
    // otherwise buy-place-refund runs an 18 kW fleet on an 8 kW grid forever.
    // GPU deletion stays free: shedding load is always legal.
    if (svc.type === "power" && substationRemovalStrandsGpus()) {
        addInterventionWarning(i18n.t("power_delete_blocked"), "danger", 3000);
        return;
    }

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
        // Stream (#198) holds records in its partitions, not queue/processing —
        // re-home them too or deleting a stream node would strand them.
        ...(svc.partitions ? svc.partitions.flat() : []),
        // The AI Wave (#87): a GPU's live batch and an Inference Gateway's
        // deadline entries are the same kind of off-pipeline backlog — a
        // mid-batch demolish must terminate every member.
        ...(svc.batch || []),
        ...(svc.pending ? svc.pending.map((entry) => entry.req) : []),
        ...STATE.requests.filter((r) => r.target === svc),
    ]);
    orphaned.forEach((r) => removeRequest(r));

    svc.destroy();
    STATE.services = STATE.services.filter((s) => s.id !== id);
    recomputePower();
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

// Single-point-of-failure detection (#196). Deliberately simple and
// deliberately explained, because the player is going to be told about it:
//
//   a service is a SPOF when it is the ONLY routable service of its type that
//   traffic can reach from the Internet.
//
// Reachability is a plain forward walk from the Internet node over the
// connection graph, so services the player parked off the active path are
// ignored, as are nodes that never take traffic (Monitoring is unreachable by
// construction — it has no valid edges). "Only one of its type" is what makes
// the N+1 lesson land: with a second instance of that type wired to the same
// upstream, routing (findConnectedService / genericForward / the entry picker,
// all of which skip a disabled or breaker-open node) fails over on its own.
//
// Not modelled: partial redundancy, where a second instance exists but hangs
// off a different upstream. That is a "your redundancy is not wired up" lesson
// and needs its own hint text rather than a false negative here.
function findSPOFs(state = STATE) {
    const byId = new Map((state.services || []).map((s) => [s.id, s]));
    const reachable = new Set();
    const frontier = [...(state.internetNode?.connections || [])];

    while (frontier.length > 0) {
        const id = frontier.pop();
        if (reachable.has(id)) continue;
        const svc = byId.get(id);
        if (!svc) continue;
        reachable.add(id);
        for (const next of svc.connections) frontier.push(next);
    }

    const countByType = {};
    for (const s of state.services || []) {
        if (!isRoutable(s)) continue;
        countByType[s.type] = (countByType[s.type] || 0) + 1;
    }

    return [...reachable]
        .map((id) => byId.get(id))
        .filter((s) => s && isRoutable(s) && countByType[s.type] === 1);
}

function clearAllServices() {
    STATE.services.forEach((s) => s.destroy());
    STATE.services = [];
    recomputePower();
    STATE.connections.forEach((c) => {
        connectionGroup.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh.material.dispose();
    });
    STATE.connections = [];
    STATE.internetNode.connections = [];
    STATE.requests.forEach((r) => r.destroy());
    STATE.requests = [];
    clearFailureBadges();
    STATE.money = STATE.sandboxBudget;
}

export {
    clearAllServices,
    createConnection,
    createService,
    deleteConnection,
    deleteObject,
    findSPOFs,
    getConnectionAtPoint,
    isValidEdge,
    restoreService,
    snapToGrid,
    updateConnectionsForNode,
};
