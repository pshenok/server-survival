# The AI Wave — GPU inference archetypes + Chapter 5

**Date:** 2026-07-30 (rev 2 — after a 3-lens adversarial critique; 8 blockers integrated)
**Status:** approved (packaging + lean power confirmed by KP)
**Issue:** #87

## Why

AI inference is the cloud story of right now, nobody teaches its
infrastructure interactively, and the community asked (#87). Every mechanic
passes the Wave 1 bar: distinguishable behavior or it doesn't ship.

Critique summary (what rev 2 fixes): the batch/deadline mechanics cannot live
in the per-job handler registry (both nodes are tick-nodes); the economy was
off by 4–8× (reward retuned $2.50 → $0.50); the power gate was cheesable via
substation delete-refund; level 22's lesson was physically wrong (smoothing
starves batches); level 23's objective was uncheckable (per-reason counters
violate the #156 inertness contract); survival gating was a chicken-and-egg
deadlock.

## 1. INFERENCE traffic

`TRAFFIC_TYPES.INFERENCE`, color `0xd946ef`, destination `"gpu"`,
**reward $0.50**, score 15, not cacheable. STATE.failures gains
`INFERENCE: 0`; the save-load trafficDistribution fallback and the sandbox
mix panel gain the INFERENCE slider.

**Variable duration**: `req.genLength` at spawn — 70% short (0.6–1.0),
30% long (1.8–3.0), mean 1.28. Processing scales by it. No other traffic has
per-request duration variance.

**Survival staging (no deadlock, no dead GPU):**
- Before 300s game time: base INFERENCE share 0.
- After 300s: base share 3% — a legible slow bleed (−1 rep per unserved) that
  arms a smart hint ("AI demand is emerging — GPUs serve it").
- Once the player owns ≥1 GPU: base rebalances to 10% (taken proportionally
  from other shares), so the GPU has steady food between hypes.
- **"AI hype wave" shift** (INFERENCE → 25%, classic shares scaled
  proportionally; written out in CONFIG like existing shifts) enters the shift
  rotation only while a GPU exists, evaluated at shift-SELECTION time only —
  losing the last GPU mid-shift does not cancel it.

**Routing** (exact `isValidEdge` additions):
`alb|apigw|compute|serverless|container → infgw`; `infgw → gpu`;
`compute|serverless|container → gpu`; `power`: no edges (unwireable, like
monitor). `genericForward` becomes minimally type-aware: for INFERENCE it
prefers infgw then gpu targets; for everything else it EXCLUDES infgw/gpu from
candidates (they join dlq in the exclusion filter). The compute handler gets an
explicit INFERENCE branch: infgw first, direct gpu second, else NO_ROUTE.
A MALICIOUS request reaching gpu/infgw follows the existing failRequest breach
relabel — the attack got through, consistent with #156.

## 2. GPU Cluster (`gpu`)

**A tick-node** (like stream/dlq/scheduler): `processQueue()` skips type gpu,
no `SERVICE_HANDLERS` entry. `tickGpu(service, dt)` drains `service.queue`
into `service.batch` while accumulating (game-time window timer → freezes on
pause), then runs the whole batch as one job.

**a) Batching.** Accumulate to `batchSize` or `batchWindowSec` 1.5s from
first arrival; `batchTimeMs = (900 + 150·n) × meanGenLength(batch)`.
Full batch amortizes; a lonely request pays nearly full price.
`service.batch` depth is folded into `totalLoad`, into `deleteObject`'s
orphan set, and into `triggerRegionOutage`'s teardown — exactly as
`stream.partitions` already are in all three sites (leak-battery mandatory).

**b) Model cold start.** `service.modelLoading` — a DEDICATED flag; never
`isDisabled` (the event system re-enables disabled services — using it would
let a pause cancel a model load). `isRoutable` gains one line:
`modelLoading ⇒ false`. Load times 12s/20s/30s by tier; tier upgrade
re-triggers the load. **Held-arrival rule:** mid-air arrivals and entries
queued when a (re)load starts stay in `gpu.queue`, age untouched, and batch
normally when the load completes — the stall IS the lesson; holding satisfies
the termination invariant. The intake queue is BOUNDED at `maxQueueSize`
= batchSize (no big hidden buffer — that's infgw's job); overflow = existing
QUEUE_FULL path.

