import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE, resetWorld } from '../helpers/sim-world.mjs';
import { runExperiment } from '../../src/lab/engine.js';
import { runInFrame } from '../../src/lab/transport.js';
import { createReport, parseReport } from '../../src/lab/report.js';
import { inExperiment } from '../../src/lab/context.js';
import { captureArchitecture } from '../../src/lab/scenario.js';

const node = (type, x, extra = {}) => ({ type, x, z: 0, tier: 1, asgEnabled: false, instances: 1, ...extra });
const baseline = { services: [node('waf', -24), node('alb', -12), node('compute', 0), node('db', 12)],
    connections: [[-1, 0], [0, 1], [1, 2], [2, 3]] };
const settings = { seed: 42, duration: 30, rps: 5, profile: 'bursts', mix: { READ: 100 } };
function run(board = baseline, scenario = settings) {
    const iterator = runExperiment(board, scenario);
    let next;
    do { next = iterator.next(); } while (!next.done);
    return next.value;
}
beforeEach(() => {
    vi.useFakeTimers();
    resetWorld();
    STATE.animationId = -1;
    localStorage.clear();
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('laboratory using the real simulation', () => {
    it('repeats a run exactly, independent of wall time and prior routing counters', () => {
        const first = run();
        vi.advanceTimersByTime(5000);
        const second = run();
        expect(second).toEqual(first);
        expect(first.arrivals).toBe(150);
        expect(first.onTime + first.late + first.failed + first.throttled + first.recovered + first.pending).toBe(150);
        expect(first.operatingCost).toBeGreaterThan(0);
        expect(first.buildCost).toBe(300);
        expect(first.series).toHaveLength(60);
        expect(inExperiment()).toBe(false);
    });
    it('reproduces a downloaded experiment with the same game rules', () => {
        const original = run();
        const loaded = parseReport(JSON.stringify(createReport({ A: original, B: original }, 'Replay this workload')));
        expect(run(loaded.slots.A, loaded.scenario)).toEqual(original);
    });
    it('shows a real trade-off when adding a queue to burst traffic', () => {
        const queued = { services: [node('waf', -24), node('alb', -12), node('sqs', 0), node('compute', 12), node('db', 24)],
            connections: [[-1, 0], [0, 1], [1, 2], [2, 3], [3, 4]] };
        const a = run(), b = run(queued);
        expect(b.arrivals).toBe(a.arrivals);
        expect(b.failed).toBeLessThan(a.failed);
        expect(b.p95).toBeGreaterThan(a.p95);
        expect(b.totalCost).toBeGreaterThan(a.totalCost);
    });
    it('does not award success to a disconnected board or hide its failures', () => {
        const r = run({ services: [], connections: [] });
        expect(r).toMatchObject({ arrivals: 150, failed: 150, completed: 0, goodput: 0,
            p95: null, pending: 0, costPer1000: null });
        expect(STATE.requests).toHaveLength(0);
    });
    it('separates attacks from the legitimate response population', () => {
        const r = run(baseline, { ...settings, rps: 1, profile: 'steady', mix: { MALICIOUS: 100 } });
        expect(r).toMatchObject({ arrivals: 0, attacks: 30, blocked: 30, breaches: 0, goodput: null, p95: null });
    });
    it('retains upgrades and ready fleets and starts healthy', () => {
        const board = { ...baseline, services: baseline.services.map(s => s.type === 'compute' ?
            { ...s, tier: 2, asgEnabled: true, instances: 3 } : s) };
        const iterator = runExperiment(board, settings);
        iterator.next();
        const cpu = STATE.services.find(s => s.type === 'compute');
        expect(cpu.tier).toBe(2);
        expect(cpu.config.capacity).toBe(10);
        expect(cpu.asgEnabled).toBe(true);
        expect(cpu.health).toBe(100);
        expect(captureArchitecture(STATE).connections).toEqual(board.connections);
        iterator.return();
        expect(inExperiment()).toBe(false);
    });
    it('does not change campaign, sound or achievement persistence', () => {
        const existing = { serverSurvivalCampaignProgress: '{"sentinel":1}',
            serverSurvivalSoundPrefs: '{"musicMuted":false,"sfxMuted":false}',
            serverSurvivalAchievements: '{"sentinel":2}' };
        for (const [key, value] of Object.entries(existing)) localStorage.setItem(key, value);
        run();
        for (const [key, value] of Object.entries(existing)) expect(localStorage.getItem(key)).toBe(value);
        expect(localStorage.length).toBe(Object.keys(existing).length);
    });
    it('cleans up on invalid wiring instead of silently comparing another board', () => {
        expect(() => run({ ...baseline, connections: [[-1, 3]] })).toThrow('Invalid connection');
        expect(inExperiment()).toBe(false);
    });
});


describe('isolated experiment transport', () => {
    beforeEach(() => {
        // Exercise DOM lifecycle and messaging without fetching a real page.
        vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    it('cancels and removes the experiment world without leaving timers', async () => {
        const control = new AbortController();
        const pending = runInFrame(baseline, settings, control.signal, vi.fn());
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(document.querySelector('iframe')).not.toBeNull();
        control.abort();
        await rejection;
        expect(document.querySelector('iframe')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('accepts results only from its frame, origin and run token', async () => {
        const progress = vi.fn();
        const pending = runInFrame(baseline, settings, new AbortController().signal, progress);
        const frame = document.querySelector('iframe');
        const post = vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation(() => {});
        const receive = (data, source = frame.contentWindow, origin = location.origin) =>
            window.dispatchEvent(new MessageEvent('message', { source, origin, data }));
        receive({ kind: 'lab-ready' }, window);
        expect(post).not.toHaveBeenCalled();
        receive({ kind: 'lab-ready' });
        const { token } = post.mock.calls[0][0];
        receive({ kind: 'lab-result', token: 'wrong', progress: 1 });
        receive({ kind: 'lab-result', token, progress: 1 }, frame.contentWindow, 'https://unrelated.invalid');
        expect(progress).not.toHaveBeenCalled();
        receive({ kind: 'lab-result', token, progress: 0.5 });
        expect(progress).toHaveBeenCalledWith(0.5);
        receive({ kind: 'lab-result', token, result: { completed: 5 } });
        await expect(pending).resolves.toEqual({ completed: 5 });
        expect(document.querySelector('iframe')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('times out a frame that never becomes ready and releases it', async () => {
        const pending = runInFrame(baseline, settings, new AbortController().signal, vi.fn());
        const rejection = expect(pending).rejects.toThrow('timed out');
        vi.advanceTimersByTime(30001);
        await rejection;
        expect(document.querySelector('iframe')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
