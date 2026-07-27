// Campaign level invariants (#155 PR 1) — each one encodes a shipped bug:
// out-of-range preBuilt connection indices, traffic mixes that don't sum to 1,
// and traffic types with no reachable destination (#159, #162, #184).
import { describe, expect, it } from "vitest";
import { CAMPAIGN_LEVELS } from "../src/campaign/levels.js";
import { EN_TRANSLATIONS as en } from "../src/locales/en.js";

describe("campaign levels", () => {
  // Deliberately count-agnostic (#217 added chapter 4): a new level must not
  // require editing this test, but a gap or a duplicate in the ids silently
  // breaks unlock progression (highestUnlocked = levelId + 1) and the
  // debrief's "next level" lookup, so the SEQUENCE is still pinned.
  it("has N levels with sequential ids from 1", () => {
    expect(CAMPAIGN_LEVELS.map((l) => l.id)).toEqual(
      CAMPAIGN_LEVELS.map((_, i) => i + 1)
    );
  });

  it("groups levels into contiguous, non-decreasing chapters", () => {
    // The level-select renderer emits a heading whenever the chapter changes,
    // so a level filed out of chapter order would print the same heading twice.
    const chapters = CAMPAIGN_LEVELS.map((l) => l.chapter);
    expect(chapters).toEqual([...chapters].sort((a, b) => a - b));
  });

  it("every chapter in use has a heading string in en", () => {
    // renderCampaignLevels() looks the heading up as campaign_chapter_<n>;
    // a missing one renders the raw key at the top of the level list.
    const missing = [...new Set(CAMPAIGN_LEVELS.map((l) => l.chapter))]
      .map((n) => `campaign_chapter_${n}`)
      .filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  describe.each(CAMPAIGN_LEVELS)("level $id — $title", (level) => {
    it("traffic distribution sums to 1", () => {
      const sum = Object.values(level.trafficDistribution).reduce(
        (a, b) => a + b,
        0
      );
      expect(sum).toBeCloseTo(1, 5);
    });

    it("preBuilt connection indices are in range", () => {
      const n = level.preBuilt.services.length;
      for (const [from, to] of level.preBuilt.connections) {
        if (from !== "internet") expect(from).toBeLessThan(n);
        expect(to).toBeLessThan(n);
      }
    });

    it("has at least one primary objective and a timeout backstop", () => {
      expect(level.objectives.primary.length).toBeGreaterThan(0);
      expect(level.failConditions.timeoutSec).toBeGreaterThan(0);
    });

    it("diagramHighlights point at existing preBuilt services", () => {
      for (const idx of Object.keys(level.diagramHighlights || {})) {
        expect(Number(idx)).toBeLessThan(level.preBuilt.services.length);
      }
    });
  });
});
