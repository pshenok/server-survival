import { describe, expect, it } from 'vitest';
import { architectureCost, captureArchitecture, createRecorder, createSchedule, percentile,
    seededRandom, validateArchitecture, validateScenario } from '../src/lab/scenario.js';
import { LAB_MESSAGES } from '../src/lab/messages.js';
const settings = { seed: 42, duration: 30, profile: 'bursts', rps: 5, mix: { READ: 80, INFERENCE: 20 } };

describe('a common experimental workload', () => {
    it('replays every timestamp, type and AI generation length', () => {
        const first = createSchedule(settings);
        const otherRandom = seededRandom(42);
        for (let i = 0; i < 1000; i++) otherRandom();
        expect(createSchedule(settings)).toEqual(first);
        expect(createSchedule({ ...settings, seed: 43 })).not.toEqual(first);
    });
    it('changes arrival timing without changing demand or request attributes', () => {
        const bursts = createSchedule(settings);
        const steady = createSchedule({ ...settings, profile: 'steady' });
        expect(bursts).toHaveLength(150);
        expect(bursts.map(({ at, ...rest }) => rest)).toEqual(steady.map(({ at, ...rest }) => rest));
        expect(bursts.every(r => r.at % 5 < 1)).toBe(true);
        expect(bursts.every((r, i) => i === 0 || r.at > bursts[i - 1].at)).toBe(true);
        expect(bursts.at(-1).at).toBeLessThan(settings.duration);
    });
    it.each([
        { rps: 0 }, { rps: 51 }, { rps: Infinity }, { seed: -1 }, { seed: 2.5 },
        { duration: 100000 }, { profile: 'unknown' }, { mix: {} }, { mix: { READ: NaN } },
        { mix: { READ: 101 } }, { mix: { READ: -1 } },
    ])('rejects invalid workload %j', change => {
        expect(() => validateScenario({ ...settings, ...change })).toThrow();
    });
});

describe('snapshot fidelity', () => {
    it('captures tiers and autoscaling without retaining mutable game objects', () => {
        const state = { services: [{ id: 'cpu', type: 'compute', position: { x: 0, z: 4 }, tier: 2,
            asgEnabled: true, instances: 3 }], connections: [{ from: 'internet', to: 'cpu' }] };
        const snapshot = captureArchitecture(state);
        state.services[0].tier = 3;
        expect(snapshot.services[0]).toEqual({ type: 'compute', x: 0, z: 4, tier: 2, asgEnabled: true, instances: 3 });
        expect(snapshot.connections).toEqual([[-1, 0]]);
        expect(architectureCost(snapshot)).toBe(160);
    });
    it('rejects invalid saved service types, tiers and connection endpoints', () => {
        const service = { type: 'compute', x: 0, z: 0, tier: 1, asgEnabled: false, instances: 1 };
        for (const change of [{ type: '__proto__' }, { tier: 4 }, { instances: 100 }, { x: NaN }, { z: 1e9 }]) {
            expect(() => validateArchitecture({ services: [{ ...service, ...change }], connections: [] })).toThrow();
        }
        expect(() => validateArchitecture({ services: [service], connections: [[-1, 2]] })).toThrow();
    });
});

describe('honest experiment accounting', () => {
    it('includes failures, throttling, recovery and pending work in the denominator; excludes attacks and copies', () => {
        const schedule = Array.from({ length: 8 }, (_, index) => ({ index, type: index >= 6 ? 'MALICIOUS' : 'READ' }));
        const recorder = createRecorder(schedule);
        recorder.observe({ labArrival: 0, age: 1 }, 'COMPLETED');
        recorder.observe({ labArrival: 1, age: 8, pastSlo: true }, 'COMPLETED');
        recorder.observe({ labArrival: 2 }, 'FAILED');
        recorder.observe({ labArrival: 3 }, 'THROTTLED');
        recorder.observe({ labArrival: 4 }, 'RECOVERED');
        recorder.observe({ labArrival: 5, isFanoutCopy: true }, 'COMPLETED');
        recorder.observe({ age: 1 }, 'COMPLETED');
        recorder.observe({ labArrival: 6 }, 'MALICIOUS_BLOCKED');
        recorder.observe({ labArrival: 7 }, 'MALICIOUS_PASSED');
        recorder.observe({ labArrival: 0 }, 'FAILED');
        expect(recorder.report()).toMatchObject({ arrivals: 6, completed: 2, onTime: 1, late: 1,
            failed: 1, throttled: 1, recovered: 1, pending: 1, goodput: 1 / 6,
            p50: 1, p95: 8, attacks: 2, blocked: 1, breaches: 1 });
    });
    it('does not invent latency or goodput for an empty population', () => {
        expect(createRecorder([]).report()).toMatchObject({ goodput: null, p50: null, p95: null, p99: null });
        expect(percentile([3, 1, 2], 0.5)).toBe(2);
    });
    it('keeps Russian and English lab copy complete', () => {
        expect(Object.keys(LAB_MESSAGES.ru).sort()).toEqual(Object.keys(LAB_MESSAGES.en).sort());
    });
});
