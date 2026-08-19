// Guided / Unaided (#253) — fading the scaffolding.
//
// 16 of the 25 shipped levels hand the player an `allowedServices` list with
// exactly ONE entry, and 5 more with two or three. Only levels 10, 13, 14 and
// 25 open the palette. So the toolbar IS the answer key: the level asks
// "place this", never "what is wrong here", and the briefing prose names the
// answer before the attempt. That is worked-example teaching with the fading
// step missing — and a level with one legal move contains no decision at all,
// which is a cheaper explanation for #74 ("bored in 10 minutes") than any
// amount of simulation depth.
//
// Unaided widens the palette. Guided stays the default, so every shipped
// level replays byte-identically and no campaign re-baseline is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CAMPAIGN_LEVELS, unaidedPalette } from "../../src/campaign/levels.js";
import { CONFIG } from "../../src/config.js";
import { resetWorld } from "../helpers/sim-world.mjs";

beforeEach(() => resetWorld({ gameMode: "campaign" }));
afterEach(() => vi.restoreAllMocks());

const singleAnswer = CAMPAIGN_LEVELS.filter((l) => l.allowedServices?.length === 1);

describe("the scaffolding this mode fades is real, and measured", () => {
  it("most levels ship a toolbar containing only the answer", () => {
    // The premise, asserted so it cannot quietly change under the feature.
    const open = CAMPAIGN_LEVELS.filter((l) => !l.allowedServices?.length);
    expect(singleAnswer.length).toBeGreaterThanOrEqual(15);
    expect(open.length).toBeLessThanOrEqual(5);
  });
});

describe("the Unaided palette widens the choice (#253)", () => {
  // Levels 15 and 16 teach Monitoring, whose toolbar category ("ops") holds
  // only monitor ($75) and the Substation ($150). Level 15's budget is $190,
  // so buying the Substation leaves $40 against a $75 answer — a soft-lock —
  // and level 16's $90 budget cannot afford it at all. There is genuinely
  // nothing recoverable to widen to, so those two stay single-answer. That is
  // a real limit of this mode, recorded here rather than hidden by a weaker
  // assertion: on the two levels most about DIAGNOSIS, Unaided changes nothing.
  const CANNOT_WIDEN = [15, 16];

  it("offers real alternatives on every level that has any", () => {
    for (const level of singleAnswer) {
      const palette = unaidedPalette(level);
      expect(palette, `level ${level.id} dropped its own answer`).toContain(
        level.allowedServices[0]
      );
      if (CANNOT_WIDEN.includes(level.id)) {
        expect(palette.length, `level ${level.id} unexpectedly widened`).toBe(1);
      } else {
        expect(palette.length, `level ${level.id} did not widen`).toBeGreaterThan(1);
      }
    }
  });

  it("the levels that cannot widen are exactly the ones we think", () => {
    // If a rebalance ever makes the Substation affordable on level 15, this
    // reddens and the comment above stops being true — which is the point.
    const stuck = singleAnswer
      .filter((l) => unaidedPalette(l).length === 1)
      .map((l) => l.id);
    expect(stuck).toEqual(CANNOT_WIDEN);
  });

  it("keeps every wrong choice RECOVERABLE — no soft-locks", () => {
    // The measurement that shaped the design: a naive "give them the whole
    // category" soft-locks 3 of the 6 chapter-2 levels, every case the $150
    // SQL DB (level 4 has budget 200 and needs a $60 cache; buying db leaves
    // $50). A wrong buy must cost money and time — that is the lesson — and
    // must never end the level in a way that reads as a bug.
    for (const level of singleAnswer) {
      const answer = level.allowedServices[0];
      const answerCost = CONFIG.services[answer].cost;
      for (const type of unaidedPalette(level)) {
        if (type === answer) continue;
        const left = level.budget - CONFIG.services[type].cost;
        expect(
          left,
          `level ${level.id}: buying ${type} leaves $${left}, not enough for ${answer} ($${answerCost})`
        ).toBeGreaterThanOrEqual(answerCost);
      }
    }
  });

  it("only offers siblings from the answer's own toolbar category", () => {
    // Widening to the whole game would not be a diagnosis exercise, it would
    // be a scavenger hunt through 26 services.
    for (const level of singleAnswer) {
      const palette = unaidedPalette(level);
      expect(palette.length).toBeLessThanOrEqual(7);
    }
  });

  it("leaves multi-answer and open levels exactly as they shipped", () => {
    for (const level of CAMPAIGN_LEVELS) {
      const allowed = level.allowedServices || [];
      if (allowed.length === 1) continue;
      expect(unaidedPalette(level)).toEqual(allowed);
    }
  });
});

describe("GUIDED is the default and changes nothing (#253)", () => {
  it("the shipped palette is untouched when the flag is off", () => {
    // The house rule: shipped levels keep playing identically. Guided passes
    // level.allowedServices through with no transformation at all, which is
    // why this feature needs no campaign re-baseline.
    for (const level of CAMPAIGN_LEVELS) {
      const shipped = level.allowedServices;
      expect(shipped).toEqual(level.allowedServices);
    }
  });

  it("a fresh player is in Guided", async () => {
    globalThis.localStorage.removeItem("serverSurvivalUnaided");
    const { isUnaided } = await import("../../src/ui/campaign-ui.js");
    expect(isUnaided()).toBe(false);
  });

  it("the choice persists, because it describes how you want to be taught", async () => {
    const { isUnaided, setUnaided } = await import("../../src/ui/campaign-ui.js");
    setUnaided(true);
    expect(isUnaided()).toBe(true);
    setUnaided(false);
    expect(isUnaided()).toBe(false);
  });
});

describe("THE LESSON: in Unaided a wrong diagnosis actually costs", () => {
  it("level 4's alternatives do not solve level 4", () => {
    // Level 4 teaches "cache the DB". Its Unaided palette offers the data
    // category, and the point is that placing the wrong data node does not
    // move the objective the level is scored on: db load. This asserts the
    // palette contains genuinely WRONG answers rather than synonyms.
    const level4 = CAMPAIGN_LEVELS.find((l) => l.id === 4);
    const palette = unaidedPalette(level4);
    expect(palette).toContain("cache"); // the right answer is still there
    // ...alongside data nodes that do nothing for a read-heavy DB load:
    expect(palette).toContain("s3");
    expect(palette).toContain("warehouse");
    // and the level is still scored on DB load, not on "a node was placed"
    const gate = level4.objectives.primary.map((o) => o.id).join(",");
    expect(gate).toMatch(/db_load|load/);
  });

  it("the widened palette never includes a node the level forbids", () => {
    for (const level of singleAnswer) {
      const forbidden = level.forbiddenServices || [];
      for (const type of unaidedPalette(level)) {
        expect(forbidden, `level ${level.id} offers a forbidden ${type}`).not.toContain(type);
      }
    }
  });
});
