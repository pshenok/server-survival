// Survival scoreboard (#69). A local top-10 of finished Survival runs.
//
// Persistence: localStorage["serverSurvivalScoreboard"] =
//   { version: 1, entries: [{ score, seconds, at }] }   (best first)
// Meta-progress, like achievements: NOT part of save files and NOT reset by
// resetGame. Corrupt or unknown-version stores read as empty, and storage
// failures (quota, privacy mode) never reach the game loop.
//
// The game is static (GitHub Pages, no backend), so this is a per-browser
// board, not a global leaderboard. Only Survival runs that end in game over
// are recorded; campaign and sandbox have no score to compare.

export const SCOREBOARD_KEY = "serverSurvivalScoreboard";
export const SCOREBOARD_VERSION = 1;
export const SCOREBOARD_SIZE = 10;

function getStorage() {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
        return null;
    }
}

function cleanEntry(e) {
    if (!e || typeof e !== "object") return null;
    const score = Math.floor(Number(e.score));
    const seconds = Math.floor(Number(e.seconds));
    const at = Number(e.at);
    if (!Number.isFinite(score) || score < 0) return null;
    return {
        score,
        seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0,
        at: Number.isFinite(at) ? at : 0,
    };
}

// Best score first; on equal scores the shorter run ranks higher, then the
// earlier one (so a tie never bumps an existing entry).
function compareEntries(a, b) {
    return b.score - a.score || a.seconds - b.seconds || a.at - b.at;
}

export function loadScoreboard() {
    const storage = getStorage();
    if (!storage) return [];
    try {
        const raw = storage.getItem(SCOREBOARD_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== SCOREBOARD_VERSION) return [];
        if (!Array.isArray(parsed.entries)) return [];
        return parsed.entries
            .map(cleanEntry)
            .filter(Boolean)
            .sort(compareEntries)
            .slice(0, SCOREBOARD_SIZE);
    } catch (e) {
        console.warn("Scoreboard: failed to load, treating as empty", e);
        return [];
    }
}

// Returns true only when the board was actually written.
function saveScoreboard(entries) {
    const storage = getStorage();
    if (!storage) return false;
    try {
        storage.setItem(
            SCOREBOARD_KEY,
            JSON.stringify({ version: SCOREBOARD_VERSION, entries })
        );
        return true;
    } catch (e) {
        console.warn("Scoreboard: failed to persist", e);
        return false;
    }
}

// Record a finished run. Returns { rank, isBest } where rank is the 1-based
// position on the board, or null when the run did not make the top 10 (or the
// score was 0 or invalid, or the browser refused the write, so the game never
// announces a rank it did not save). isBest is true for the new number one.
export function recordScore({ score, seconds, at = Date.now() }) {
    const entry = cleanEntry({ score, seconds, at });
    if (!entry || entry.score <= 0) return { rank: null, isBest: false };
    const board = loadScoreboard();
    const next = [...board, entry].sort(compareEntries);
    const index = next.indexOf(entry);
    if (index >= SCOREBOARD_SIZE) return { rank: null, isBest: false };
    if (!saveScoreboard(next.slice(0, SCOREBOARD_SIZE))) {
        return { rank: null, isBest: false };
    }
    return { rank: index + 1, isBest: index === 0 };
}

export function clearScoreboard() {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.removeItem(SCOREBOARD_KEY);
    } catch (e) {
        console.warn("Scoreboard: failed to clear", e);
    }
}
