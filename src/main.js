// Native-ESM entry point (#155 PR 2). The only script index.html loads.
// game.js transitively imports every other first-party module.
import "../game.js";

// The laboratory runs the same engine in disposable worlds; only the main
// window installs its controls. A runner never initializes the game menu.
import { isLabFrame } from './lab/context.js';
if (isLabFrame) import('./lab/frame.js');
else import('./lab/ui.js');
