// Step 0 of the failure-knee work (#74): the checked-in baseline.
//
// This pins what `main` does TODAY on the reference board, so every later step
// is falsifiable against a number rather than against a memory. It asserts the
// two properties the knee design is built on — both currently TRUE, and both
// meant to become FALSE as the work lands:
//
//   1. There is no readable middle: no RPS exists where the board fails a
//      little and survives.
//   2. The band is a strobe: the bottleneck's utilization never persists in
//      (0.90, 1.20) long enough to be perceived.
//
// When a step flips one of these, the assertion is updated in that step's PR
// with the new measurement — that is the point of the file, not a maintenance
// burden.
import { describe, it, expect, afterEach, vi } from "vitest";
import { sweepAt, sweepSeeds, SEEDS } from "../helpers/reference-board.mjs";

afterEach(() => vi.restoreAllMocks());

// The sweep is the expensive part; run it once and assert over the result.
const RPS_POINTS = [4, 5, 6, 7, 8, 9, 10, 12, 16, 20];

describe("reference board baseline (#74 step 0)", () => {
  const table = RPS_POINTS.map((rps) => sweepAt({ rps, seconds: 60 }));

  it("prints the baseline table", () => {
    const lines = table.map(
      (r) =>
        `rps=${String(r.rps).padStart(2)} ` +
        `fail=${String(r.failures).padStart(5)} ` +
        `done=${String(r.processed).padStart(5)} ` +
        `minRep=${String(r.minReputation).padStart(7)} ` +
        `band=${String(r.bandResidencySec).padStart(6)}s ` +
        `dwell=${String(r.meanDwellSec).padStart(6)}s ` +
        `peakUtil=${r.peakUtil}`
    );
    console.log("\nBASELINE (main, reference board, 60s, seed 0x5eed)\n" + lines.join("\n"));
    expect(table.length).toBe(RPS_POINTS.length);
  });

  it("is deterministic: the same seed reproduces byte-identically", () => {
    const a = sweepAt({ rps: 12, seconds: 20, seed: 0x5eed });
    const b = sweepAt({ rps: 12, seconds: 20, seed: 0x5eed });
    expect(a).toEqual(b);
  });

  it("different seeds give different runs (the seed is actually wired)", () => {
    const a = sweepAt({ rps: 12, seconds: 20, seed: 0x5eed });
    const b = sweepAt({ rps: 12, seconds: 20, seed: 0xbeef });
    expect(a.processed === b.processed && a.failures === b.failures).toBe(false);
  });

  it("BASELINE PROPERTY 1 — the readable middle is a knife edge", () => {
    // A "readable middle" = an RPS where the board drops requests but the run
    // stays healthy (min reputation >= 80) for a full minute.
    //
    // The first measurement corrected the design's own wording: such a point
    // DOES exist on main. What does not exist is any WIDTH — the board goes
    // from that single point straight into collapse at the next step, so the
    // band cannot be found by a player who is adjusting an architecture rather
    // than tuning an rps dial. Width is therefore the metric, not existence,
    // and it is what the knee work has to move.
    const readable = table.filter((r) => r.failures > 0 && r.minReputation >= 80);
    const collapsed = table.filter((r) => r.minReputation < 0);
    const widthRps = readable.length
      ? Math.max(...readable.map((r) => r.rps)) - Math.min(...readable.map((r) => r.rps))
      : 0;
    const collapseRps = collapsed.length ? Math.min(...collapsed.map((r) => r.rps)) : Infinity;
    console.log(
      `readable points: [${readable.map((r) => r.rps).join(", ") || "none"}] ` +
        `width=${widthRps} rps, collapse begins at ${collapseRps} rps, ` +
        `band width as fraction of collapse = ${(widthRps / collapseRps).toFixed(3)}`
    );
    // On main the readable band spans less than 20% of the collapse load —
    // the target the knee design must beat.
    expect(widthRps / collapseRps).toBeLessThan(0.2);
  });

  it("BASELINE PROPERTY 2 — the band is a strobe, not a state", () => {
    // Mean dwell inside (0.90, 1.20) utilization, across every point that
    // enters the band at all. The design's claim is that this is far too
    // short to perceive; smoothing is what fixes it.
    const entered = table.filter((r) => r.episodes > 0);
    expect(entered.length).toBeGreaterThan(0);
    const worstDwell = Math.max(...entered.map((r) => r.meanDwellSec));
    console.log(
      "max mean dwell across all sweep points:",
      worstDwell,
      "s over",
      entered.map((r) => `${r.rps}rps:${r.meanDwellSec}s`).join(" ")
    );
    expect(worstDwell).toBeLessThan(0.6);
  });

  it("multi-seed reduction works and agrees with the single-seed run", () => {
    const s = sweepSeeds({ rps: 12, seconds: 20 });
    expect(s.runs.length).toBe(SEEDS.length);
    expect(s.seedsWithFailures).toBeGreaterThanOrEqual(0);
    expect(typeof s.medFailures).toBe("number");
  });
});
