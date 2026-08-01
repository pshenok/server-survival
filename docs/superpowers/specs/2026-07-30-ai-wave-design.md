# The AI Wave — GPU inference archetypes + Chapter 5

**Date:** 2026-07-30
**Status:** approved (packaging + lean power confirmed by KP; detail sections below)
**Issue:** #87 (community ask: GPU/NPU cluster + electricity management)

## Why

AI inference is the cloud story of right now, nobody teaches its infrastructure
interactively, and the community asked for exactly this (#87). Every mechanic
below passes the Wave 1 bar: distinguishable simulation behavior, or it doesn't
ship.

Packaging: archetypes into the existing modes + a teaching chapter — the proven
Wave 1 pattern. Electricity ships in its lean form: a power cap that exists
only once GPUs enter the picture.

## 1. INFERENCE traffic

New `TRAFFIC_TYPES.INFERENCE`, color `0xd946ef` (fuchsia — unused), destination
`"gpu"`, reward `$2.50`, score 15, not cacheable.

**Variable duration** — the new behavior: each INFERENCE request gets
`genLength` at spawn (generation length multiplier): 70% short (0.6–1.0), 30%
long (1.8–3.0). Processing time scales by it. No existing traffic type has
per-request duration variance.

- Sandbox: INFERENCE slider in the traffic mix.
- Survival: new traffic shift **"AI hype wave"** (INFERENCE jumps to ~25%) —
  enters the shift rotation **only when the player owns ≥1 GPU** (otherwise the
  shift is a death sentence with no counter); a smart hint suggests GPUs when
  INFERENCE share > 0 and none exist.
- Routing: front door as usual; compute-tier nodes and gateways forward
  INFERENCE toward `infgw`/`gpu` (preference: infgw first, direct gpu second,
  else NO_ROUTE).

## 2. GPU Cluster (`gpu`) — the star

Three distinguishable behaviors in one node:

**a) Batching.** The GPU does not process requests one by one. It accumulates
up to `batchSize`, or waits `batchWindowSec` (1.5s) since the first arrival,
then runs the whole batch as ONE processing job:
`batchTimeMs = 900 + 150·n`, scaled by the mean `genLength` of the batch.
A full batch amortizes beautifully; a lonely request pays almost the full
price. The only node whose per-request latency and unit cost depend on how
full the batch is.

**b) Model cold start.** On placement the GPU loads its model:
`modelLoadSec` = 12s (tier 1) / 20s (tier 2) / 30s (tier 3) of game time.
While loading: accepts nothing (not routable as a dispatch target), draws full
power, shows a progress ring. **A tier upgrade swaps to a bigger model and
re-triggers the load** — upgrading mid-spike is the classic self-inflicted
outage, now teachable.

**c) Model quality (tiers = model size).**
- Tier 1 (small): batchSize 8, qualityRisk 10% — a completed INFERENCE has a
  10% chance to still ding reputation slightly ("bad answer").
- Tier 2 (medium): batchSize 12, qualityRisk 4%.
- Tier 3 (large): batchSize 16, qualityRisk 1%.
Small models are fast, cheap, and embarrassing; big models are slow to boot and
expensive but trustworthy.

**Economics (brutal, by design):** cost $300, upkeep $60/min. An idle GPU
bleeds; a well-batched one prints. Tuning target: break-even at roughly half
batch utilization; the implementation must produce a measured profit/min curve
at ~20% / 60% / 100% fill and document the break-even.

Accepts INFERENCE only (anything else → `fail_gpu_only`). Power draw 6 kW.
Providers: AWS P5/Inferentia · Azure ND · GCP A3/TPU.

## 3. Inference Gateway (`infgw`) — the deadline queue

