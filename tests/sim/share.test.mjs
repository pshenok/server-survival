// Share Architecture (#157): the ?arch= wire format over the REAL modules.
// Three concerns: the encode→decode round trip is lossless for what it
// promises to carry (types, positions, connections, budget); the decoder is a
// hard gate for hostile payloads (never throws, drops garbage, enforces the
// caps); and the rebuild goes through createService/createConnection so the
// edge allowlist and the reverse-edge guard (#192) hold even against a
// hand-crafted link.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildShareUrl,
  decodeArchParam,
  encodeArch,
  rebuildSharedArch,
} from "../../src/ui/share.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { STATE, CONFIG, resetWorld } from "../helpers/sim-world.mjs";

let warnSpy, errorSpy;

beforeEach(() => {
  resetWorld();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// Place at an explicit grid position (sim-world's place() marches x outward
// past the share format's position bound, so these tests pick their own).
function placeAt(type, x, z) {
  const before = STATE.services.length;
  createService(type, new globalThis.THREE.Vector3(x, 0, z));
  expect(STATE.services.length).toBe(before + 1);
  return STATE.services[STATE.services.length - 1];
}

// The param string exactly as a link would carry it.
function currentParam() {
  const url = buildShareUrl();
  expect(url).not.toBeNull();
  return url.split("?arch=")[1];
}

function b64url(str) {
  return Buffer.from(str).toString("base64url");
}

function payload(obj) {
  return b64url(JSON.stringify(obj));
}

// A small legal build: internet → waf → alb → compute → db.
function buildPipeline() {
  const waf = placeAt("waf", -16, 0);
  const alb = placeAt("alb", -8, 0);
  const compute = placeAt("compute", 0, 4);
  const db = placeAt("db", 8, -4);
  createConnection("internet", waf.id);
  createConnection(waf.id, alb.id);
  createConnection(alb.id, compute.id);
  createConnection(compute.id, db.id);
  return { waf, alb, compute, db };
}

describe("encode → decode round trip", () => {
  it("preserves service types and positions", () => {
    buildPipeline();
    const arch = decodeArchParam(currentParam());

    expect(arch).not.toBeNull();
    expect(arch.services.map((s) => s.type)).toEqual(["waf", "alb", "compute", "db"]);
    expect(arch.services.map((s) => [s.x, s.z])).toEqual([
      [-16, 0], [-8, 0], [0, 4], [8, -4],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("preserves connections and the internet edges as indices", () => {
    buildPipeline();
    const arch = decodeArchParam(currentParam());

    expect(arch.internet).toEqual([0]);
    expect(arch.connections).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it("preserves the sandbox budget", () => {
    STATE.sandboxBudget = 3456;
    buildPipeline();
    expect(decodeArchParam(currentParam()).budget).toBe(3456);
  });

  it("rebuilds the identical topology through createService/createConnection", () => {
    STATE.sandboxBudget = 3456;
    buildPipeline();
    const arch = decodeArchParam(currentParam());
    const totalCost =
      CONFIG.services.waf.cost + CONFIG.services.alb.cost +
      CONFIG.services.compute.cost + CONFIG.services.db.cost;

    resetWorld({ money: 0 });
    rebuildSharedArch(arch);

    expect(STATE.services.map((s) => s.type)).toEqual(["waf", "alb", "compute", "db"]);
    expect(STATE.services.map((s) => [s.position.x, s.position.z])).toEqual([
      [-16, 0], [-8, 0], [0, 4], [8, -4],
    ]);
    expect(STATE.internetNode.connections).toEqual([STATE.services[0].id]);
    expect(STATE.connections).toHaveLength(4); // internet edge + 3 service edges
    expect(STATE.sandboxBudget).toBe(3456);
    expect(STATE.money).toBe(3456 - totalCost);
  });

  it("keeps the URL under 2000 chars for a 50-service build", () => {
    const types = [
      "waf", "alb", "alb",
      ...Array(17).fill("compute"),
      ...Array(10).fill("cache"),
      ...Array(10).fill("db"),
      ...Array(10).fill("s3"),
    ];
    const services = types.map((type, i) =>
      placeAt(type, (i % 15) * 4 - 28, Math.floor(i / 15) * 4 - 20)
    );
    createConnection("internet", services[0].id);
    createConnection(services[0].id, services[1].id);
    createConnection(services[0].id, services[2].id);
    for (let i = 3; i < 20; i++) {
      createConnection(services[i % 2 === 0 ? 1 : 2].id, services[i].id); // alb → compute
      createConnection(services[i].id, services[i + 17].id); // compute → cache/db/s3-ish
    }
    expect(STATE.connections.length).toBeGreaterThan(30);

    const url = buildShareUrl();
    expect(url).not.toBeNull();
    expect(url.length).toBeLessThan(2000);

    const arch = decodeArchParam(url.split("?arch=")[1]);
    expect(arch.services).toHaveLength(50);
    expect(arch.connections.length + arch.internet.length).toBe(STATE.connections.length);
  });
});

describe("hostile / malformed input", () => {
  it("drops an unknown service type but keeps the valid ones", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000,
      t: ["waf", "totally-not-a-service", "alb"],
      p: [0, 0, 8, 0, 16, 0],
      c: [], i: [0],
    }));
    expect(arch.services[0].type).toBe("waf");
    expect(arch.services[1]).toBeNull();
    expect(arch.services[2].type).toBe("alb");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("drops an Object.prototype key posing as a service type", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000, t: ["toString"], p: [0, 0], c: [], i: [],
    }));
    expect(arch.services).toEqual([null]);
  });

  it("drops non-finite and non-numeric positions", () => {
    // 1e999 survives JSON.parse as Infinity; a string coordinate is a type lie.
    const raw = b64url('{"v":1,"b":100,"t":["waf","alb"],"p":[1e999,0,"8",0],"c":[],"i":[]}');
    const arch = decodeArchParam(raw);
    expect(arch.services).toEqual([null, null]);
  });

  it("drops positions outside the grid", () => {
    const bound = CONFIG.gridSize * CONFIG.tileSize;
    const arch = decodeArchParam(payload({
      v: 1, b: 100, t: ["waf", "alb"], p: [bound + 1, 0, -8, 0], c: [], i: [],
    }));
    expect(arch.services[0]).toBeNull();
    expect(arch.services[1]).not.toBeNull();
  });

  it("rejects an oversized raw param outright", () => {
    expect(decodeArchParam("A".repeat(5000))).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed base64 without throwing", () => {
    expect(decodeArchParam("%%%not-base64%%%")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects valid base64 of non-JSON without throwing", () => {
    expect(decodeArchParam(b64url("hello world"))).toBeNull();
  });

  it("rejects JSON that is not a v1 architecture object", () => {
    expect(decodeArchParam(b64url("42"))).toBeNull();
    expect(decodeArchParam(payload({ v: 2, b: 1, t: [], p: [], c: [], i: [] }))).toBeNull();
    expect(decodeArchParam(payload({ v: 1, b: 1, t: "waf", p: [], c: [], i: [] }))).toBeNull();
  });

  it("enforces the service-count cap", () => {
    const n = 61;
    const arch = decodeArchParam(payload({
      v: 1, b: 100,
      t: Array(n).fill("waf"),
      p: Array(n * 2).fill(0),
      c: [], i: [],
    }));
    expect(arch).toBeNull();
  });

  it("enforces the connection-count cap and pair alignment", () => {
    const base = { v: 1, b: 100, t: ["waf", "alb"], p: [0, 0, 8, 0], i: [] };
    expect(decodeArchParam(payload({ ...base, c: Array(482).fill(0) }))).toBeNull();
    expect(decodeArchParam(payload({ ...base, c: [0, 1, 0] }))).toBeNull(); // odd length
  });

  it("clamps or defaults a bogus budget instead of trusting it", () => {
    const base = { v: 1, t: [], p: [], c: [], i: [] };
    expect(decodeArchParam(payload({ ...base })).budget).toBe(CONFIG.sandbox.defaultBudget);
    expect(decodeArchParam(payload({ ...base, b: "9999" })).budget).toBe(CONFIG.sandbox.defaultBudget);
    expect(decodeArchParam(payload({ ...base, b: -50 })).budget).toBe(0);
    expect(decodeArchParam(payload({ ...base, b: 1e12 })).budget).toBe(1_000_000);
  });

  it("drops connection indices that are out of range or self-referential", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 100, t: ["waf", "alb"], p: [0, 0, 8, 0],
      c: [0, 7, -1, 1, 0, 0, 1.5, 1, 0, 1], i: [9],
    }));
    expect(arch.connections).toEqual([[0, 1]]); // only the legal waf → alb pair
    expect(arch.internet).toEqual([]);
  });
});

