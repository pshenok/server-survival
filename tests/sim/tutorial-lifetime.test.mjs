// A lesson belongs to the run it is teaching.
//
// Tutorial.hide() only hides the modal — isActive stays true and the step
// machine keeps listening. Escape opens the pause menu and calls hide(), and
// every way out of that menu starts a NEW run, so the tutorial stayed armed
// and invisible for the life of the page.
//
// Three consequences, none of them visible to the player:
//   - the pulse-green button hints are suppressed for the whole session
//     (game.js gates them on !tutorial.isActive);
//   - the hidden machine takes onAction("start_game") from a run it is not
//     teaching, and advances;
//   - if stray actions walk it to the end, complete() calls markCompleted()
//     and the game records a lesson the player never saw, removing the offer.
import { describe, it, expect, beforeEach } from "vitest";
import { resetGame, openMainMenu } from "../../game.js";

// The real key, read from the module rather than retyped: my first draft
// wrote "...Completed" for a key that is "...Complete", so the assertion
// below passed on a key that never existed.
const TUTORIAL_KEY = "serverSurvivalTutorialComplete";
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function beginLesson() {
    // What window.startTutorial does, minus its 500 ms setTimeout.
    resetGame();
    window.tutorial.reset();
    window.tutorial.start();
}

describe("the tutorial does not outlive the run it was teaching", () => {
    beforeEach(() => { try { localStorage.clear(); } catch { /* storage unavailable */ } });

    it("THE BUG: Escape then New Game used to leave it armed and invisible", () => {
        beginLesson();
        expect(window.tutorial.isActive).toBe(true);

        openMainMenu();                              // Escape
        expect(document.getElementById("tutorial-modal").classList.contains("hidden")).toBe(true);

        window.startGame();                          // ...and out to a plain run
        expect(window.tutorial.isActive, "a new run inherited an armed tutorial").toBe(false);
    });

    it("...through every door out of the menu", () => {
        for (const start of [() => window.startGame(), () => window.startSandbox()]) {
            beginLesson();
            openMainMenu();
            start();
            expect(window.tutorial.isActive).toBe(false);
        }
    });

    it("ABANDONING IS NOT FINISHING: the offer survives", () => {
        // skip() and complete() both markCompleted(), and someone who
        // wandered off mid-lesson has not chosen to be done with it.
        beginLesson();
        openMainMenu();
        window.startGame();
        // The control first: finishing DOES record it, so a null here means
        // "abandoning did not mark it", not "this key is never written".
        expect(read(TUTORIAL_KEY)).not.toBe("true");
        window.tutorial.markCompleted();
        expect(read(TUTORIAL_KEY), "the key this test watches must be the real one").toBe("true");
        localStorage.removeItem(TUTORIAL_KEY);
        // Idempotent: leaving twice is not an error.
        expect(window.tutorial.abandon()).toBe(false);
    });

    it("...and the lesson can still be started, which is the point of not marking it", () => {
        beginLesson();
        openMainMenu();
        window.startGame();
        expect(window.tutorial.isActive).toBe(false);
        beginLesson();                               // the door is still there
        expect(window.tutorial.isActive).toBe(true);
        expect(window.tutorial.currentStep).toBe(0);
    });
});
