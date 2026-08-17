// Prioritized load shedding (#248) — the lesson, machine-proven.
//
// Before this, the API Gateway shed BLINDLY: everything past the rate limit
// was refused in arrival order, so what survived an overload was decided by
// topology and luck. Measured on the reference board at 8 rps, that meant
// READ 118 / SEARCH 32 / WRITE 28 / UPLOAD 19 lost and STATIC 0 — the $1.20
// and $1.50 traffic died while the $0.50 traffic sailed through, and the
// player could not influence it by any means at all.
//
// Real systems classify traffic in ADVANCE — Google's CRITICAL vs
// SHEDDABLE_PLUS, Envoy's priority levels — precisely because nobody can make
// that call during an incident. This is that mechanic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE, CONFIG, resetWorld, place, connect } from "../helpers/sim-world.mjs";
import { mulberry32, frame } from "../helpers/reference-board.mjs";

beforeEach(() => resetWorld({ gameMode: "survival" }));
afterEach(() => vi.restoreAllMocks());

// A board fronted by an API Gateway, which is the node that owns the policy.
function gatewayBoard() {
  resetWorld({ money: 1e9, gameMode: "survival" });
  vi.spyOn(Math, "random").mockImplementation(mulberry32(0x5eed));
  const waf = place("waf");
  const apigw = place("apigw");
  const alb = place("alb");
  const compute = place("compute");
  const db = place("db");
  const s3 = place("s3");
  const search = place("search");
  connect("internet", waf);
  connect(waf, apigw);
  connect(apigw, alb);
  connect(alb, compute);
  connect(compute, db);
  connect(compute, s3);
  connect(compute, search);
  if (!STATE.services.length) throw new Error("board did not build");
  return { apigw, compute };
}

// An even mix so the shed order is about POLICY, not about which class happens
// to be common.
const EVEN_MIX = {
  STATIC: 0.25, READ: 0.25, WRITE: 0.2, UPLOAD: 0.15, SEARCH: 0.15,
  MALICIOUS: 0, INFERENCE: 0,
};

// Run the SAME board and the SAME seeded traffic under a given policy. The
// blind policy (every class refused at the limit) is what the gateway did
// before #248, so the two runs differ only in the shed ORDER — which is the
// claim under test. Comparing absolute counts against each other instead
// would prove nothing: CRITICAL is 35% of this mix and SHEDDABLE 25%, so
// "more criticals survived" is true before the feature exists.
function runAt(rps, { policy, seconds = 40 } = {}) {
  const original = CONFIG.shedding;
  if (policy) CONFIG.shedding = policy;
  try {
    gatewayBoard();
    STATE.currentRPS = rps;
    STATE.trafficDistribution = { ...EVEN_MIX };
    const before = { ...STATE.finances.income.countByType };
    for (let i = 0; i < Math.round(seconds * 60); i++) frame(1 / 60);
    const served = {};
    for (const t of Object.keys(EVEN_MIX)) {
      served[t] = (STATE.finances.income.countByType[t] || 0) - (before[t] || 0);
    }
    return { served, income: +STATE.finances.income.total.toFixed(2) };
  } finally {
    CONFIG.shedding = original;
    vi.restoreAllMocks();
  }
}

const BLIND = { SHEDDABLE: 1.0, STANDARD: 1.0, CRITICAL: 1.0 };

describe("traffic classes are declared, not discovered (#248)", () => {
  it("every served class carries a criticality, and the policy knows it", () => {
    const policy = CONFIG.shedding;
    expect(policy.SHEDDABLE).toBeLessThan(policy.STANDARD);
    expect(policy.STANDARD).toBeLessThan(policy.CRITICAL);
    expect(policy.CRITICAL).toBe(1.0); // critical is carried to the last slot

    for (const [type, cfg] of Object.entries(CONFIG.trafficTypes)) {
      if (type === "MALICIOUS") continue; // never served, never classified
      if (type === "INFERENCE") {
        // Owns its own deadline mechanic at the Inference Gateway.
        expect(cfg.criticality).toBeDefined();
        continue;
      }
      expect(policy[cfg.criticality], `${type} has an unknown class`).toBeDefined();
    }
  });

  it("the money and the class agree: nothing cheap outranks something dear", () => {
    // Not a tautology — it is the design constraint. If a SHEDDABLE class ever
    // paid more than a CRITICAL one, the gateway would be protecting the wrong
    // revenue and the lesson would invert.
    const rank = { SHEDDABLE: 0, STANDARD: 1, CRITICAL: 2 };
    const served = Object.entries(CONFIG.trafficTypes).filter(
      ([t, c]) => t !== "MALICIOUS" && c.criticality
    );
    for (const [ta, ca] of served) {
      for (const [tb, cb] of served) {
        if (rank[ca.criticality] > rank[cb.criticality]) {
          expect(ca.reward, `${ta} outranks ${tb} but pays less`).toBeGreaterThanOrEqual(cb.reward);
        }
      }
    }
  });
});

