// Educational failure badges (#156). When a request dies, a short floating
// label rises over the node that dropped it — "No route", "Read-only replica",
// "Queue full ×7" — and fades over ~1.5 s. Every failure becomes a teaching
// moment instead of a red flash the player cannot read.
//
// WIRING: core/actions.js calls spawnFailureBadge() from failRequest and
// throttleRequest with the reason its caller passed (see core/failure-reasons.
// js), and game.js ticks tickFailureBadges(dt) once per animate() frame
// alongside metricsTick — same game-scaled dt, so a badge freezes with the
// board at timeScale 0 and the player can read the failure moment on a paused
// or game-over screen (#189 / #194).
//
// AGGREGATION is what makes this usable rather than noise. At 2 RPS every
// failure deserves its own label; at 40 RPS a cascading failure would spray
// hundreds of unreadable sprites and tank the frame rate. So badges are keyed
// by (service, reason): a repeat hit while the badge is still alive COUNTS UP
// and refreshes its lifetime instead of spawning a second sprite. The active
// set is capped at MAX_BADGES; over the cap the oldest is dropped (Map keeps
// insertion order, so "oldest" is just the first key).
//
// THREE HYGIENE: each badge owns a canvas texture + sprite material, and both
// are disposed on expiry, on clearFailureBadges() (called from resetGame and
// clearAllServices) and when the cap evicts one. Sprites have no geometry of
// their own — THREE shares one internally — so the texture and the material
// are the whole disposal surface. Nothing else here allocates GPU memory.
//
// The badges live in their own scene group (game.js: badgeGroup) rather than
// as children of the service meshes: a badge must outlive the node that
// dropped the request, and sprite scale must not inherit a node's scale.

import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { SOFT_REASONS } from "../core/failure-reasons.js";
// Runtime-only cycle (ui/failure-badges.js -> game.js -> core/actions.js ->
// ui/failure-badges.js) — the established pattern, identical to the way
// entities/Request.js reaches requestGroup: badgeGroup is a top-level const in
// game.js, only dereferenced when a badge is actually spawned.
import { badgeGroup } from "../../game.js";

// Concurrent badges. 12 is roughly "one per node on a busy board" — enough to
// see a cascade spread, few enough to stay readable and cheap.
const MAX_BADGES = 12;
// Seconds of GAME time a badge lives (refreshed by every aggregated hit).
const BADGE_LIFETIME = 1.5;
// Fraction of the lifetime spent fully opaque before the fade starts.
const FADE_START = 0.55;
// World units the label floats upward over its life, and where it starts.
const RISE = 2.0;
const BASE_Y = 5;
// Canvas pixels per world unit — the one knob for on-screen label size.
const PX_PER_UNIT = 15;

const FONT_PX = 26;
const FONT = `bold ${FONT_PX}px "Courier New", monospace`;
const PAD_X = 14;
const PAD_Y = 8;

const HARD_COLOR = "#f87171"; // red-400: the board dropped work
const SOFT_COLOR = "#fbbf24"; // amber-400: deliberate load shedding
const BG_COLOR = "rgba(9, 12, 20, 0.78)";

const STORAGE_KEY = "serverSurvivalFailureBadges";

// key ("serviceId|reason") -> badge record. Insertion-ordered, which is what
// makes the cap eviction "drop the oldest" without a timestamp field.
const badges = new Map();

// Default ON: this is an educational feature, and a player who never finds the
// toggle should still be taught. Persisted like the sound prefs.
let enabled = restoreEnabled();

function restoreEnabled() {
    try {
        return localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
        return true; // private mode / storage disabled — keep the default
    }
}

// ---------------------------------------------------------------- rendering

// Draw (or redraw, after the count ticks up) the label into the badge's own
// canvas and resize the sprite to match. happy-dom canvases have no 2D
// context, so the whole draw is skipped there — the badge still exists, ages
// and disposes exactly the same, which is what the headless tests exercise.
function paint(badge) {
    const text =
        badge.count > 1
            ? `${i18n.t(badge.reason)} ×${badge.count}`
            : i18n.t(badge.reason);

    const canvas = badge.canvas;
    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

    let textW;
    if (ctx) {
        ctx.font = FONT;
        textW = ctx.measureText(text).width;
    } else {
        // No 2D context: approximate so the sprite still gets a sane scale.
        textW = text.length * FONT_PX * 0.6;
    }

    canvas.width = Math.ceil(textW + PAD_X * 2);
    canvas.height = FONT_PX + PAD_Y * 2;

    if (ctx) {
        // Resizing the canvas resets the context state — re-set everything.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = SOFT_REASONS.has(badge.reason) ? SOFT_COLOR : HARD_COLOR;
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }

    badge.texture.needsUpdate = true;
    badge.sprite.scale.x = canvas.width / PX_PER_UNIT;
    badge.sprite.scale.y = canvas.height / PX_PER_UNIT;
    badge.sprite.scale.z = 1;
}

