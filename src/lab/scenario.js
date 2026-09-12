import { CONFIG } from '../config.js';

export const LAB_MODEL_VERSION = '1';
export const STEP_SECONDS = 1 / 60;
export const DRAIN_SECONDS = 30;
export const LAB_STORAGE_KEY = 'serverSurvivalLabV1';
export const TYPES = Object.keys(CONFIG.trafficTypes);

export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function validateScenario(value) {
    if (!value || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 4294967295 ||
        ![30, 60, 120].includes(value.duration) || !['steady', 'bursts'].includes(value.profile) ||
        !Number.isFinite(value.rps) || value.rps < 0.5 || value.rps > 50) throw new Error('Invalid scenario');
    const mix = Object.fromEntries(TYPES.map(type => [type, value.mix?.[type] ?? 0]));
    if (Object.values(mix).some(n => !Number.isFinite(n) || n < 0 || n > 100) ||
        !Object.values(mix).some(n => n > 0)) throw new Error('Invalid traffic mix');
    return { seed: value.seed, duration: value.duration, profile: value.profile, rps: value.rps, mix };
}

// Every arrival, including AI generation length, is fixed BEFORE a board runs.
// Burst profile has the same total volume: five seconds' demand in its first second.
export function createSchedule(input) {
    const s = validateScenario(input);
    const random = seededRandom(s.seed);
    const total = Object.values(s.mix).reduce((a, b) => a + b, 0);
    const count = Math.floor(s.duration * s.rps);
    return Array.from({ length: count }, (_, index) => {
        const steadyTime = (index + 0.5) / s.rps;
        const at = s.profile === 'bursts' ? Math.floor(steadyTime / 5) * 5 + (steadyTime % 5) / 5 : steadyTime;
        let roll = random() * total;
        const type = TYPES.find(t => (roll -= s.mix[t]) < 0) || TYPES.at(-1);
        const genLength = random() < 0.7 ? 0.6 + random() * 0.4 : 1.8 + random() * 1.2;
        return { index, at, type, genLength };
    });
}

export function captureArchitecture(state) {
    const ids = new Map(state.services.map((s, i) => [s.id, i]));
    return validateArchitecture({
        services: state.services.map(s => ({ type: s.type, x: s.position.x, z: s.position.z,
            tier: s.tier, asgEnabled: !!s.asgEnabled, instances: s.instances || 1 })),
        connections: state.connections.map(c => [c.from === 'internet' ? -1 : ids.get(c.from), ids.get(c.to)]),
    });
}

export function validateArchitecture(value) {
    if (!value || !Array.isArray(value.services) || value.services.length > 60 ||
        !Array.isArray(value.connections) || value.connections.length > 240) throw new Error('Invalid architecture');
    const bound = CONFIG.gridSize * CONFIG.tileSize;
    const services = value.services.map(s => {
        if (!s || !Object.hasOwn(CONFIG.services, s.type) ||
            !Number.isFinite(s.x) || Math.abs(s.x) > bound || !Number.isFinite(s.z) || Math.abs(s.z) > bound ||
            !Number.isInteger(s.tier) || s.tier < 1 || s.tier > (CONFIG.services[s.type].tiers?.length || 1) ||
            typeof s.asgEnabled !== 'boolean' || !Number.isInteger(s.instances) || s.instances < 1 ||
            s.instances > CONFIG.autoscaling.maxInstances || (!s.asgEnabled && s.instances !== 1) ||
            ((s.asgEnabled || s.instances !== 1) && !['compute', 'container'].includes(s.type))) {
            throw new Error('Invalid service');
        }
        return { type: s.type, x: s.x, z: s.z, tier: s.tier, asgEnabled: s.asgEnabled, instances: s.instances };
    });
    const connections = value.connections.map(c => {
        if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) ||
            c[0] < -1 || c[0] >= services.length || c[1] < 0 || c[1] >= services.length || c[0] === c[1]) {
            throw new Error('Invalid connection');
        }
        return [...c];
    });
    return { services, connections };
}

export function architectureCost(architecture) {
    return architecture.services.reduce((sum, s) => sum + CONFIG.services[s.type].cost +
        (CONFIG.services[s.type].tiers || []).slice(1, s.tier).reduce((cost, t) => cost + t.cost, 0), 0);
}

export function percentile(samples, fraction) {
    if (!samples.length) return null;
    const ordered = [...samples].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

export function createRecorder(schedule) {
    const outcomes = new Map();
    return {
        observe(req, outcome) {
            if (!Number.isInteger(req.labArrival) || req.isFanoutCopy || outcomes.has(req.labArrival)) return;
            outcomes.set(req.labArrival, { outcome, age: req.age || 0, late: !!req.pastSlo });
        },
        report() {
            const result = { arrivals: 0, completed: 0, onTime: 0, late: 0, failed: 0, throttled: 0,
                recovered: 0, pending: 0, attacks: 0, blocked: 0, breaches: 0, pendingAttacks: 0 };
            const latencies = [];
            for (const arrival of schedule) {
                const end = outcomes.get(arrival.index);
                if (arrival.type === 'MALICIOUS') {
                    result.attacks++;
                    if (!end) result.pendingAttacks++;
                    else if (end.outcome === 'MALICIOUS_BLOCKED') result.blocked++;
                    else result.breaches++;
                    continue;
                }
                result.arrivals++;
                if (!end) result.pending++;
                else if (end.outcome === 'COMPLETED') {
                    result.completed++;
                    result[end.late ? 'late' : 'onTime']++;
                    latencies.push(end.age);
                } else if (end.outcome === 'THROTTLED') result.throttled++;
                else if (end.outcome === 'RECOVERED') result.recovered++;
                else result.failed++;
            }
            return { ...result, goodput: result.arrivals ? result.onTime / result.arrivals : null,
                p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) };
        },
    };
}
