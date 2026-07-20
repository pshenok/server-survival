import js from "@eslint/js";
import globals from "globals";

// Lint for the native-ESM codebase (#155 PR 2 of 10).
//
// Every first-party file is now a real ES module with explicit imports, so
// no-undef is ON: any bare identifier that isn't imported or a known browser
// global is an error. THREE stays a classic CDN global (r128), so it is
// declared here instead of imported. no-unused-vars stays off until the
// split PRs land (game.js still exports a wide surface).
export default [
  {
    ignores: ["node_modules/**", "assets/**", "market/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        THREE: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["tests/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
];