describe("THE LESSON: the shed order is a decision, not an accident", () => {
  it("at mild overload the policy earns MORE than shedding blindly", () => {
    // 24 rps against a tier-1 gateway's 30 rps limit: the cheap class is
    // refused early, which frees downstream slots for traffic worth more.
    const blind = runAt(24, { policy: BLIND });
    const tiered = runAt(24);
    const fmt = (r) =>
      Object.entries(r.served).filter(([t]) => EVEN_MIX[t] > 0)
        .map(([t, n]) => `${t}=${n}`).join(" ");
    console.log(
      `\nMILD  BLIND : ${fmt(blind)}  income=$${blind.income}` +
        `\nMILD  TIERED: ${fmt(tiered)}  income=$${tiered.income}`
    );
    expect(tiered.served.STATIC).toBeLessThan(blind.served.STATIC);
    expect(tiered.income).toBeGreaterThan(blind.income);
  });

  it("at DEEP overload it protects what was declared critical — and that costs something", () => {
    // 50 rps. Here the honest result is a trade, not a free win: CRITICAL
    // survival is bought with SHEDDABLE traffic AND with some SEARCH, which
    // is STANDARD despite paying $1.20. That is the consequence of
    // classifying by ROLE (a transaction outranks a query) rather than by
    // price list, and it is the decision the player is being taught to make
    // in advance. Measured: UPLOAD 5 -> 8, STATIC 6 -> 3, income 33.38 ->
    // 32.51. A policy is a choice about what to lose, not a way to lose less.
    const blind = runAt(50, { policy: BLIND });
    const tiered = runAt(50);
    const fmt = (r) =>
      Object.entries(r.served).filter(([t]) => EVEN_MIX[t] > 0)
        .map(([t, n]) => `${t}=${n}`).join(" ");
    console.log(
      `\nDEEP  BLIND : ${fmt(blind)}  income=$${blind.income}` +
        `\nDEEP  TIERED: ${fmt(tiered)}  income=$${tiered.income}`
    );

    const criticalTiered = tiered.served.WRITE + tiered.served.UPLOAD;
    const criticalBlind = blind.served.WRITE + blind.served.UPLOAD;
    expect(criticalTiered).toBeGreaterThan(criticalBlind);
    expect(tiered.served.STATIC).toBeLessThan(blind.served.STATIC);
  });

  it("a healthy board sheds nothing at all — the policy is invisible below the limit", () => {
    // If the classes cost anything when there is headroom, this would be a tax
    // on playing rather than a lesson about pressure.
    const r = runAt(4);
    for (const [type, n] of Object.entries(r.served)) {
      if (EVEN_MIX[type] > 0) {
        expect(n, `${type} should be served freely at low load`).toBeGreaterThan(0);
      }
    }
    expect(r.served.STATIC).toBeGreaterThan(0); // the first class to be shed is fine here
  });

  it("shedding stays a SOFT fail: it never trips the breaker", () => {
    // Throttling is the gateway working as designed. If it fed the breaker,
    // protecting revenue would look like a broken gateway and the node would
    // take itself out of rotation for doing its job.
    const { apigw } = gatewayBoard();
    STATE.currentRPS = 30;
    STATE.trafficDistribution = { ...EVEN_MIX };
    for (let i = 0; i < 40 * 60; i++) frame(1 / 60);
    expect(apigw.breaker?.state ?? "closed").toBe("closed");
    vi.restoreAllMocks();
  });
});
