// Share Architecture (#157): PNG export + shareable ?arch= URL.
//
// Two ways out of the share modal:
//   1. "Download PNG" — a clean snapshot of the scene with a small watermark,
//      read back from the WebGL canvas right after a synchronous re-render
//      (the renderer runs without preserveDrawingBuffer, which is the right
//      trade: that flag costs every frame, this feature runs once in a while).
//   2. "Copy Link"    — the architecture ONLY (service types + positions +
//      connections + sandbox budget; no score, reputation or save-state),
//      compact JSON → base64url → ?arch= on the current origin+path.
//
// SECURITY: the ?arch= param is untrusted input — anyone can hand-craft a
// link. decodeArchParam is the single gate: strict structural validation
// (versioned format, type strings checked against CONFIG.services, finite
// in-grid positions, hard caps on counts and payload size), and anything
// malformed is ignored with one console.warn — never a throw, never an eval.
// The rebuild then goes EXCLUSIVELY through createService/createConnection,
// so the placement rules, the edge allowlist and the reverse-edge/cycle
// guard (#192) all apply a second time on live state.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { createConnection, createService, isValidEdge } from "../sim/topology.js";
// Runtime-only cycle (game.js ⇄ share.js) — established pattern: these are
// top-level consts / hoisted declarations in game.js, only dereferenced at
// runtime, long after both modules evaluate.
import { camera, renderer, scene, syncInput } from "../../game.js";

const ARCH_VERSION = 1;
// Hard caps: ~60 services covers every realistic build (the issue budgets
// for ~50) while keeping a hostile payload from allocating thousands.
const MAX_SERVICES = 60;
const MAX_CONNECTIONS = 240;
// The issue's viability bound for the whole link.
const MAX_URL_LENGTH = 2000;
// Reject grossly oversized params before even base64-decoding them.
const MAX_PARAM_LENGTH = 4096;
// One full grid width of slack around the origin: the drawn grid spans
// ±(gridSize·tileSize)/2, and drag placement snaps but does not clamp, so a
// node parked just off the edge still shares — 1e300 does not.
const POSITION_BOUND = CONFIG.gridSize * CONFIG.tileSize;
// The issue says "server-survival.dev", but that domain doesn't exist —
// watermark the URL the game actually lives at.
const WATERMARK = "pshenok.github.io/server-survival";

// ==================== ENCODE ====================

const round2 = (n) => Math.round(n * 100) / 100;

// The wire format, flat for compactness (50 services must fit in ~2KB):
//   v — format version, b — sandbox budget,
//   t — service types, POWER-FIRST (see below), otherwise placement order,
//   p — positions as [x0, z0, x1, z1, ...] (y is always 0 on the grid),
//   c — service→service edges as flat index pairs [from0, to0, from1, ...],
//   i — internet→service edges as indices into t.
//
// POWER-FIRST (#87): the rebuild places services in payload order through
// createService, whose GPU placement gate needs the substations' capacity
// already on the board — so substations sort to the front, and EVERY index in
// c and i is remapped through the permutation (positions p reordered in
// lockstep). Array.prototype.sort is stable, but the idx tiebreak keeps the
// non-power relative order explicit rather than implied.
function encodeArch() {
    const ordered = STATE.services
        .map((s, idx) => ({ s, idx }))
        .sort(
            (a, b) =>
                (a.s.type === "power" ? 0 : 1) - (b.s.type === "power" ? 0 : 1) ||
                a.idx - b.idx
        )
        .map((e) => e.s);
    const indexById = new Map(ordered.map((s, idx) => [s.id, idx]));
    const t = ordered.map((s) => s.type);
    const p = [];
    for (const s of ordered) {
        p.push(round2(s.position.x), round2(s.position.z));
    }
    const c = [];
    const inet = [];
    // STATE.connections already carries the internet edges too (createConnection
    // pushes {from:"internet"} entries), so one pass covers both lists.
    for (const conn of STATE.connections) {
        const to = indexById.get(conn.to);
        if (to === undefined) continue;
        if (conn.from === "internet") {
            inet.push(to);
        } else {
            const from = indexById.get(conn.from);
            if (from !== undefined) c.push(from, to);
        }
    }
    return { v: ARCH_VERSION, b: Math.round(STATE.sandboxBudget) || 0, t, p, c, i: inet };
}