**c) Tiers = model size.** batchSize 8/12/16 (the economic half);
qualityRisk 10%/4%/1% (the flavor half — sold on the upgrade card with the
percentage printed).

**d) Quality.** The roll runs in tickGpu's completion loop only:
`finishRequest(req, "gpu", service)` as usual, then on a hit
`STATE.reputation += SCORE_POINTS.QUALITY_RISK_REPUTATION` (**−0.5**, new
constant) and `service.badAnswers++`. Legibility (a success-side event must
still be visible): an **amber "Bad answer" soft badge** over the GPU — a new
spawn call in the badge module, never through failRequest, preserving the
#156 inertness invariant — plus a `bad answers: N (risk 10%)` line in the GPU
tooltip next to batch fill.

**Economics.** Cost $300, upkeep $60/min, power draw 6 kW. At reward $0.50:
full-fill saturated profit ≈ +$29/min; **break-even ≈ 52% batch fill in the
saturated (pipelined) regime** — that regime is what the mandated
profit/min-at-fill harness measures (20%/60%/100% fill, curve documented in
the PR). Accepts INFERENCE only (`fail_gpu_only` at intake in the tick).
Providers: AWS P5/Inferentia · Azure ND · GCP A3/TPU.

## 3. Inference Gateway (`infgw`)

**A tick-node.** Cost **$70**, upkeep **$5/min** (below apigw — single-type
scope). Accepts INFERENCE only. Owns an array of `{req, enqueuedAt:
STATE.elapsedGameTime}`. `tickInfgw(service, dt)`:
1. **Sweep first**: every entry older than `deadlineSec` 6s is spliced out,
   then `failRequest(req, SLO_TIMEOUT)` — never `failOrPark` (an SLO breach is
   not recoverable work; explicit decision), never dispatch an expired entry
   (exactly-once).
2. Then dispatch heads to the least-loaded routable GPU
   (`gpu.queue + gpu.batch + gpu.incomingCount`). Warming/full fleet → entries
   stay, bounded by maxQueueSize (arrival overflow = QUEUE_FULL) plus expiry.

Expiry increments **`STATE.inference.expired`** (the resilience-counter
precedent) and `service.expiredCount`; `CampaignObjectives.expiredRequests(s)`
reads it. The #156 reason stays inert.
The array joins totalLoad / deleteObject / region-outage teardown.

**Why it exists** (the honest pitch, stated in its concept card): a
direct-wired GPU has only its tiny bounded intake — during warmup or overload
requests die fast; infgw holds up to 20 with deadline honesty and dispatches
where the batch has room. Its value is measured in reputation saved during
those windows, not revenue. Providers: vLLM router · Triton · Bedrock.

## 4. Power

`CONFIG.power = { baseCapKw: 8, gpuDrawKw: 6, substationKw: 6 }` —
substation +6 kW (so a 3-GPU fleet needs TWO substations: watts are a real
marginal decision, not one unlock). Substation: cost $150, upkeep $8/min, Ops
category, unwireable.

- **`recomputePower()`** — ONE function deriving `STATE.power = {usedKw,
  capKw}` from live services; called from createService, deleteObject,
  restoreServices, loadGameState, AND the campaign prebuild loop (which
  constructs via `new Service` directly — a call-site-driven recompute would
  go stale there).
