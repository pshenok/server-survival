// Build-tool shortcuts (#70): V select, C link, X demolish, U unlink. The keys
// go through window.setTool, the function the buttons' own onclick calls, so a
// key and a click cannot drift apart.
//
// The guards are the point of half of these tests. Without them, Cmd/Ctrl+C,
// +V and +X (copy, paste and cut) would switch tools, and typing a sandbox
// value or a save name containing one of these letters would too.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { TOOL_KEYS } from "../../src/input/handlers.js";

const press = (key, init = {}, target = document) =>
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }));

beforeEach(() => {
    resetGame("survival");
    window.setTool("select");
});

describe("each build tool has a key", () => {
    it.each([
        ["c", "connect"],
        ["x", "delete"],
        ["u", "unlink"],
    ])("%s switches to %s, exactly as clicking its button does", (key, tool) => {
        press(key);

        expect(STATE.activeTool).toBe(tool);
        expect(document.getElementById(`tool-${tool}`).classList.contains("active")).toBe(true);
        expect(document.getElementById("tool-select").classList.contains("active")).toBe(false);
    });

    it("v returns to select from any other tool", () => {
        window.setTool("delete");
        press("v");
        expect(STATE.activeTool).toBe("select");
    });

    it("works with Shift or Caps Lock held, as H, R and T already do", () => {
        press("C", { shiftKey: true });
        expect(STATE.activeTool).toBe("connect");
    });
});

describe("the keys stay out of the way", () => {
    it.each([
        ["Cmd+C (copy)", "c", { metaKey: true }],
        ["Ctrl+V (paste)", "v", { ctrlKey: true }],
        ["Ctrl+X (cut)", "x", { ctrlKey: true }],
        ["Alt+U", "u", { altKey: true }],
    ])("%s does not switch tools", (_, key, mods) => {
        // Start on a tool the key would NOT select, or a broken guard switches
        // to the tool already active and the test cannot tell.
        const start = TOOL_KEYS[key] === "delete" ? "connect" : "delete";
        window.setTool(start);
        press(key, mods);
        expect(STATE.activeTool).toBe(start);
    });

    it("typing into a form field does not switch tools", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);
        try {
            press("c", {}, input);
            expect(STATE.activeTool).toBe("select");
        } finally {
            input.remove();
        }
    });

    it("no tool key collides with a camera or HUD key", () => {
        // WASD/arrows pan, Q/E orbit, R resets, T toggles the view, H hides
        // the HUD. #70 proposed Q for Queue and D for the database; both were
        // already taken, which is why the letters here differ from the issue.
        const taken = ["w", "a", "s", "d", "q", "e", "r", "t", "h"];
        expect(Object.keys(TOOL_KEYS).filter((k) => taken.includes(k))).toEqual([]);
    });
});

describe("each key is printed on its own button", () => {
    const html = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"),
        "utf8"
    );

    it.each(Object.entries(TOOL_KEYS))("%s is shown on tool-%s", (key, tool) => {
        const button = html.slice(html.indexOf(`id="tool-${tool}"`));
        const firstHint = button.match(/class="key-hint[^"]*"[^>]*>([^<]*)</);
        expect(firstHint?.[1]).toBe(key.toUpperCase());
        // ...and the hint belongs to this button, not to the next one.
        expect(button.indexOf("key-hint")).toBeLessThan(button.indexOf("</button>"));
    });
});
