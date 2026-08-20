import { defineConfig } from "vitest/config";

// Two tiers (#155 PR 10):
//   unit — pure-logic tests that import leaf modules with no DOM/THREE needs
//          (locales, config, levels, i18n usage, campaign objectives).
//   sim  — headless simulation tests over the REAL game modules. game.js's
//          module graph touches THREE and the index.html DOM at eval time, so
//          this project runs under happy-dom with a THREE stub + HTML fixture
//          installed by tests/helpers/sim-setup.mjs BEFORE any game import.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.mjs"],
        },
      },
      {
        test: {
          name: "sim",
          environment: "happy-dom",
          include: ["tests/sim/*.test.mjs"],
          setupFiles: ["tests/helpers/sim-setup.mjs"],
          // These tests PLAY the game. The beatability harness (#254) runs
          // every campaign level through several builds, and "the hollow set
          // never grows" runs all twenty-four of them in one test: 2.2 s on an
          // idle machine, and over 5 s when the rest of the suite is running
          // beside it. Vitest's default is 5 s — a default, not a budget
          // anyone chose for a suite like this — so main currently fails
          // roughly one full run in two, on a machine that is merely busy.
          //
          // Reproduced before this change: 2 spurious failures in 4 full runs
          // of an unmodified main, the failing test reporting 5071 ms, 5245 ms
          // and 6134 ms against a 5000 ms limit.
          //
          // 20 s still catches a genuine hang, which is the only thing a
          // timeout is for here: nothing in these tests waits on IO, a timer
          // or a clock. They are pure simulation over a fixed dt.
          testTimeout: 20000,
        },
      },
    ],
  },
});
