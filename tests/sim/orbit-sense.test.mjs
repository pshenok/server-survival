// Q/E (and the two-finger twist, #322) turn the board the same way on screen
// in both views.
//
// One azimuth drives both views: in isometric the eye orbits the target, in
// top-down the camera's up vector spins. With the same sign for both, E turned
// the board counter-clockwise in isometric and clockwise in top-down, measured
// in the browser on three r128 by projecting a ground point: -13.1 and +17.2
// degrees for the same orbitCamera(+0.3).
//
// No projection is needed to see it. Each view has a ground direction that is
// "up" on the screen: the isometric eye's horizontal line of sight, and the
// top-down camera's up vector. Both views look down on the ground from above,
// so neither mirrors it, and the board turns the same way on screen exactly
// when those two directions turn the same way in the world.
import { describe, it, expect, afterEach } from "vitest";
import { camera, cameraTarget } from "../../game.js";
import {
    isIsometric,
    orbitCamera,
    panCameraScreen,
    resetCamera,
    toggleView,
} from "../../src/input/handlers.js";

const cross = (a, b) => a.x * b.z - a.z * b.x;
const screenUpOnGround = () =>
    isIsometric
        ? { x: cameraTarget.x - camera.position.x, z: cameraTarget.z - camera.position.z }
        : { x: camera.up.x, z: camera.up.z };

function turnOf(delta) {
    resetCamera();
    const before = screenUpOnGround();
    orbitCamera(delta);
    return Math.sign(cross(before, screenUpOnGround()));
}

function view(iso) {
    if (isIsometric !== iso) toggleView();
}

afterEach(() => {
    view(true);
    resetCamera();
});

describe("the board turns the same way on screen in both views", () => {
    it("E turns isometric and top-down the same way", () => {
        view(true);
        const iso = turnOf(0.3);
        view(false);
        const top = turnOf(0.3);

        expect(iso).not.toBe(0);
        expect(top).toBe(iso);
    });

    it("Q turns them both back the other way", () => {
        view(true);
        const iso = turnOf(-0.3);
        view(false);
        expect(turnOf(-0.3)).toBe(iso);
        expect(iso).toBe(-turnOf(0.3));
    });

    it("isometric keeps the direction it always had", () => {
        // The reference view. A future fix for a mismatch belongs in the
        // top-down branch, not here: E has always turned the isometric board
        // counter-clockwise on screen, which is this sign.
        view(true);
        expect(turnOf(0.3)).toBe(1);
    });
});

describe("panning a spun top-down view still follows the screen", () => {
    it("right and up slide along the screen's own axes, whatever the spin", () => {
        view(false);
        for (const spin of [0, 0.7, -1.9, Math.PI]) {
            resetCamera();
            orbitCamera(spin);
            const up = { x: camera.up.x, z: camera.up.z };
            // Looking straight down, screen-right on the ground is up x back.
            const right = { x: -up.z, z: up.x };

            const moved = (fn) => {
                const p = { x: camera.position.x, z: camera.position.z };
                fn();
                return { x: camera.position.x - p.x, z: camera.position.z - p.z };
            };
            const moveRight = moved(() => panCameraScreen(1, 0));
            const moveUp = moved(() => panCameraScreen(0, 1));

            expect(moveRight.x, `spin ${spin}`).toBeCloseTo(right.x, 6);
            expect(moveRight.z, `spin ${spin}`).toBeCloseTo(right.z, 6);
            expect(moveUp.x, `spin ${spin}`).toBeCloseTo(up.x, 6);
            expect(moveUp.z, `spin ${spin}`).toBeCloseTo(up.z, 6);
        }
    });
});