function toBase64Url(str) {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(param) {
    const b64 = param.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

// Full shareable URL for the current build, or null when it would blow the
// ~2KB budget (the caller shows the i18n'd "too large" message instead).
function buildShareUrl() {
    const param = toBase64Url(JSON.stringify(encodeArch()));
    const url = `${location.origin}${location.pathname}?arch=${param}`;
    return url.length > MAX_URL_LENGTH ? null : url;
}

// ==================== DECODE / VALIDATE ====================

const isIndex = (n, len) => Number.isInteger(n) && n >= 0 && n < len;

// Untrusted-input gate. Returns a normalized architecture or null; logs a
// single console.warn either way something gets ignored. The services array
// keeps the ORIGINAL indices (dropped slots become null) so the connection
// index space stays aligned with what the payload claimed.
function decodeArchParam(raw) {
    let dropped = 0;
    try {
        if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PARAM_LENGTH) {
            throw new Error("bad size");
        }
        const data = JSON.parse(fromBase64Url(raw));
        if (!data || typeof data !== "object" || data.v !== ARCH_VERSION) {
            throw new Error("bad version");
        }
        const { t, p, c, i: inet } = data;
        if (!Array.isArray(t) || !Array.isArray(p) || !Array.isArray(c) || !Array.isArray(inet)) {
            throw new Error("bad shape");
        }
        if (t.length > MAX_SERVICES || p.length !== t.length * 2) throw new Error("bad counts");
        if (c.length > MAX_CONNECTIONS * 2 || c.length % 2 !== 0) throw new Error("bad counts");
        if (inet.length > MAX_SERVICES) throw new Error("bad counts");

        // Services: type must be a key CONFIG.services OWNS (hasOwnProperty, so
        // "toString"/"__proto__" don't sneak through), position finite and on
        // or near the grid. Bad entries are dropped, good ones survive.
        const services = t.map((type, idx) => {
            const x = p[idx * 2];
            const z = p[idx * 2 + 1];
            const ok =
                typeof type === "string" &&
                Object.prototype.hasOwnProperty.call(CONFIG.services, type) &&
                typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= POSITION_BOUND &&
                typeof z === "number" && Number.isFinite(z) && Math.abs(z) <= POSITION_BOUND;
            if (!ok) dropped++;
            return ok ? { type, x, z } : null;
        });

        // Edges: both endpoints must be surviving services and the pair must be
        // on the same allowlist createConnection enforces — pre-filtering here
        // just keeps a hostile edge from triggering the in-game invalid-wire
        // error path; createConnection still has the final word (and the
        // stateful reverse-edge guard) during the rebuild.
        const connections = [];
        for (let k = 0; k < c.length; k += 2) {
            const from = c[k], to = c[k + 1];
            const ok =
                isIndex(from, services.length) && isIndex(to, services.length) &&
                from !== to && services[from] && services[to] &&
                isValidEdge(services[from].type, services[to].type);
            if (ok) connections.push([from, to]);
            else dropped++;
        }
        const internet = inet.filter((idx) => {
            const ok = isIndex(idx, services.length) && services[idx] &&
                isValidEdge("internet", services[idx].type);
            if (!ok) dropped++;
            return ok;
        });

        const budget = Number.isFinite(data.b)
            ? Math.min(1_000_000, Math.max(0, Math.round(data.b)))
            : CONFIG.sandbox.defaultBudget;

        if (dropped > 0) {
            console.warn(`Shared architecture: ignored ${dropped} invalid entr${dropped === 1 ? "y" : "ies"}`);
        }
        return { budget, services, connections, internet };
    } catch {
        console.warn("Ignoring invalid ?arch= parameter");
        return null;
    }
}

// Reads ?arch= off the address bar, strips it (so reloads don't re-trigger
// and saves don't confuse), and returns the decoded architecture or null.
// Called once from game.js's boot path.
function consumeSharedArchParam() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("arch");
    if (raw === null) return null;
    params.delete("arch");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
    return decodeArchParam(raw);
}

