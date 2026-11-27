// Survival scoreboard (#69): ordering, cap, tie-breaks, corrupt-store hardening.
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCOREBOARD_KEY,
  SCOREBOARD_SIZE,
  clearScoreboard,
  loadScoreboard,
  recordScore,
} from "../src/persistence/scoreboard.js";

// Tier 1 runs under node, which has no localStorage: install a minimal one.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
};

beforeEach(() => {
  localStorage.clear();
});

describe("scoreboard", () => {
  it("starts empty", () => {
    expect(loadScoreboard()).toEqual([]);
  });

  it("records a run and reports rank 1 as the new best", () => {
    expect(recordScore({ score: 500, seconds: 120, at: 1 })).toEqual({ rank: 1, isBest: true });
    expect(loadScoreboard()).toEqual([{ score: 500, seconds: 120, at: 1 }]);
  });

  it("keeps entries sorted best first and reports the rank", () => {
    recordScore({ score: 500, seconds: 100, at: 1 });
    recordScore({ score: 900, seconds: 100, at: 2 });
    expect(recordScore({ score: 700, seconds: 100, at: 3 })).toEqual({ rank: 2, isBest: false });
    expect(loadScoreboard().map((e) => e.score)).toEqual([900, 700, 500]);
  });

  it("breaks score ties by shorter time, then earlier run", () => {
    recordScore({ score: 500, seconds: 200, at: 1 });
    expect(recordScore({ score: 500, seconds: 100, at: 2 }).rank).toBe(1);
    expect(recordScore({ score: 500, seconds: 100, at: 3 }).rank).toBe(2);
    expect(loadScoreboard().map((e) => e.at)).toEqual([2, 3, 1]);
  });

  it("caps the board and returns null rank for runs that miss it", () => {
    for (let i = 1; i <= SCOREBOARD_SIZE; i++) recordScore({ score: i * 100, seconds: 10, at: i });
    expect(recordScore({ score: 50, seconds: 10, at: 99 })).toEqual({ rank: null, isBest: false });
    const board = loadScoreboard();
    expect(board).toHaveLength(SCOREBOARD_SIZE);
    expect(board[SCOREBOARD_SIZE - 1].score).toBe(100);
    expect(recordScore({ score: 150, seconds: 10, at: 100 }).rank).toBe(SCOREBOARD_SIZE);
    expect(loadScoreboard().at(-1).score).toBe(150);
  });

  it("ignores zero, negative and non-numeric scores", () => {
    expect(recordScore({ score: 0, seconds: 5 }).rank).toBeNull();
    expect(recordScore({ score: -3, seconds: 5 }).rank).toBeNull();
    expect(recordScore({ score: "abc", seconds: 5 }).rank).toBeNull();
    expect(loadScoreboard()).toEqual([]);
  });

  it("treats corrupt or unknown-version stores as empty and recovers", () => {
    localStorage.setItem(SCOREBOARD_KEY, "{not json");
    expect(loadScoreboard()).toEqual([]);
    localStorage.setItem(SCOREBOARD_KEY, JSON.stringify({ version: 99, entries: [{ score: 5 }] }));
    expect(loadScoreboard()).toEqual([]);
    localStorage.setItem(SCOREBOARD_KEY, JSON.stringify({ version: 1, entries: "nope" }));
    expect(loadScoreboard()).toEqual([]);
    expect(recordScore({ score: 10, seconds: 1, at: 1 }).rank).toBe(1);
  });

  it("drops malformed entries from a hand-edited store", () => {
    localStorage.setItem(
      SCOREBOARD_KEY,
      JSON.stringify({ version: 1, entries: [null, { score: "x" }, { score: 40, seconds: 3, at: 2 }] })
    );
    expect(loadScoreboard()).toEqual([{ score: 40, seconds: 3, at: 2 }]);
  });

  it("reports no rank when the browser refuses the write", () => {
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(recordScore({ score: 100, seconds: 1, at: 1 })).toEqual({ rank: null, isBest: false });
    } finally {
      globalThis.localStorage.setItem = real;
    }
    expect(loadScoreboard()).toEqual([]);
  });

  it("clear empties the board", () => {
    recordScore({ score: 10, seconds: 1, at: 1 });
    clearScoreboard();
    expect(loadScoreboard()).toEqual([]);
  });
});
