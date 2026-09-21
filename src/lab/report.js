// Portable experiment inputs. A downloaded result is evidence, never executable
// state: imports validate both boards before exposing anything to the UI.
import { CONFIG } from '../config.js';
import { DRAIN_SECONDS, LAB_MODEL_VERSION, STEP_SECONDS, TYPES,
    validateArchitecture, validateScenario } from './scenario.js';

export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const CONDITIONS = { timestepSeconds: STEP_SECONDS, drainSeconds: DRAIN_SECONDS,
    mode: 'sandbox', upkeep: true, autoRepair: false, degradation: false, randomIncidents: false };

export class ReportImportError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

export function createReport(results, hypothesis) {
    return { schemaVersion: 1, modelVersion: LAB_MODEL_VERSION, hypothesis,
        conditions: { ...CONDITIONS,
            responsePopulation: 'external legitimate requests; excludes scheduler jobs and fan-out copies',
            fanoutCompletion: 'original delivery only; not atomic success of all subscribers',
            latencyPopulation: 'completed external legitimate requests only',
            costBasis: 'purchase plus all operating costs over load and drain; game dollars',
            trafficSloSeconds: Object.fromEntries(TYPES.map(type => [type, CONFIG.trafficTypes[type].sloSec ?? null])),
            inferenceDeadline: 'enforced by Inference Gateway when present' }, results };
}

export function parseReport(text) {
    if (typeof text !== 'string') throw new ReportImportError('importInvalid');
    if (text.length > MAX_REPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) {
        throw new ReportImportError('importTooLarge');
    }
    let report;
    try { report = JSON.parse(text); } catch { throw new ReportImportError('importInvalid'); }
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new ReportImportError('importInvalid');
    if (report.schemaVersion !== 1 || report.modelVersion !== LAB_MODEL_VERSION) {
        throw new ReportImportError('importVersion');
    }
    const a = report.results?.A, b = report.results?.B;
    if (!a || !b || typeof report.hypothesis !== 'string' || report.hypothesis.length > 1000 ||
        Object.entries(CONDITIONS).some(([key, value]) => report.conditions?.[key] !== value)) {
        throw new ReportImportError('importInvalid');
    }
    if (a.modelVersion !== LAB_MODEL_VERSION || b.modelVersion !== LAB_MODEL_VERSION) {
        throw new ReportImportError('importVersion');
    }
    try {
        const scenario = validateScenario(a.scenario);
        const otherScenario = validateScenario(b.scenario);
        if (JSON.stringify(scenario) !== JSON.stringify(otherScenario)) throw new Error('Different workloads');
        return { slots: { A: validateArchitecture(a.architecture), B: validateArchitecture(b.architecture) },
            scenario, hypothesis: report.hypothesis };
    } catch { throw new ReportImportError('importInvalid'); }
}

export async function readReport(file) {
    if (file.size > MAX_REPORT_BYTES) throw new ReportImportError('importTooLarge');
    return parseReport(await file.text());
}
