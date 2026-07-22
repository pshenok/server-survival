// Request lifecycle over the REAL sim (#155 PR 10, tier 2): spawn -> route ->
// process -> finish, WAF blocking, failure accounting, and entry routing
// preferences. Math.random is pinned where a roll would make outcomes flaky
// (cache hits, load-based failure — load stays low so failChance is 0 anyway).
import { describe, it, expect, beforeEach } from "vitest";
import { Request } from "../../src/entities/Request.js";
import { routeRequestToEntry, spawnRequest } from "../../src/core/actions.js";
import { STATE, CONFIG, resetWorld, place, connect, run } from "../helpers/sim-world.mjs";

// No Math.random pinning needed here: these worlds have no cache/CDN hit
// rolls, and load stays far below 0.5 so calculateFailChanceBasedOnLoad is
// exactly 0 (pinning it globally would collide the random service ids).
beforeEach(() => resetWorld());

function inject(type) {
  const req = new Request(type);
  STATE.requests.push(req);
  routeRequestToEntry(req, type);
  return req;
}

describe("full pipeline: spawn -> route -> process -> finish", () => {
  it("a READ request through waf->alb->compute->db increments requestsProcessed and pays the reward", () => {
    const waf = place("waf");
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", waf);
    connect(waf, alb);
    connect(alb, compute);
    connect(compute, db);

    const moneyBefore = STATE.money;
    inject("READ");
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.requests).toHaveLength(0); // finished requests are removed
    expect(STATE.money).toBeCloseTo(moneyBefore + CONFIG.trafficTypes.READ.reward, 5);
    expect(STATE.score.database).toBe(CONFIG.trafficTypes.READ.score);
    expect(STATE.score.total).toBe(CONFIG.trafficTypes.READ.score);
    expect(STATE.failures.READ).toBe(0);
  });

  it("an UPLOAD request lands in S3 and scores as storage", () => {
    const alb = place("alb");
    const compute = place("compute");
    const s3 = place("s3");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, s3);

    inject("UPLOAD");
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
    expect(STATE.score.storage).toBe(CONFIG.trafficTypes.UPLOAD.score);
  });

  it("success gains reputation", () => {
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", alb);
    connect(alb, compute);
    connect(compute, db);

    STATE.reputation = 50;
    inject("WRITE");
    run(10);

    expect(STATE.reputation).toBeCloseTo(
      50 + CONFIG.survival.SCORE_POINTS.SUCCESS_REPUTATION,
      5
    );
  });
});

describe("WAF vs MALICIOUS traffic", () => {
  it("WAF blocks MALICIOUS on intake: score + mitigation cost, no failure, request removed", () => {
    const waf = place("waf");
    connect("internet", waf);

    const moneyBefore = STATE.money;
    inject("MALICIOUS");
    run(2);

    expect(STATE.score.maliciousBlocked).toBe(
      CONFIG.survival.SCORE_POINTS.MALICIOUS_BLOCKED_SCORE
    );
    expect(STATE.money).toBeCloseTo(
      moneyBefore - CONFIG.survival.SCORE_POINTS.MALICIOUS_MITIGATION_COST,
      5
    );
    expect(STATE.failures.MALICIOUS).toBe(0);
    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.requests).toHaveLength(0); // #! leak guard: blocked req removed
  });

  it("MALICIOUS that reaches compute without a WAF costs the breach penalty and reputation", () => {
    const alb = place("alb");
    const compute = place("compute");
    connect("internet", alb);
    connect(alb, compute);

    const moneyBefore = STATE.money;
    STATE.reputation = 100;
    inject("MALICIOUS");
    run(10);

    expect(STATE.failures.MALICIOUS).toBe(1);
    expect(STATE.reputation).toBeCloseTo(
      100 + CONFIG.survival.SCORE_POINTS.MALICIOUS_PASSED_REPUTATION,
      5
    );
    expect(STATE.money).toBeCloseTo(
      moneyBefore - CONFIG.survival.SCORE_POINTS.MALICIOUS_BREACH_PENALTY,
      5
    );
  });

  it("non-malicious traffic passes through the WAF unharmed", () => {
    const waf = place("waf");
    const alb = place("alb");
    const compute = place("compute");
    const db = place("db");
    connect("internet", waf);
    connect(waf, alb);
    connect(alb, compute);
    connect(compute, db);

    inject("READ");
    run(10);

    expect(STATE.requestsProcessed).toBe(1);
  });
});

describe("failure accounting", () => {
  it("a request with no entry point fails immediately: counter + reputation", () => {
    STATE.reputation = 100;
    inject("READ"); // internetNode has no connections
    expect(STATE.failures.READ).toBe(1);
    expect(STATE.reputation).toBeCloseTo(
      100 + CONFIG.survival.SCORE_POINTS.FAIL_REPUTATION,
      5
    );
    expect(STATE.score.total).toBeCloseTo(-CONFIG.trafficTypes.READ.score / 2, 5);
  });

  it("a dead-end pipeline fails the request at the last hop", () => {
    const alb = place("alb");
    const compute = place("compute");
    connect("internet", alb);
    connect(alb, compute); // compute has no db/s3 downstream

    inject("WRITE");
    run(10);

    expect(STATE.requestsProcessed).toBe(0);
    expect(STATE.failures.WRITE).toBe(1);
  });

  it("spawnRequest with an all-zero traffic mix spawns nothing (#174)", () => {
    STATE.trafficDistribution = {
      STATIC: 0, READ: 0, WRITE: 0, UPLOAD: 0, SEARCH: 0, MALICIOUS: 0,
    };
    spawnRequest();
    expect(STATE.requests).toHaveLength(0);
    expect(STATE.failures.STATIC).toBe(0);
  });
});

describe("entry routing preferences", () => {
  it("STATIC traffic prefers the CDN entry over the WAF", () => {
    const waf = place("waf");
    const cdn = place("cdn");
    connect("internet", waf);
    connect("internet", cdn);

    const req = inject("STATIC");
    expect(req.target).toBe(cdn);
  });

  it("non-STATIC traffic prefers the WAF entry over other entries", () => {
    const cdn = place("cdn");
    const waf = place("waf");
    const alb = place("alb");
    connect("internet", cdn);
    connect("internet", alb);
    connect("internet", waf);

    const req = inject("READ");
    expect(req.target).toBe(waf);
  });

  it("a disabled entry node is skipped in favor of a live one", () => {
    const waf1 = place("waf");
    const waf2 = place("waf");
    connect("internet", waf1);
    connect("internet", waf2);
    waf1.isDisabled = true;

    const req = inject("READ");
    expect(req.target).toBe(waf2);
  });
});
