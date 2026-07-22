// Vitest setup for the "sim" project (#155 PR 10). Runs BEFORE each sim test
// file is imported, i.e. before game.js's module graph evaluates. It must
// provide everything game.js touches at module-eval time:
//   1. globalThis.THREE — the game uses THREE as a classic CDN global.
//   2. The index.html DOM — game.js and src/input/handlers.js grab elements
//      (canvas-container, clear-all, ...) with no null guards at top level.
//   3. Audio/AudioContext — SoundService constructs Audio() eagerly and the
//      topology code fires click sounds; happy-dom's media stack is not
//      reliable enough, so both get inert stand-ins.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_STUB } from "./three-stub.mjs";

globalThis.THREE = THREE_STUB;

// ---- Inert audio ----
class AudioStub {
  constructor(src) {
    this.src = src;
    this.paused = true;
    this.loop = false;
    this.volume = 1;
    this.currentTime = 0;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}
globalThis.Audio = AudioStub;
globalThis.window.Audio = AudioStub;

class AudioContextStub {
  constructor() {
    this.state = "suspended"; // playTone() bails unless "running" — silence
    this.currentTime = 0;
    this.destination = {};
  }
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect() {},
    };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
}
globalThis.window.AudioContext = AudioContextStub;

// Browsers coerce `el.innerText = 42` to a string; happy-dom throws. The game
// assigns numbers to innerText/textContent all over the HUD, so shim both
// setters to coerce like a real DOM does.
for (const [proto, prop] of [
  [globalThis.window.HTMLElement.prototype, "innerText"],
  [globalThis.window.Node.prototype, "textContent"],
]) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (desc?.set) {
    Object.defineProperty(proto, prop, {
      ...desc,
      set(v) {
        desc.set.call(this, String(v));
      },
    });
  }
}

// loadGameState's catch path calls alert(); keep it inert but observable.
globalThis.alertCalls = [];
globalThis.window.alert = (msg) => globalThis.alertCalls.push(msg);
globalThis.alert = globalThis.window.alert;

// ---- Real index.html DOM fixture ----
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
if (!bodyMatch) throw new Error("sim-setup: could not extract <body> from index.html");
// Strip script tags so happy-dom doesn't try to fetch CDN scripts / main.js.
const bodyHtml = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "");
globalThis.document.body.innerHTML = bodyHtml;
