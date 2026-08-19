// The tutorial appears when it is needed (#263).
//
// Two halves of one problem, both verified on main before this change:
//
// 1. The EDUCATION mode never taught. `tutorial.start()` had exactly ONE call
//    site — survival's start button — and nothing under src/campaign/ or
//    campaign-ui.js mentioned the tutorial at all. A player who clicked
//    Campaign, the mode whose entire purpose is teaching, was taught neither
//    the controls nor anything else.
//
// 2. Survival taught COMPULSIVELY. `markCompleted()` wrote a flag on finish
//    and `isCompleted()` existed to read it — with no callers anywhere. So a
//    veteran got the whole 17-step walkthrough on every single start.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CAMPAIGN_LEVELS } from "../../src/campaign/levels.js";
import { applyToolbarGating, isTypeAllowed } from "../../src/ui/toolbar.js";
import { resetWorld } from "../helpers/sim-world.mjs";

beforeEach(() => resetWorld({ gameMode: "campaign" }));
afterEach(() => {
  applyToolbarGating(null, null); // clear the gate between tests
  vi.restoreAllMocks();
});

describe("the tutorial respects its own completed flag (#263)", () => {
  it("survival asks isCompleted before starting", () => {
    // The precise dead code this closes: the flag was written and never read.
    const src = readFileSync("game.js", "utf8");
    expect(src).toMatch(/window\.tutorial\s*&&\s*!window\.tutorial\.isCompleted\(\)/);
  });

  it("there is a deliberate way back in", () => {
    // Respecting the flag without an entry point would REMOVE the tutorial
    // from everyone who has seen it once. The fix must give the door back.
    const game = readFileSync("game.js", "utf8");
    const html = readFileSync("index.html", "utf8");
    expect(game).toContain("window.startTutorial");
    expect(game).toContain("window.tutorial.reset()"); // replay really restarts it
    expect(html).toContain('onclick="startTutorial()"');
  });
});

describe("the campaign teaches a first-timer (#263)", () => {
  it("level 1 starts the tutorial, and only level 1", () => {
    const src = readFileSync("src/ui/campaign-ui.js", "utf8");
    expect(src).toMatch(/levelId === 1 && window\.tutorial && !window\.tutorial\.isCompleted\(\)/);
    // The tutorial assumes an EMPTY grid — it walks the player through
    // placing the first firewall. Three levels have one (1, 10, 14), but 10
    // and 14 sit in chapters 2 and 3, reached after nine and thirteen levels
    // of play, so a walkthrough there would be an insult rather than a
    // lesson. Level 1 is the only empty board a first-timer meets.
    const level1 = CAMPAIGN_LEVELS.find((l) => l.id === 1);
    expect(level1.preBuilt.services).toEqual([]);
    const emptyBoards = CAMPAIGN_LEVELS.filter((l) => l.preBuilt.services.length === 0);
    expect(emptyBoards.map((l) => l.id)).toEqual([1, 10, 14]);
    expect(Math.min(...emptyBoards.map((l) => l.id))).toBe(1);
  });
});

describe("steps the level cannot offer are skipped (#263)", () => {
  it("campaign level 1 forbids the CDN the tutorial asks for", () => {
    // The trap this avoids. Level 1's palette is waf/alb/compute/db/s3 — no
    // CDN — while the walkthrough has three CDN steps. Without skipping, the
    // tutorial stalls on an instruction the player physically cannot follow,
    // which is worse than no tutorial at all.
    const level1 = CAMPAIGN_LEVELS.find((l) => l.id === 1);
    expect(level1.allowedServices).not.toContain("cdn");
    applyToolbarGating(level1.allowedServices, level1.forbiddenServices);
    expect(isTypeAllowed("cdn")).toBe(false);
    expect(isTypeAllowed("waf")).toBe(true);
  });

  it("every tutorial step that needs a service declares which one", () => {
    // The skip rule reads `requires`; a step that forgets it can never be
    // skipped and would reintroduce the stall.
    const src = readFileSync("src/tutorial.js", "utf8");
    const actionSteps = src
      .split("\n")
      .filter((l) => /^\s*id: '(place|connect)-/.test(l));
    const requiresCount = (src.match(/^\s*requires: '/gm) || []).length;
    expect(actionSteps.length).toBeGreaterThan(10);
    expect(requiresCount).toBe(actionSteps.length);
  });

  it("the skip loop cannot hang: it completes when nothing is playable", () => {
    const src = readFileSync("src/tutorial.js", "utf8");
    // The while-loop advances, and the exhausted case finishes rather than
    // returning into a blank modal.
    expect(src).toContain("this.currentStep++");
    expect(src).toMatch(/if \(!step\) \{[\s\S]*?this\.complete\(\);/);
  });

  it("an unavailable gate never hides a step by accident", () => {
    // Survival has no gate at all; a throw or a missing toolbar must fall
    // back to showing the step, not to silently skipping the tutorial.
    applyToolbarGating(null, null);
    expect(isTypeAllowed("cdn")).toBe(true);
    expect(isTypeAllowed("waf")).toBe(true);
  });
});