// ==================== REBUILD ====================

// Places a decoded architecture into the (already reset) sandbox. Services go
// through createService — which charges full price, so grant exactly the
// build's cost up front and settle against the shared budget afterwards —
// and edges through createConnection, whose allowlist and reverse-edge guard
// make the final call on every wire.
function rebuildSharedArch(arch) {
    const totalCost = arch.services.reduce(
        (sum, s) => sum + (s ? CONFIG.services[s.type].cost : 0),
        0
    );
    STATE.money = totalCost;

    // Original payload index → live service id (null when createService
    // declined the placement, e.g. two services on one tile).
    const ids = arch.services.map((s) => {
        if (!s) return null;
        const before = STATE.services.length;
        createService(s.type, new THREE.Vector3(s.x, 0, s.z));
        return STATE.services.length > before
            ? STATE.services[STATE.services.length - 1].id
            : null;
    });
    const spent = totalCost - STATE.money;

    for (const idx of arch.internet) {
        if (ids[idx]) createConnection("internet", ids[idx]);
    }
    for (const [from, to] of arch.connections) {
        if (ids[from] && ids[to]) createConnection(ids[from], ids[to]);
    }

    STATE.sandboxBudget = arch.budget;
    STATE.money = Math.max(0, arch.budget - spent);
    syncInput("budget", arch.budget);
}

// ==================== SHARE MODAL ====================

function setShareStatus(key, colorClass) {
    const status = document.getElementById("share-status");
    if (!status) return;
    status.textContent = key ? i18n.t(key) : "";
    status.className = `text-sm font-mono h-5 ${colorClass || ""}`;
}

function showShareModal() {
    setShareStatus(null);
    document.getElementById("share-modal")?.classList.remove("hidden");
}

function closeShareModal() {
    document.getElementById("share-modal")?.classList.add("hidden");
}

function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok;
    try {
        ok = document.execCommand("copy");
    } catch {
        ok = false;
    }
    ta.remove();
    return ok === true;
}

function copyShareLink() {
    const url = buildShareUrl();
    if (!url) {
        setShareStatus("share_too_large", "text-yellow-400");
        return;
    }
    const done = (ok) =>
        setShareStatus(ok ? "share_link_copied" : "share_copy_failed",
            ok ? "text-green-400" : "text-red-400");
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(
            () => done(true),
            () => done(legacyCopy(url))
        );
    } else {
        done(legacyCopy(url));
    }
}

// ==================== PNG EXPORT ====================

function downloadArchitecturePNG() {
    // The WebGL drawing buffer is cleared after presentation (no
    // preserveDrawingBuffer), so re-render and read it back in the SAME
    // synchronous task — the standard fix, free except when actually sharing.
    renderer.render(scene, camera);
    const glCanvas = renderer.domElement;
    if (!glCanvas.width || !glCanvas.height) {
        // A zero-sized drawing buffer (minimized/hidden window) would make
        // drawImage throw from a click handler — bail quietly instead.
        console.warn("Share: canvas has no size, PNG export skipped");
        return;
    }

    const out = document.createElement("canvas");
    out.width = glCanvas.width;
    out.height = glCanvas.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(glCanvas, 0, 0);

    // Small watermark, bottom-right, with a dark offset copy for legibility
    // on the bright parts of the scene.
    const pad = Math.round(out.width / 80);
    const fontSize = Math.max(12, Math.round(out.width / 90));
    ctx.font = `${fontSize}px monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillText(WATERMARK, out.width - pad + 1, out.height - pad + 1);
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText(WATERMARK, out.width - pad, out.height - pad);

    out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "my-architecture.png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, "image/png");
}

export {
    buildShareUrl,
    closeShareModal,
    consumeSharedArchParam,
    copyShareLink,
    decodeArchParam,
    downloadArchitecturePNG,
    encodeArch,
    rebuildSharedArch,
    showShareModal,
};
