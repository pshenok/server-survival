// Native-ESM entry point (#155 PR 2). The only script index.html loads.
// game.js transitively imports every other first-party module.
import "../game.js";
