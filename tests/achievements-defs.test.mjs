// Achievement definitions shape (#158) — pure data, no DOM, no THREE (tier 1).
// The load-bearing invariants: ids are unique (persistence keys), every def
// has its i18n name/desc pair in en (the locale-parity suites then enforce
// all other locales), and every campaign chapter is covered by a chapter def.
import { describe, expect, it } from "vitest";
import { ACHIEVEMENT_DEFS, POLL_DEFS, eventDefs } from "../src/achievements/definitions.js";
import { CAMPAIGN_LEVELS } from "../src/campaign/levels.js";
import { EN_TRANSLATIONS as en } from "../src/locales/en.js";

const VALID_EVENTS = ["levelWin", "locale", "spikeEnd"];

describe("achievement definitions", () => {
  it("ships exactly 26 defs with unique ids", () => {
    expect(ACHIEVEMENT_DEFS).toHaveLength(26);
    const ids = ACHIEVEMENT_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every def has a valid shape (checkKind, event, tier, check)", () => {
    for (const d of ACHIEVEMENT_DEFS) {
      expect(["poll", "event"], d.id).toContain(d.checkKind);
      expect(["bronze", "silver", "gold"], d.id).toContain(d.tier);
      expect(typeof d.check, d.id).toBe("function");
      if (d.checkKind === "event") {
        expect(VALID_EVENTS, d.id).toContain(d.event);
      } else {
        expect(d.event, d.id).toBeUndefined();
      }
    }
  });

  it("splits into 9 polls and 17 events", () => {
    expect(POLL_DEFS).toHaveLength(9);
    expect(
      eventDefs("levelWin").length + eventDefs("locale").length + eventDefs("spikeEnd").length
    ).toBe(17);
  });

  it("every def has ach_<id>_name and ach_<id>_desc in en", () => {
    const missing = [];
    for (const d of ACHIEVEMENT_DEFS) {
      for (const suffix of ["_name", "_desc"]) {
        const key = `ach_${d.id}${suffix}`;
        if (!(key in en)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every campaign chapter with a chapter_*_done def", () => {
    const chapters = new Set(CAMPAIGN_LEVELS.map((l) => l.chapter));
    const chapterDefs = ACHIEVEMENT_DEFS.filter((d) => d.id.startsWith("chapter_"));
    expect(chapterDefs).toHaveLength(chapters.size);
  });

  it("fortress is an event def (the poll-edge design was rejected)", () => {
    const fortress = ACHIEVEMENT_DEFS.find((d) => d.id === "fortress");
    expect(fortress.checkKind).toBe("event");
    expect(fortress.event).toBe("spikeEnd");
  });
});