Cost $90, upkeep $10/min. Accepts INFERENCE only. Holds a queue where every
entry carries its enqueue game-time; an entry older than `deadlineSec` (6s)
**expires**: `failRequest` with new reason `fail_slo_timeout` ("Deadline
exceeded"). Dispatches to the connected routable GPU with the fewest pending
items (least-loaded, not round-robin). Holds while every GPU is warming or
full; expiry keeps the hold honest.

Queue overflow exists in the sim; **time-based expiry does not** — that is the
distinguishable behavior, and the core inference-serving lesson: you measure an
inference queue in milliseconds of waiting, not items.

Deadlines tick on game time → freeze on pause (the #183 discipline).
Providers: vLLM router · NVIDIA Triton · Bedrock endpoints.

## 4. Power (`power` substation + the cap)

`CONFIG.power = { baseCapKw: 8, gpuDrawKw: 6, substationKw: 10 }`.
Substation: cost $150, upkeep $8/min, Ops category, unwireable (like Monitor),
adds +10 kW to the datacenter cap.

- `STATE.power = { usedKw, capKw }` — **derived**: recomputed from live
  services on place/delete/restore/load (never persisted arithmetic).
- Placement gate: placing a GPU that would exceed the cap is refused with an
  i18n'd warning — the "insufficient funds" UX pattern, but for watts.
- HUD: a small `kW 12/18` badge near the money display, rendered **only when**
  a GPU or substation exists. The rest of the game never sees it.
- Share links: the serializer orders `power` nodes before `gpu` nodes so a
  rebuilt link passes its own placement gate.
- Region outages: substations are unwireable → never inside a region subtree →
  unaffected (noted as future work: killing a substation is a great chaos
  event once there's a UI story for unpowered GPUs).

Lesson: in 2026, GPUs are constrained by the socket and the cooling, not the
wallet.

## 5. Chapter 5 — "The AI Wave" (levels 21–25)

Each level proven beatable AND proven to fail when its mechanic is ignored
(the #218 discipline). Levels 1–20 byte-identical.

| # | Title | Teaches | Sketch |
|---|---|---|---|
| 21 | Hello, GPU | cold start + basic serving | first GPU, survive the model load, serve N INFERENCE |
| 22 | Batch or Bleed | utilization economics | bursty inference; profit target impossible with half-empty batches — smooth the flow, feed the batch |
| 23 | The Deadline | SLO / queue-time | infgw prebuilt, demand above one GPU; keep `fail_slo_timeout` under X while serving M |
| 24 | The Power Wall | the power cap | money plentiful, watts scarce: target needs 3 GPUs, cap allows 1 — substation economics |
| 25 | The AI Wave | capstone | classic + INFERENCE hype surges together; survive and profit |

## 6. Cross-cutting

- **Cardinal invariant**: every batched request terminates when its batch
  completes or its node dies; expired entries fail exactly once; a
  warming/unpowered GPU never strands a request (infgw holds or expires;
  direct-wired requests fail NO_ROUTE when the GPU is not routable). Leak
  battery mandatory (batch mid-flight teardown, expiry storm, all-GPU-warming,
  power-refused placement).
- **Failure badges**: `fail_slo_timeout`, `fail_gpu_only` join the taxonomy;
  existing aggregation handles the rest.
- **Metrics (#194)**: GPUs appear as normal rows; batch fill and model-load
  state in the node tooltip; the ASG "×n" pattern is reused for nothing here
  (GPUs don't auto-scale in v1 — noted as future work with queue-pressure).
- **Toolbar**: `gpu`, `infgw` → Compute tab (3→5); `power` → Ops (1→2).
- **i18n**: every string ×9 locales. Concept cards for all three services with
  provider mappings.
- **Tests**: batching fill/window/economics; cold start incl. tier reload;
  quality-risk tiers; deadline expiry + pause freeze; power gate
  (refuse/raise/delete-recompute/save-load/share order); routing + leak
  battery; survival shift gating; level invariants ride automatically;
  beatability harness for 21–25.
- **Constraints**: no build step; native ESM; no new deps; levels 1–20 and all
  existing behavior byte-identical unless listed here.