- Placement gate: allowed when `usedKw + gpuDrawKw <= capKw` — **boundary
  inclusive** (level 24's target sits exactly on it; one test pins this).
- **Deletion gate (anti-cheese):** deleteObject REFUSES to remove a substation
  when the reduced cap would strand powered GPUs ("unplug GPUs first",
  i18n'd) — otherwise buy-place-refund runs 18 kW on an 8 kW cap forever and
  level 24 is beaten by the exploit. GPU deletion stays free.
- HUD `kW used/cap` badge only when a gpu or power node exists.
- **Share links:** `encodeArch` sorts services power-first and **remaps every
  index in `c` and `i` through the permutation** (positions `p` reordered in
  lockstep) — the current serializer emits placement order, so this is a real
  transform, not a comment. Share test: a power+gpu build round-trips to an
  identical service set.
- Region outages: substations unwireable → never in a region subtree.

## 5. Chapter 5 — "The AI Wave" (levels 21–25)

Levels 1–20 byte-identical. Every level proven beatable AND proven to fail on
its named ignore-run. Numbers below are tuning TARGETS — the beatability
harness is the authority and the shipped comments document final arithmetic
(the Chapter 4 convention).

| # | Title | Teaches | Knobs (target) | Ignore-runs (must lose) |
|---|---|---|---|---|
| 21 | Hello, GPU | cold start + model quality | budget 480, rps 3.0, INF 60/READ 25/WR 10/MAL 5, prebuilt waf→alb→compute→db, allowed [gpu]. Two acts: serve on tier 1; announced surge at 45s that tier 1's bad-answer bleed can't hold — upgrade in the LULL (re-load done before the surge) wins; upgrading DURING the surge = self-inflicted outage | (a) no GPU → serve-N unreachable; (b) upgrade mid-surge → rep collapse |
| 22 | Batch or Bleed | utilization economics — right-size the fleet | budget 750 (the 2nd-GPU trap is affordable), rps 3.5, INF 70%, allowed [gpu, infgw]; profit objective tuned so ONE near-full GPU clears it and TWO half-fed GPUs miss by ~$390 (least-loaded dispatch halves fill) | add a 2nd GPU → profit target missed |
| 23 | The Deadline | SLO / queue time | prebuilt front door + infgw + 1 gpu + 1 substation (defuses the power lesson early), bursty INF ~5 rps, allowed [gpu]; primary: serve M AND `failureRate < 0.12` AND `expiredRequests < X` — the failure-rate leg kills the delete-the-gateway cheese (trading expiries for NO_ROUTEs still fails) | (a) do nothing → expiries breach X; (b) delete infgw + direct-wire → failureRate breaches |
| 24 | The Power Wall | the cap is the constraint | budget 1400 (money plentiful), INF ~6.5 rps (above the tier-3 single-GPU ceiling ~3.8/s), allowed [gpu, power, infgw]; need 3 GPUs = 18 kW = base 8 + TWO substations; timeout sized for tier-3 30s cold starts | no substation → capped at 1 GPU → serve target unreachable |
| 25 | The AI Wave | capstone | budget 900, rps 10, forced base INF 12% + enableSurvivalShifts (hype escalation; ownership gate applies — the base share does the teaching, the wave escalates), allowed all; objectives: survive 120s, rep ≥ 55, netProfit ≥ 0; bonus: badAnswers < 20 (a tier-1-only fleet provably can't hold rep) | no GPU at all → the 12% base bleeds rep to a provable loss |

## 6. Cross-cutting

- **Cardinal invariant**: batch terminates with its batch or its node; expired
  entries exactly once (never dispatched after expiry; the 500ms fail-fade
  overlap is covered by splice-before-fail); held arrivals during model load
  terminate post-load; teardown sites (deleteObject / region outage / clear)
  drain `batch`, `infgw` array, and bounded queues. Leak battery: mid-batch
  demolish, region outage over a busy GPU, expiry storm, all-GPU-warming,
  share-rebuild of a power+gpu build.
- **Badges**: `fail_slo_timeout` ("Deadline exceeded"), `fail_gpu_only`
  ("GPUs serve inference only") + the amber success-side "Bad answer" soft
  badge (new spawn path, #156 contract intact).
- **Metrics**: gpu/infgw are normal rows; batch fill, model-load state and
  badAnswers in tooltips. GPUs do NOT auto-scale in v1 (future: queue-pressure
  hook, noted in #220's pattern).
- **Toolbar**: gpu, infgw → Compute tab (3→5); power → Ops (1→2).
- **i18n ×9**; concept cards ×3 with provider mappings.
- **Constraints**: no build step; native ESM; no new deps; levels 1–20 and all
  existing behavior byte-identical unless listed here.
