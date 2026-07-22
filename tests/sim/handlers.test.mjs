// Per-service handler behavior over the REAL sim (#155 PR 10, tier 2):
// the replica read/write split (#190), SQS pull-model + backpressure, and
// deterministic cache hit/miss (Math.random pinned AFTER world building so
// service-id generation stays unique).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry } from "../../src/core/actions.js";
import { STATE, CONFIG, resetWorld, place, connect, run, step } from "../helpers/sim-world.mjs";

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

function inject(type) {
  const req = new Request(type);
  STATE.requests.push(req);
  routeRequestToEntry(req, type);
  return req;
}

describe("read replica (#190)", () => {
  function replicaWorld() {
    const alb = place("alb");
    const compute = place("compute");
    const replica = place("replica");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, replica);
    connect(replica, db);
    return { alb, compute, replica, db };
  }

  it("READ traffic completes via the replica", () => {
    replicaWorld();
    inject("READ");
    run(10);
    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.failures.READ).toBe(0);
  });

  it("WRITE traffic fails at compute when only a replica is wired (no db/nosql on compute)", () => {
    replicaWorld();
    inject("WRITE");
    run(10);
    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.WRITE).toBe(1);
  });

  it("a replica with no master db/nosql fails even READ traffic", () => {
    const alb = place("alb");
    const compute = place("compute");
    const replica = place("replica");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, replica); // replica -> db missing
    inject("READ");
    run(10);
    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.READ).toBe(1);
  });

  it("campaign hook attributes replica completions to completedByService.replica", () => {
    replicaWorld();
    STATE.campaign.completedByType = { STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0 };
    STATE.campaign.completedByService = {};
    globalThis.window.campaign.active = true;
    STATE.campaign.active = true;

    inject("READ");
    run(10);

    expect(STATE.campaign.completedByType.READ).toBe(1);
    expect(STATE.campaign.completedByService.replica).toBe(1);
  });
});

describe("SQS pull model", () => {
  it("compute PULLS from an upstream queue (sqs never pushes to compute)", () => {
    const sqs = place("sqs");
    const compute = place("compute");
    const db = place("db");
    connect(sqs, compute);
    connect(compute, db);

    const req = new Request("WRITE");
    STATE.requests.push(req);
    req.flyTo(sqs);
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.failures.WRITE).toBe(0);
  });

  it("with no downstream at all the job waits in sqs processing (requeue-next)", () => {
    const sqs = place("sqs");
    const req = new Request("WRITE");
    STATE.requests.push(req);
    req.flyTo(sqs);
    run(2);

    // Not failed, not finished — parked in the queue's processing list.
    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.WRITE).toBe(0);
    expect(sqs.processing.length).toBe(1);
  });

  it("backpressure: a saturated downstream ALB requeues the job (requeue-stop) until it drains", () => {
    const sqs = place("sqs");
    const alb = place("alb");
    connect(sqs, alb);

    // Saturate the ALB's queue (maxQueueSize default 20).
    const filler = { config: {} };
    alb.queue = new Array(25).fill(filler);
    alb.processing = new Array(alb.config.capacity).fill({ req: filler, timer: -1e9 });

    const req = new Request("WRITE");
    STATE.requests.push(req);
    req.flyTo(sqs);
    // Step sqs only — stepping alb would consume the fake filler jobs.
    for (let i = 0; i < 20; i++) {
      sqs.update(0.1);
      req.update(0.1);
    }
    expect(sqs.processing.length).toBe(1); // held back, not dropped
    expect(req.target).toBe(sqs);

    // Drain the ALB — the held job must now be forwarded.
    alb.queue = [];
    alb.processing = [];
    for (let i = 0; i < 20; i++) {
      sqs.update(0.1);
      req.update(0.1);
    }
    expect(sqs.processing.length).toBe(0);
    expect(req.target).toBe(alb);
  });
});

describe("cache determinism", () => {
  function cacheWorld() {
    const alb = place("alb");
    const compute = place("compute");
    const cache = place("cache");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, cache);
    connect(cache, db);
    return { alb, compute, cache, db };
  }

  it("hit (roll < hitRate): finished at the cache with the cached reward bonus", () => {
    cacheWorld();
    const moneyBefore = STATE.money;
    const req = inject("READ");
    vi.spyOn(Math, "random").mockReturnValue(0.0); // always a hit
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(req.cached).toBe(true);
    const bonus = 1 + CONFIG.survival.SCORE_POINTS.CACHE_HIT_BONUS;
    expect(STATE.money).toBeCloseTo(
      moneyBefore + CONFIG.trafficTypes.READ.reward * bonus,
      5
    );
  });

  it("miss (roll >= hitRate): forwarded to the db and finished there uncached", () => {
    const { db } = cacheWorld();
    const req = inject("READ");
    vi.spyOn(Math, "random").mockReturnValue(0.99); // always a miss
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(req.cached).toBe(false);
    expect(STATE.score.database).toBe(CONFIG.trafficTypes.READ.score);
    expect(db.connections).toEqual([]); // terminal
  });

  it("WRITE arriving at the cache is never a hit: forwarded straight to the db", () => {
    const { cache } = cacheWorld();
    const req = new Request("WRITE");
    STATE.requests.push(req);
    req.flyTo(cache);
    vi.spyOn(Math, "random").mockReturnValue(0.0); // would be a hit if rolled
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(req.cached).toBe(false);
  });

  it("compute does NOT route non-cacheable WRITE via the cache: with no direct db it fails", () => {
    cacheWorld(); // compute -> cache -> db, but no compute -> db edge
    inject("WRITE");
    run(10);

    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.WRITE).toBe(1);
  });
});

describe("compute routing preferences", () => {
  it("SEARCH prefers a connected search engine over the sql db", () => {
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    const search = place("search");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);
    connect(compute, search);

    inject("SEARCH");
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    // search termination score counts as database-family (destination db)
    expect(STATE.score.database).toBe(CONFIG.trafficTypes.SEARCH.score);
  });

  it("SEARCH against nosql-only storage fails (nosql cannot search)", () => {
    const alb = place("alb");
    const compute = place("compute");
    const nosql = place("nosql");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, nosql);

    inject("SEARCH");
    run(10);

    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.SEARCH).toBe(1);
  });

  it("STATIC delivered via a compute wired to s3 despite destination 'cdn' (#88)", () => {
    const alb = place("alb");
    const compute = place("compute");
    const s3 = place("s3");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, s3);

    inject("STATIC");
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.score.storage).toBe(CONFIG.trafficTypes.STATIC.score);
  });
});
