// Scoreboard panel (#69): main-menu button -> modal listing the local top 10.
// Reads persistence/scoreboard.js only; it never touches the simulation.

import { i18n } from "../i18n.js";
import { clearScoreboard, loadScoreboard } from "../persistence/scoreboard.js";

function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    if (hours > 0) return i18n.t("time_h", { h: hours, m: mins, s: secs });
    if (mins > 0) return i18n.t("time_m", { m: mins, s: secs });
    return i18n.t("time_s", { s: secs });
}

function cell(text, className) {
    const td = document.createElement("td");
    td.className = className;
    td.textContent = text;
    return td;
}

export function renderScoreboardPanel() {
    const body = document.getElementById("scoreboard-body");
    const empty = document.getElementById("scoreboard-empty");
    const table = document.getElementById("scoreboard-table");
    const clearBtn = document.getElementById("scoreboard-clear-btn");
    if (!body) return;
    const entries = loadScoreboard();
    body.replaceChildren();
    entries.forEach((entry, i) => {
        const tr = document.createElement("tr");
        tr.className = i === 0 ? "text-yellow-300" : "text-gray-200";
        tr.append(
            cell(`#${i + 1}`, "py-2 pr-3 font-bold"),
            cell(entry.score.toLocaleString(i18n.currentLocale), "py-2 pr-3 font-mono"),
            cell(formatDuration(entry.seconds), "py-2 pr-3 font-mono whitespace-nowrap"),
            cell(
                entry.at ? new Date(entry.at).toLocaleDateString(i18n.currentLocale) : "",
                "py-2 text-gray-400 text-sm"
            )
        );
        body.append(tr);
    });
    const has = entries.length > 0;
    table?.classList.toggle("hidden", !has);
    clearBtn?.classList.toggle("hidden", !has);
    empty?.classList.toggle("hidden", has);
}

export function showScoreboard() {
    document.getElementById("main-menu-modal")?.classList.add("hidden");
    renderScoreboardPanel();
    document.getElementById("scoreboard-modal")?.classList.remove("hidden");
}

export function closeScoreboard() {
    document.getElementById("scoreboard-modal")?.classList.add("hidden");
    document.getElementById("main-menu-modal")?.classList.remove("hidden");
}

export function onClearScoreboard() {
    if (!window.confirm(i18n.t("scoreboard_clear_confirm"))) return;
    clearScoreboard();
    renderScoreboardPanel();
}
