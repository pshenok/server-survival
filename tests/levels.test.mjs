// Campaign level invariants (#155 PR 1) — each one encodes a shipped bug:
// out-of-range preBuilt connection indices, traffic mixes that don't sum to 1,
// and traffic types with no reachable destination (#159, #162, #184).
import { describe, expect, it } from "vitest";
import { loadScriptGlobals } from "./helpers/load-globals.mjs";

// levels.js closes over CampaignObjectives inside check() functions — the
// functions aren't called here, so a stub satisfies evaluation.
const { CAMPAIGN_LEVELS } = loadScriptGlobals("src/campaign/levels.js", {
  CampaignObjectives: {},
});

describe("campaign levels", () => {
  it("has 14 levels with sequential ids", () => {
    expect(CAMPAIGN_LEVELS.map((l) => l.id)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1)
    );
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