describe("rebuild security (allowlist + guards)", () => {
  it("silently refuses an injected illegal edge like db → waf", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000, t: ["db", "waf"], p: [0, 0, 8, 0], c: [0, 1], i: [],
    }));
    expect(arch.connections).toEqual([]); // filtered against the same allowlist

    rebuildSharedArch(arch);
    expect(STATE.services).toHaveLength(2); // the services themselves are fine
    expect(STATE.connections).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled(); // no in-game invalid-wire error path
  });

  it("refuses an illegal internet edge (internet → db)", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000, t: ["db"], p: [0, 0], c: [], i: [0],
    }));
    expect(arch.internet).toEqual([]);
    rebuildSharedArch(arch);
    expect(STATE.internetNode.connections).toEqual([]);
  });

  it("keeps the #192 reverse-edge guard: an injected ALB⇄SQS pair cannot form a cycle", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000, t: ["alb", "sqs"], p: [0, 0, 8, 0],
      c: [0, 1, 1, 0], i: [0], // both directions individually legal
    }));
    expect(arch.connections).toHaveLength(2); // decode can't know — state guard's job

    rebuildSharedArch(arch);
    const [alb, sqs] = STATE.services;
    expect(alb.connections).toEqual([sqs.id]);
    expect(sqs.connections).toEqual([]); // reverse edge refused → no loop
    expect(STATE.connections).toHaveLength(2); // internet → alb, alb → sqs
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("charges the shared build against the shared budget, floored at zero", () => {
    const cost = CONFIG.services.waf.cost + CONFIG.services.alb.cost;
    const arch = decodeArchParam(payload({
      v: 1, b: 500, t: ["waf", "alb"], p: [0, 0, 8, 0], c: [0, 1], i: [0],
    }));

    rebuildSharedArch(arch);
    expect(STATE.services).toHaveLength(2);
    expect(STATE.sandboxBudget).toBe(500);
    expect(STATE.money).toBe(500 - cost);

    // A budget smaller than the build still places everything — money just
    // bottoms out instead of silently truncating the shared architecture.
    resetWorld({ money: 0 });
    rebuildSharedArch(decodeArchParam(payload({
      v: 1, b: 10, t: ["waf", "alb"], p: [0, 0, 8, 0], c: [0, 1], i: [0],
    })));
    expect(STATE.services).toHaveLength(2);
    expect(STATE.money).toBe(0);
  });

  it("survives two services claiming the same tile (createService refuses the second)", () => {
    const arch = decodeArchParam(payload({
      v: 1, b: 1000, t: ["waf", "waf", "alb"], p: [0, 0, 0, 0, 8, 0],
      c: [0, 2, 1, 2], i: [0, 1],
    }));

    rebuildSharedArch(arch);
    expect(STATE.services.map((s) => s.type)).toEqual(["waf", "alb"]);
    expect(STATE.internetNode.connections).toHaveLength(1);
    // The dropped duplicate's edges vanish with it — only waf[0] → alb remains.
    expect(STATE.connections).toHaveLength(2);
  });
});
