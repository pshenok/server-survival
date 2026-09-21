import { describe, expect, it, vi } from 'vitest';
import { createReport, parseReport, readReport, MAX_REPORT_BYTES } from '../src/lab/report.js';
import { LAB_MODEL_VERSION, validateScenario } from '../src/lab/scenario.js';

const board = { services: [{ type: 'compute', x: 0, z: 0, tier: 2, asgEnabled: true, instances: 3 }],
    connections: [] };
const scenario = validateScenario({ seed: 123, rps: 5, duration: 60, profile: 'bursts', mix: { READ: 80, WRITE: 20 } });
function report() {
    const result = { modelVersion: LAB_MODEL_VERSION, architecture: board, scenario, onTime: 40, p95: 4 };
    return createReport({ A: structuredClone(result), B: structuredClone(result) }, 'A cache should reduce latency.');
}

describe('portable laboratory inputs', () => {
    it('round-trips both architectures, upgrades, fleets, workload and hypothesis without importing results', () => {
        const source = report();
        source.results.A.onTime = 999999; // Imported scores must never become fresh measurements.
        const restored = parseReport(JSON.stringify(source));
        expect(restored).toEqual({ slots: { A: board, B: board }, scenario, hypothesis: source.hypothesis });
        expect(restored).not.toHaveProperty('results');
    });
    it('compares normalized workloads rather than JSON property order', () => {
        const source = report();
        source.results.B.scenario.mix = { WRITE: 20, READ: 80 };
        expect(parseReport(JSON.stringify(source)).scenario).toEqual(scenario);
    });
    it('rejects malformed reports and incompatible workloads before returning either board', () => {
        for (const edit of [
            r => { delete r.results.B; },
            r => { r.results.B.scenario.seed++; },
            r => { r.results.B.architecture.connections = [[0, 99]]; },
            r => { r.results.A.architecture.services[0].type = '__proto__'; },
            r => { r.conditions.upkeep = false; },
            r => { r.hypothesis = 'x'.repeat(1001); },
        ]) {
            const source = report(); edit(source);
            expect(() => parseReport(JSON.stringify(source))).toThrow('importInvalid');
        }
        for (const text of ['{', 'null', '[]', '42', 'metric,A,B']) {
            expect(() => parseReport(text)).toThrow('importInvalid');
        }
    });
    it('rejects future schema or model versions instead of silently changing their meaning', () => {
        for (const edit of [
            r => { r.schemaVersion = 2; },
            r => { r.modelVersion = 'future'; },
            r => { r.results.B.modelVersion = 'future'; },
        ]) {
            const source = report(); edit(source);
            expect(() => parseReport(JSON.stringify(source))).toThrow('importVersion');
        }
    });
    it('limits file size before reading and accounts for UTF-8 bytes when parsing text', async () => {
        const text = vi.fn();
        await expect(readReport({ size: MAX_REPORT_BYTES + 1, text })).rejects.toThrow('importTooLarge');
        expect(text).not.toHaveBeenCalled();
        expect(() => parseReport('界'.repeat(Math.ceil(MAX_REPORT_BYTES / 3)))).toThrow('importTooLarge');
        const source = JSON.stringify(report());
        await expect(readReport({ size: source.length, text: async () => source })).resolves.toHaveProperty('slots.A');
    });
});
