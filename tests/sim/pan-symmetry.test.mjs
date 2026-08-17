// Drag-pan axis symmetry (#242).
//
// Reported: "drag right and the view moves right, as expected; drag DOWN and
// the view moves UP." The two axes disagreed. Horizontal was grab-the-world
// (the board follows the cursor) while vertical was inverted, which is the
// one combination that feels broken rather than merely a preference — every
// map, every 3D editor and every other pan in this game picks one convention
// and applies it to both axes.
//
// The cause was a sign: the handler computed panY from +dy and then passed
// -panY, so a downward drag produced an upward pan. Screen Y grows downward,
// so both terms must be negative-of-delta for the board to follow the cursor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetWorld } from "../helpers/sim-world.mjs";
// game.js MUST be imported before handlers.js: they form a runtime cycle, and
// handlers' module body calls resetCamera(), which reads a const declared
// later in its own file. Importing handlers first hits that TDZ.
import { cameraTarget } from "../../game.js";
import { panCameraScreen } from "../../src/input/handlers.js";

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

describe("panCameraScreen moves the camera along screen axes", () => {
  it("is symmetric: equal-and-opposite inputs cancel exactly", () => {
    // Whatever the azimuth, panning by (a, b) and then (-a, -b) must land
    // back where it started. A one-sided sign error inside the rotation would
    // break this without any knowledge of which direction is "right".
    const before = { x: cameraTarget.x, z: cameraTarget.z };
    panCameraScreen(3, 5);
    panCameraScreen(-3, -5);
    expect(cameraTarget.x).toBeCloseTo(before.x, 9);
    expect(cameraTarget.z).toBeCloseTo(before.z, 9);
  });

  it("the two axes are independent — one does not leak into the other", () => {
    const start = { x: cameraTarget.x, z: cameraTarget.z };
    panCameraScreen(1, 0);
    const afterRight = { x: cameraTarget.x, z: cameraTarget.z };
    panCameraScreen(-1, 0);
    panCameraScreen(0, 1);
    const afterUp = { x: cameraTarget.x, z: cameraTarget.z };

    const rightDelta = Math.hypot(afterRight.x - start.x, afterRight.z - start.z);
    const upDelta = Math.hypot(afterUp.x - start.x, afterUp.z - start.z);
    // Both axes move the same distance for the same input magnitude: a pan
    // that is faster vertically than horizontally is the other half of what
    // "the axes disagree" can mean.
    expect(rightDelta).toBeCloseTo(1, 6);
    expect(upDelta).toBeCloseTo(1, 6);
  });
});

describe("the drag handler treats both axes the same way (#242)", () => {
  it("passes both pan terms with the same sign convention", () => {
    // The handler lives inside a mousemove listener that needs a real pointer
    // sequence to reach, so this pins the CALL rather than simulating a drag:
    // panX is negative-of-dx and panY is positive-of-dy, so the call site must
    // pass panY unnegated for the board to follow the cursor on both axes.
    // Passing `-panY` here is exactly the reported bug.
    const src = readFileSync("src/input/handlers.js", "utf8");
    expect(src).toContain("panCameraScreen(panX, panY)");
    expect(src).not.toContain("panCameraScreen(panX, -panY)");
  });

  it("keyboard panning is untouched, and is a different convention on purpose", () => {
    // WASD moves the CAMERA (W looks further up the board); dragging moves the
    // WORLD (the board follows the cursor). Both are standard and they can
    // coexist — the bug was never mouse-vs-keys, it was the mouse disagreeing
    // with ITSELF between its two axes. This guards against a "fix" that
    // repairs the drag by inverting the keys.
    const src = readFileSync("game.js", "utf8");
    expect(src).toContain("panCameraScreen(0, keyPanStep)"); // W / ArrowUp
    expect(src).toContain("panCameraScreen(0, -keyPanStep)"); // S / ArrowDown
    expect(src).toContain("panCameraScreen(keyPanStep, 0)"); // D / ArrowRight
    expect(src).toContain("panCameraScreen(-keyPanStep, 0)"); // A / ArrowLeft
  });
});
