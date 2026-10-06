// What the player sees when a link is refused.
//
// An invalid link used to cost a click sound and a console.error the player
// never sees, and the message it logged described a five-service chain from
// long before the game had twenty-six. Refusing a link is the moment the
// player most wants to know what the node CAN connect to, so that is what this
// says, drawn from the same edge table that did the refusing.
//
// Styled like the smart hints (src/core/hints.js), not like the alarm
// warnings: it is a lesson, not an incident, and it stays out of
// STATE.intervention, which tracks incidents.
import { i18n } from "../i18n.js";
import { STATE } from "../state.js";
import { isTypeAllowed } from "./toolbar.js";
// Runtime-only cycle (topology.js -> link-feedback.js -> topology.js), the
// same established pattern as topology.js's own: function declarations,
// dereferenced only when called.
import { linkTargets } from "../sim/topology.js";

const SHOW_MS = 6000;
const ATTR = "data-link-rejected";

function listOf(names) {
    let list;
    try {
        list = new Intl.ListFormat(i18n.currentLocale, { style: "long", type: "conjunction" })
            .format(names);
    } catch {
        list = names.join(", ");
    }
    // ICU's Nepali pattern joins the first two items with a bare comma
    // ("A,B, C र D"). A comma always takes a space in every script used here;
    // the ideographic comma Chinese uses is a different character and untouched.
    return list.replace(/,(?=\S)/g, ", ");
}

/**
 * The text for a refused fromType -> toType link. `targets` is every type
 * fromType may send to; a campaign level that forbids a service drops it, so
 * the hint never points at a button the player does not have.
 */
export function linkRejectionLines(fromType, toType, targets) {
    const from = i18n.t(fromType);
    const lines = [i18n.t("link_rejected", { from, to: i18n.t(toType) })];
    const allowed = targets.filter(isTypeAllowed).map((t) => i18n.t(t));
    if (allowed.length) {
        lines.push(i18n.t("link_can_send_to", { from, targets: listOf(allowed) }));
    }
    return lines;
}

export function showLinkRejected(fromType, toType, targets) {
    const container = document.getElementById("intervention-warnings");
    if (!container) return;
    // One at a time: a player clicking around to find a valid target should
    // see the latest answer, not a growing stack of them.
    container.querySelectorAll(`[${ATTR}]`).forEach((el) => el.remove());

    const [headline, detail] = linkRejectionLines(fromType, toType, targets);
    const hint = document.createElement("div");
    hint.setAttribute(ATTR, "");
    hint.setAttribute("role", "status");
    hint.className =
        "intervention-warning warning-info border-2 rounded-lg px-6 py-3 mb-2 shadow-lg";
    // A source with nine targets makes a long line; on a phone it must wrap
    // inside the screen rather than run off both edges of it.
    hint.style.maxWidth = "min(36rem, calc(100vw - 1rem))";
    const title = document.createElement("div");
    title.className = "font-bold text-sm";
    title.textContent = headline;
    hint.appendChild(title);
    if (detail) {
        const body = document.createElement("div");
        body.className = "text-xs mt-1 opacity-90";
        body.textContent = detail;
        hint.appendChild(body);
    }
    container.appendChild(hint);

    setTimeout(() => {
        hint.style.transition = "all 0.3s ease-out";
        hint.style.opacity = "0";
        hint.style.transform = "translateY(-20px)";
        setTimeout(() => hint.remove(), 300);
    }, SHOW_MS - 300);
}

/**
 * Rings every node the picked Link source could connect to, before the player
 * clicks, so the rule is visible rather than discovered one refusal at a time.
 * Called once per frame from animate(), paused or not: players build while
 * paused. Any tool but Link, or no source picked yet, clears every ring.
 */
export function showLinkTargets(now = 0) {
    const sourceId = STATE.activeTool === "connect" ? STATE.selectedNodeId : null;
    const targets = sourceId ? linkTargets(sourceId) : null;
    // A slow pulse, so a ring reads as an offer rather than as a state.
    const opacity = 0.55 + 0.35 * Math.sin(now / 250);
    for (const s of STATE.services) {
        if (!s.linkTargetRing) continue;
        const on = targets !== null && targets.has(s.id);
        s.linkTargetRing.visible = on;
        if (on) s.linkTargetRing.material.opacity = opacity;
    }
}
