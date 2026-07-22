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
        },
      },
    ],
  },
});
