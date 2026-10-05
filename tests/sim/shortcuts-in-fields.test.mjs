// Typing into a sandbox field must not drive the game.
//
// The ten sandbox inputs are number fields, and a number field still fires
// keydown for a letter it is about to reject. Before this guard, pressing H
// while editing the RPS value hid the stats and details panels, R reset the
// camera and T flipped the view. The field's own arrow keys, which step its
// value, also registered as held camera keys and panned the board while the
// player adjusted a number.
//
// Every test pairs the field case with the same key pressed outside a field.
// That control is what makes a pass mean "guarded" rather than "the key does
// nothing at all".
import { describe, it, expect, beforeEach } from "vitest";
import { resetGame, cameraTarget } from "../../game.js";
import { isIsometric, keysPressed } from "../../src/input/handlers.js";

const field = () => document.getElementById("rps-input");
const press = (key, target) =>
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
const release = (key, target) =>
    target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
const statsHidden = () => document.getElementById("statsPanel").classList.contains("hidden");

beforeEach(() => {
    resetGame("sandbox");
    document.getElementById("statsPanel").classList.remove("hidden");
    for (const k in keysPressed) keysPressed[k] = false;
});

describe("letter shortcuts ignore a focused field", () => {
    it("H typed into a field leaves the HUD alone; H on the board toggles it", () => {
        press("h", field());
        expect(statsHidden()).toBe(false);

        press("h", document);
        expect(statsHidden()).toBe(true);
    });

    it("R typed into a field leaves a panned camera where it is", () => {
        cameraTarget.set(20, 0, 20);
        press("r", field());
        expect(cameraTarget.x).toBe(20);

        press("r", document);
        expect(cameraTarget.x).toBe(0);
    });

    it("T typed into a field does not flip the view", () => {
        const before = isIsometric;
        press("t", field());
        expect(isIsometric).toBe(before);

        press("t", document);
        expect(isIsometric).toBe(!before);
        press("t", document);
    });
});

describe("a field's arrow keys step its value, not the camera", () => {
    it("ArrowUp in a field is not recorded as a held camera key", () => {
        press("ArrowUp", field());
        expect(keysPressed.ArrowUp).toBeFalsy();

        press("ArrowUp", document);
        expect(keysPressed.ArrowUp).toBe(true);
        release("ArrowUp", document);
        expect(keysPressed.ArrowUp).toBe(false);
    });

    it("a key held on the board and released inside a field still lets go", () => {
        // keyup is deliberately unguarded: focus can move into a field while a
        // camera key is down, and that key must not stay stuck.
        press("w", document);
        release("w", field());
        expect(keysPressed.w).toBe(false);
    });
});

describe("Esc is the way out, from a field too", () => {
    it("opens the main menu even while a field has focus", () => {
        const menu = document.getElementById("main-menu-modal");
        menu.classList.add("hidden");

        press("Escape", field());

        expect(menu.classList.contains("hidden")).toBe(false);
    });
});
