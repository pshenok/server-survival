# The Failure Knee — design

**Date:** 2026-08-05 (**rev 2**, rewritten after the pre-implementation critique)
**Status:** approved direction (addresses #74 "getting bored in 10 minutes" at the root)
**Scope:** survival-gated simulation change. Shipped campaign levels must stay
identical in SIMULATION STATE; this is a hard constraint, not an aspiration.

> **Rev 1 is superseded.** A four-lens adversarial critique killed its central
> mechanic with measurements before a line was written. Rev 1's errors are kept
> below under "What rev 1 got wrong" because each one is a trap worth
> remembering, and one of them (the gate/switch ambiguity) would have silently
> broken 16 shipped levels.

## The problem

#74 is the loudest retention complaint in the tracker and its comments all say
the same thing: *"nothing to do"*, *"I leave it for 2 hours and it still
worked"*. The cause is not a content shortage. The board gives the player **no
readable middle** between "fine" and "dead": on a reference board, 10 RPS
produces zero failures and 20 RPS produces 467 failures with reputation −327.

## The root cause — the axis, not the curve

Three findings, all verified in code and by measurement:

**1. `totalLoad` is not utilization.** `Service.js:821` divides by
`capacity × instances × 2`, so a node at 100 % of rated capacity reads **0.5**
and the scale runs past 1.0 (measured to 3.0).

**2. Every warning is calibrated to the wrong half of that scale.** The ring
turns orange (`Service.js:756`) exactly when the node starts dropping requests,
and red only at 160 % of capacity. The $75 Monitoring node alerts at 170 %
(`metrics.js:25`) — long past the point where the information is actionable.

**3. The decisive one: the instantaneous signal is a strobe.** `totalLoad`'s
numerator is an integer job count, so for a tier-1 Compute (capacity 4) the
signal can only take the values 0.75, 1.00, 1.25 — the entire interesting band
holds **one** representable state. Measured dwell of instantaneous utilization
inside (0.90, 1.20):

| rps | 6 | 8 | 10 | 11 | 12 | 13 | 15 | 20 |
|---|---|---|---|---|---|---|---|---|
| episodes / 60 s | 6 | 21 | 81 | 91 | 122 | 58 | 26 | 19 |
| mean dwell (s) | 0.27 | 0.11 | 0.15 | 0.12 | 0.12 | 0.12 | 0.08 | 0.10 |

**Mean dwell never exceeds 0.27 s at any load.** No curve placed on this axis
can produce a readable middle, because the state it describes does not persist
long enough to perceive. Smoothing the axis (EWMA, τ = 2.5 s) turns the same
runs into 1.26–2.44 s of residency — a state, not a flash.

## The design

### 1. `smoothedLoad` — a new EWMA on every service, both modes

In `Service.update(dt)`, before the processing loop:

```js
const alpha = Math.min(1, dt / CONFIG.load.smoothingTau); // tau = 2.5 s GAME time
this.smoothedLoad += (this.totalLoad - this.smoothedLoad) * alpha;
```

Initialised to 0 in the constructor and on every reset path. `dt` is already
game-scaled, so this is fast-forward-consistent and needs no wall clock. O(1),
no allocation. **`totalLoad` itself is untouched** — campaign objectives, hints,
ASG's campaign path and `handlers/compute.js:61`'s cache-bypass rule keep
reading exactly what they read today.

### 2. The knee — toe height 0.20

```js
// CONFIG.load
smoothingTau: 2.5, failureOnsetUtil: 0.90, toeTopUtil: 1.20, toeHeight: 0.20,
```

```js
function kneeFailChance(u) {           // u = smoothedLoad * 2 (rated-capacity util)
  if (u <= 0.90) return 0;
  if (u <  1.20) return 0.20 * ((u - 0.90) / 0.30) ** 2;
  return Math.min(1, 0.20 + 0.80 * (u - 1.20) / 0.80);
}
```

**0.20 is derived twice, and the two derivations agree:**

*(a) Reputation.* `SUCCESS_REPUTATION: 0.1`, `FAIL_REPUTATION: -1`
(`config.js:740-741`) put break-even at `0.1/1.1 = 0.0909`. We want util 1.10 —
mid-band — to sit at break-even: `0.20 × (2/3)² = 0.0889`. ✓

*(b) Continuity.* With toe 0.20 the linear branch reduces to `u − 1.00`, which
is **algebraically identical to the shipped curve** `2 × (load − 0.5)`. Above
util 1.20 nothing changes at all, so every shipped constant derived against the
old curve — `tripErrorRate` (`config.js:698-707`), `queuePressureThreshold`
(`config.js:679-684`) — stays valid by inspection.

| util | 0.95 | 1.00 | 1.05 | 1.10 | 1.15 | 1.20 | ≥1.20 |
|---|---|---|---|---|---|---|---|
| shipped | 0 | 0 | 0.050 | 0.100 | 0.150 | 0.200 | u−1 |
| amended | 0.006 | 0.022 | 0.050 | 0.089 | 0.139 | 0.200 | u−1 |

Maximum perturbation ±2.2 pp. **The curve barely moves; the axis does the
work.** Resulting runway at one saturated bottleneck: at util 1.00, 2.2 % of
requests fail and reputation still *rises* — ~16 visible failures a minute that
the player can read and fix. At util 1.20 they have 69 s before reputation
hits 0.

### 3. Curve selection is a SWITCH, never a gate

```js
const useKnee = STATE.gameMode === "survival" && !KNEE_EXEMPT_TYPES.has(this.type);
const failChance = useKnee
  ? kneeFailChance(this.smoothedLoad * 2)
  : calculateFailChanceBasedOnLoad(this.totalLoad);
```

This is the difference between a fix and a catastrophe. `calculateFailChanceBasedOnLoad`
has one call site (`Service.js:678`) and is **not** mode-gated today. A headless
sweep of all 25 levels found **16 that drive a node past `totalLoad` 0.50**
(ids 3,4,5,6,7,8,9,11,12,13,15,16,17,20,23,24), peaking at 1.5. Level 15's
design says so outright (`levels.js:508-514`): its pre-built Tier-1 Compute
*"sits ~10 % over its own throughput… enough to bury it inside ~30 s"*. Gating
the roll instead of switching the curve would make that level unlosable.

### 4. Queue-fed types are exempt — and the exemption is the protection

```js
const KNEE_EXEMPT_TYPES = new Set(["sqs", "dlq", "stream", "gpu", "infgw"]);
```

Their `totalLoad` numerator is **backlog** (`queue`, `partitions`, `batch`,
`pending` — `Service.js:814-818`), not concurrency; a full buffer is their
designed-good state, and each already owns an overload mechanic. This also
protects `queuePressureThreshold: 0.2`, whose derivation is about a saturated
SQS. Without the exemption, an SQS holding its rated depth would lose ~91 % of
held messages per second, because a parked job re-rolls the failure dice every
frame (`Service.js:723-728` re-inserts with `job.timer` intact). That re-roll
is a real latent defect — filed separately, out of scope here.

### 5. Sandbox keeps the LEGACY curve

The switch reads `=== "survival"`. Sandbox is the stakes-free build mode with no
reputation and no ramp, so the knee's purpose does not apply — and the
642-test sim suite (which defaults to `gameMode: "sandbox"`,
`tests/helpers/sim-world.mjs:16`) is sandbox's de-facto specification.
Re-baselining nine test files to buy a nicety in a mode with no stakes is a bad
trade. Sandbox already differs from survival in six places
(`Service.js:539`, `actions.js:31`, `hints.js:10`, `economy.js:338`,
`events.js:319`, `game.js:996`).

### 6. Rings and the Monitoring alert move to `smoothedLoad` — in BOTH modes

| signal | now | amended | = % of capacity |
|---|---|---|---|
| ring yellow | `totalLoad > 0.2` | `smoothedLoad ≥ 0.25` | 50 % |
| ring orange | `totalLoad > 0.5` | `smoothedLoad ≥ 0.35` | 70 % |
| ring red | `totalLoad > 0.8` | `smoothedLoad ≥ 0.45` | **90 % = first drop** |
| alert | `> 0.85`, 6 samples | `> 0.375`, **2 samples** | 85 % |

Both modes, deliberately: **"identical" means simulation state, and rings and
alert banners are not simulation state.** `this.loadRing` is written only at
`Service.js:749-777` and read nowhere in `src/`, `game.js` or `tests/`;
`fireAlert` → `addInterventionWarning` is pure DOM + sound. Campaign players
today see orange while dropping requests — that is a bug in both modes, and
splitting the colour language between the tutorial and the mode it teaches
would be worse than fixing it once. Sustain drops 6→2 because the signal is
already a 2.5 s trailing mean.

Ordering invariant, asserted as one unit test:
`alert(0.375) < ring-red(0.45) = failureOnset(0.45)`.

### 7. ASG reads `smoothedLoad` with survival thresholds

`autoscaling.js:167` currently compares `totalLoad` against `targetUtil: 0.7` —
scale-out at **140 %** of capacity, entirely outside the readable band. The
band would be visible and un-actionable by the very mechanic sold for it.

```js
survivalTargetUtil: 0.375,  // util 0.75 — ~5 s of lead before onset
survivalScaleInUtil: 0.20,  // util 0.40 — hysteresis gap preserved
```

Campaign keeps 0.7/0.3 exactly. This also kills a pre-existing 1↔2 instance
flap measured at 5 rps.

### 8. Continuous ramp interpolation — a co-requisite, not a nicety

`rpsAcceleration.milestones` are step functions (`game.js:161-181`): at t=180 s
the multiplier jumps 1.6→2.0, taking target RPS from 12.01 to 15.01 in one
frame. The measured readable band is ~10.5–13 rps — **a 25 % step jumps clean
over the band we are building**, at exactly the 3-minute mark #74 complains
about. Interpolate linearly between milestones, keep firing
`rps_surge_warning` at the original times. ~6 lines, already survival-gated.

### 9. One `CONFIG.load` block

`smoothingTau`, `failureOnsetUtil`, `toeTopUtil`, `toeHeight`,
`ringYellow/Orange/Red`, `alertUtil`, `alertSustainSamples` — with the ordering
invariant asserted in a test rather than left as a comment.

## What rev 1 got wrong (kept deliberately)

1. **Congestion latency was an unstable positive-feedback loop.** Multiplying
   `processingTime` lengthens time-in-processing, which is exactly what
   `totalLoad` measures, which raises the multiplier. Measured at k=3 on a
   board that was fine at 8 rps: 463 completed / 0 failures → **53 completed /
   416 failures**. The stability ceiling is k ≈ 0.25–0.4. Worse, its payoff was
   imaginary: `recordServiceSuccess` is called only from `finishRequest`
   (`actions.js:245`), so a congested WAF/ALB/Compute never records a latency
   sample at all — "latency sparklines climb" was unimplementable. **Cut
   entirely, in every capped form.**
2. **Toe 0.35 was a difficulty increase sold as a softening** (+15 pp at util
   1.20 and harsher everywhere to util 2.0).
3. **The reputation premise was wrong**: rev 1 assumed +0.5 per success; it is
   +0.1 (`config.js:740`). The `|| 0.5` at `actions.js:219` is dead code.
4. **"Three changes behind a survival gate" was fatally ambiguous** — see §3.
5. **"Sandbox keeps survival's behaviour" collided with the harness default**
   and could not coexist with "the suite stays green".
6. Citation drift: `game.js:959`→996, `Service.js:820`→821; the objective ids
   live in `levels.js:216`/`:250`, not `objectives.js`.

## Implementation order

Each step lands as its own PR with its own verification.

- **Step 0 — the harness, no product code.** `tests/helpers/reference-board.mjs`:
  exact board, mix, seeded PRNG, sweep runner reporting failures / min-reputation
  / band residency / mean dwell / time-to-rep-0, plus an 8-seed baseline table
  for `main`. *Without this nothing downstream is falsifiable* — five people
  built five different "reference boards" during the critique and got five
  different cliffs (10–20 rps).
- **Step 1 — ramp interpolation.** Assert target RPS is continuous; surge
  warnings still fire at the original times; band residency rises ≥5× from
  baseline.
- **Step 2 — `smoothedLoad`.** Pure addition, read by nothing: the suite must
  stay green with **zero** changed assertions. Plus a `timeScale = 2` tracking
  test and a reset-to-zero test.
- **Step 3 — rings + alert.** Ordering-invariant test; all 25 beatability
  proofs green unchanged; `tests/sim/metrics.test.mjs:206-245` re-baselined (a
  known, budgeted cost); alert fires **before** the first failure on a rising
  ramp; red-ring shape: ≤3 episodes/min and mean episode ≥1 s at the highest
  zero-failure RPS.
- **Step 4 — the knee switch + exemptions.** The only step that changes
  simulation. Campaign switch test **in both directions** (knee inert in
  campaign AND the old curve still fires there — inertness alone passes on a
  broken gate); all 25 beatability proofs; leak battery at 20 rps/120 s;
  exemption test (SQS at util 1.00 for 60 s loses zero messages); breaker test
  (zero trips at target band); `kneeFailChance(u) === calculateFailChanceBasedOnLoad(u/2)`
  for all `u ≥ 1.2`; band-width ≥ 20 % of collapse RPS over 8 seeds; ≥60 s
  runway from first drop to reputation 50.
- **Step 5 — ASG onto `smoothedLoad`.** Scale-out begins before util 0.90;
  ≤1 scaling action per 20 s at steady 5 rps.

## Step 4 was BUILT, MEASURED, and NOT SHIPPED — and why that matters

The knee itself was implemented exactly as designed above (switch not gate,
queue-fed exemptions, toe 0.20 with the shipped-curve identity above util
1.20, all of it) and then measured against the step-0 baseline. It does not
achieve its goal, and the reason turned out to be more valuable than the
feature.

**Measured, reference board, 60 s per point:**

| | main | knee (onset 0.90) | knee (onset 1.00) | knee (onset 1.25) |
|---|---|---|---|---|
| readable points | 5, 6 | 5 | 5 | 6 |
| **band width / collapse** | **12.5 %** | **0 %** | **0 %** | **0 %** |
| 6 rps | 7 fail, rep 95 | 36 fail, rep 74 | 29 fail, rep 75 | 3 fail, rep 98 |
| time-to-death, 8-seed median | 110.9 s | — | 113.9 s | — |

The anti-softening gate passes comfortably (+1.3 %, well inside ±20 %). The
band target does not move at any calibration. Two things were learned:

**1. A hidden capacity-dependent bias in the shipped curve.** `failChance` is
computed AFTER `this.processing.splice(i, 1)` (`Service.js`), so the
instantaneous load the old curve reads is short by exactly one job at the
moment of the roll. On a capacity-4 Compute that is **0.25 of utilization**;
on a capacity-10 node it is 0.10. The shipped threshold is therefore not
"100 % of capacity" at all — it is 100 % plus a bias that shrinks as nodes get
bigger. Any curve reading a smoothed axis has no such bias, which is why the
knee looked harsher than a curve it is mathematically never above. This is a
real latent inconsistency, worth its own issue.

**2. The band target is unreachable by construction, and no failure curve can
change that.** Compute, DB, ALB and WAF have **no `maxQueueSize`** — their
queues are unbounded (only sqs/stream/gpu/infgw are capped). An unbounded
queue has no stationary overload state: while arrivals ≤ service rate the
queue stays finite and failures are ~0; the instant arrivals exceed it the
queue grows without limit, utilization runs away, and failures go to 100 %.
The system is bistable in arrival rate. "A band of arrival rates where the
board fails a little and survives" describes a steady state the simulation
cannot have — which is why the same 0 % width appears at every onset from
0.90 to 1.25, and at capacity 4 and capacity 10 alike.

**What this points at instead.** Real systems get a readable middle from
**bounded queues and load shedding**: past the backlog limit the excess is
dropped, utilization pins near 1.0, and the system runs indefinitely at a
loss rate proportional to the overshoot. That is a genuine stationary state,
it is the mechanic the game already models correctly in SQS
(`maxQueueSize: 200`), and it teaches a real lesson — backpressure and shed
load — instead of a tuned probability. A `maxQueueSize` on the compute-family
nodes is the change that would make the band exist; the failure curve was
never the lever.

Step 4 is therefore parked, not merged. Steps 0-3 stand on their own: they
are the measurement rig, a continuous ramp, a readable signal, and warnings
that fire before the failures rather than 70 % after them.

## The biggest surviving risk

**The amendment may make the game too easy — #74 from the other side.** Every
mechanism here moves the same way: the EWMA grants 2.5 s of grace, the curve
above util 1.20 is unchanged so nothing offsets it, and ramp interpolation
removes the step jumps that currently end runs at t=180. Measured board-wide
failure pressure roughly **halves** at 11–20 rps.

That is the intent *inside* the band and a regression *outside* it. So it is
gated, not hoped about: **time-to-death on the standard survival ramp, fixed
board, 8 seeds, must land within ±20 % of `main`'s.** Measured at step 4, before
step 5, as a stop-the-line gate. If runs get materially longer, the fix is to
steepen the ramp's log term (`game.js:156-157`) — never to raise the toe, which
would re-import the difficulty-increase-in-disguise this design just removed.
