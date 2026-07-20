import js from "@eslint/js";
import globals from "globals";

// Baseline lint for the pre-ESM codebase (#155 PR 1 of 10).
//
// The game is still classic global scripts — every file shares one global
// scope, so cross-file symbols (STATE, createService, …) look "undefined" to
// a per-file linter. no-undef/no-unused-vars therefore stay off until the
// native-ESM conversion (PR 2) makes imports explicit; then they come on.
// What stays ON already catches real bugs: duplicate object keys (found
// several live ones in the locales on first run), unreachable code,
// self-assignments, invalid regexes, etc.
export default [
  {
    ignores: ["node_modules/**", "assets/**", "market/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // The game's Request entity shadows the browser's built-in fetch Request —
    // intentional and harmless in-game (nothing here uses fetch). The class
    // gets renamed when PR 2 introduces real modules.
    files: ["src/entities/Request.js"],
    rules: { "no-redeclare": "off" },
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
