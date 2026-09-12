# A/B architecture laboratory

Open **Sandbox → A/B laboratory**. Save the current board as A, return to
building, change the architecture, then save B. Alternatively, use **Try the
queue experiment** to populate both slots without modifying the board.

Write a hypothesis, choose a workload and run the comparison. The laboratory
pauses the board. Closing or cancelling leaves that board in place and paused.
Snapshots (including tiers, autoscaling flags and ready fleet sizes), the last
valid workload and the hypothesis persist in this browser. Reports can be
exported as JSON; the numerical comparison is also available as CSV. English
and Russian UI copy ship initially; other game locales use English in the lab.

## First laboratory exercise: can a queue save burst traffic?

1. Use the queue example: A is Firewall → Load Balancer → Compute → SQL DB;
   B inserts a Message Queue between the balancer and Compute.
2. Start with 5 requests/s, 100% READ, 60 seconds, bursts and seed 42.
3. Predict what will happen to failures, p95 latency and costs.
4. Run both boards. Account for every legitimate arrival: timely + late +
   failed + throttled + DLQ-recovered + pending must equal arrivals.
5. Change only the arrival pattern to steady. Both profiles send the same
   number and types of requests. Does your conclusion survive?
6. Repeat with another seed and explain which conclusion is robust and which
   depends on the workload. Export the report with your hypothesis.

The lab deliberately does not declare a winner. Less loss can come with more
latency or expense. An empty/disconnected architecture is a valid control.

## Model and reproducibility contract (version 1)

- Uses the game's **real Service and Request handlers**, not a second analytical
  approximation. Simulation advances at a fixed 1/60 game-second timestep,
  independently of display refresh and wall-clock speed.
- Each run lives in a fresh, hidden, same-origin iframe. Cancellation removes
  that world. The parent board, campaign and save-state are not replaced.
- Workload seed fixes a precomputed list of arrival times, traffic types and
  AI generation lengths. Service decisions use a separate seeded PRNG, so a
  topology change cannot change external demand. Equal architecture, workload,
  model version and game rules reproduce the same result. Different boards
  may consume different numbers of internal random draws; this is not a claim
  that every corresponding cache/failure decision is paired across boards.
- Steady arrivals are evenly spaced. Bursts compress each five-second interval
  into its first second, then leave four seconds quiet. Both profiles use
  `floor(duration × rps)` requests and identical request attributes.
- Duration is 30, 60 or 120 seconds; average RPS is 0.5–50. Traffic weights are
  normalized. No random incidents, survival escalation or degradation.
- Fresh healthy nodes, empty queues, saved tiers and ready fleet sizes.
  In-progress warmups, cached history, health damage and existing requests
  are not copied. GPUs cold-load the saved model tier.
- Upkeep is enabled; auto-repair is disabled. Both boards run for the load
  duration **plus 30 seconds**, even if one empties its queues sooner. The
  Scheduler continues generating its own jobs during this horizon.
- Failure/throttle display animations retire immediately in the runner.
  They do not keep failed requests moving on wall-clock timers. Sounds,
  failure sprites, menu initialization and achievement polling are suppressed.

## Reading the measurements

Response statistics refer to external legitimate arrivals. Scheduler-created
jobs and fan-out copies consume capacity and money but do not inflate this
population. This first version measures the original delivery of a fan-out
request, **not** atomic success of all its subscribers. Attacks are counted
separately. A blocked attack is not a failed legitimate request.

SLOs use the game's traffic-class deadlines. Inference expiration is enforced
by the Inference Gateway when present; a direct GPU path does not gain a new
global deadline from the lab. The report exports the relevant assumptions.

Latency p50/p95/p99 are nearest-rank percentiles of **completed** legitimate
responses in game seconds. Always read them together with failures and pending
work: a system dropping slow requests may have deceptively low latency.
Pending work at the end of the extra 30 seconds is not counted as success.
DLQ recovery is reported separately and is not a timely response.

Queued work sums node queues, Stream partitions and parked DLQ records; it
excludes in-flight requests, running jobs and GPU batches already admitted to
the batch engine. Peak is observed each simulation tick. The chart samples at
one-second intervals and can therefore miss a brief peak shown in the table.

Cost is expressed in **game dollars**, not a cloud-provider quote. Architecture
purchase includes base services and all purchased tier upgrades. Operating
cost includes upkeep, invocation charges, mitigation, breaches, repairs and
DLQ recovery charges. Total cost per 1,000 timely responses includes purchase
and operating costs and is undefined if none finished in time. Request revenue
is not subtracted from these cost figures.

## Implementation and extensions

`src/lab/scenario.js` owns validated snapshots, seeded workloads and accounting.
`engine.js` drives the existing simulation. `context.js` supplies optional RNG
and outcome observation hooks; ordinary gameplay keeps native randomness.
`transport.js` and `frame.js` manage isolated, cancellable runs. `ui.js` owns
snapshots, controls and exports. There is no new dependency or build step.

Bump `LAB_MODEL_VERSION` when the experiment's scheduling, accounting or
initialization contract changes. Changes to underlying game rules also affect
results; retain the source revision with an archived teaching deployment.
Exported reports contain inputs and results, not a frozen copy of the engine.

Useful next extensions: report import/replay, multiple seeds with uncertainty
intervals, controlled incident schedules, per-service attribution, and explicit
completion rules for multi-subscriber workflows.