function disposeBadge(badge) {
    badgeGroup.remove(badge.sprite);
    // A Sprite carries no geometry of its own (THREE shares one), so the
    // texture and the material are the complete disposal surface.
    if (badge.material.map) badge.material.map.dispose();
    badge.material.dispose();
}

// ------------------------------------------------------------------- public

// Called from core/actions.js on every failed / throttled request. `reason` is
// a FAIL_REASONS value (null from a caller that has nothing to teach, e.g. a
// test double), in which case nothing is drawn. Positions on the service the
// request was headed to, falling back to the request marker itself for the
// entry-routing failures that never reached a node.
function spawnFailureBadge(req, reason) {
    if (!enabled || !reason) return null;

    const service =
        req && req.target && req.target.id && req.target.id !== "internet"
            ? req.target
            : null;
    const pos = service?.position || req?.mesh?.position || STATE.internetNode.position;
    if (!pos) return null;

    const key = (service?.id || "internet") + "|" + reason;

    // Aggregate: the same node failing the same way keeps ONE badge that
    // counts up and lives longer, instead of stacking unreadable duplicates.
    const existing = badges.get(key);
    if (existing) {
        existing.count++;
        existing.life = BADGE_LIFETIME;
        paint(existing);
        return existing;
    }

    // Over the cap: evict the oldest so a cascade cannot grow without bound.
    while (badges.size >= MAX_BADGES) {
        const oldestKey = badges.keys().next().value;
        disposeBadge(badges.get(oldestKey));
        badges.delete(oldestKey);
    }

    const canvas = document.createElement("canvas");
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(pos.x, BASE_Y, pos.z);
    badgeGroup.add(sprite);

    const badge = {
        key,
        reason,
        count: 1,
        life: BADGE_LIFETIME,
        canvas,
        texture,
        material,
        sprite,
    };
    badges.set(key, badge);
    paint(badge);
    return badge;
}

// One per animate() frame, with the same game-scaled dt as metrics and the
// breaker. Paused (timeScale 0): freeze — no ageing, no fading — so the badges
// on a stopped or game-over board stay readable while the player inspects it.
function tickFailureBadges(dt) {
    if (STATE.timeScale === 0) return;

    for (const [key, badge] of badges) {
        badge.life -= dt;
        if (badge.life <= 0) {
            disposeBadge(badge);
            badges.delete(key);
            continue;
        }
        const age = 1 - badge.life / BADGE_LIFETIME; // 0 -> 1 over the lifetime
        badge.sprite.position.y = BASE_Y + RISE * age;
        badge.material.opacity =
            age < FADE_START ? 1 : 1 - (age - FADE_START) / (1 - FADE_START);
    }
}

// Drop every badge and its GPU resources. Called from resetGame() and from
// clearAllServices() — a badge anchored to a node that no longer exists is
// both meaningless and a leak.
function clearFailureBadges() {
    for (const badge of badges.values()) disposeBadge(badge);
    badges.clear();
}

function areFailureBadgesEnabled() {
    return enabled;
}

function setFailureBadgesEnabled(value) {
    enabled = !!value;
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
        // storage disabled — the preference just is not remembered
    }
    if (!enabled) clearFailureBadges();
    syncFailureBadgeButton();
}

function toggleFailureBadges() {
    setFailureBadgesEnabled(!enabled);
}

// Reflect the preference on the toolbar's settings cluster. Same treatment the
// sound toggles use (dimmed icon + red tint when off), so the three buttons
// read as one group.
function syncFailureBadgeButton() {
    const btn = document.getElementById("tool-badges");
    document.getElementById("badges-icon")?.classList.toggle("opacity-40", !enabled);
    if (btn) btn.classList.toggle("bg-red-900", !enabled);
}

// Test/introspection accessor — the live badge records, newest last.
function getFailureBadges() {
    return [...badges.values()];
}

export {
    BADGE_LIFETIME,
    MAX_BADGES,
    areFailureBadgesEnabled,
    clearFailureBadges,
    getFailureBadges,
    setFailureBadgesEnabled,
    spawnFailureBadge,
    syncFailureBadgeButton,
    tickFailureBadges,
    toggleFailureBadges,
};
