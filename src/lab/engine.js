// Runs the actual service/request handlers at a fixed timestep. The browser
// hosts each run in its own disposable iframe, never in the player's world.
import { STATE } from '../state.js';
import { Service } from '../entities/Service.js';
import { Request } from '../entities/Request.js';
import { createConnection } from '../sim/topology.js';
import { recomputePower } from '../sim/power.js';
import { routeRequestToEntry, resetEntryRouting } from '../core/actions.js';
import { resetGame } from '../../game.js';
import { setExperimentContext } from './context.js';
import { architectureCost, createRecorder, createSchedule, DRAIN_SECONDS, LAB_MODEL_VERSION,
    seededRandom, STEP_SECONDS, validateArchitecture, validateScenario } from './scenario.js';

export function* runExperiment(architecture, scenario) {
    const board = validateArchitecture(architecture);
    const settings = validateScenario(scenario);
    const schedule = createSchedule(settings);
    const recorder = createRecorder(schedule);
    setExperimentContext({ random: seededRandom(settings.seed ^ 0x9e3779b9), observe: recorder.observe });
    try {
        // No rAF, audio, user input or achievement polling in this world.
        if (STATE.animationId) cancelAnimationFrame(STATE.animationId);
        STATE.animationId = -1;
        STATE.sound.musicMuted = true;
        STATE.sound.sfxMuted = true;
        resetGame('sandbox');
        STATE.timeScale = 1;
        STATE.currentRPS = 0;
        STATE.upkeepEnabled = true;
        STATE.autoRepairEnabled = false;
        resetEntryRouting();
        const nodes = board.services.map((s, i) => {
            const node = Service.restore({ ...s, id: `lab-${i}` }, new THREE.Vector3(s.x, 0, s.z));
            STATE.services.push(node);
            return node;
        });
        recomputePower();
        if (STATE.power.usedKw > STATE.power.capKw) throw new Error('Insufficient power');
        for (const [from, to] of board.connections) {
            const before = STATE.connections.length;
            createConnection(from === -1 ? 'internet' : nodes[from].id, nodes[to].id);
            if (STATE.connections.length !== before + 1) throw new Error('Invalid connection');
        }
        const buildCost = architectureCost(board);
        STATE.finances.expenses.services = buildCost;
        const frames = Math.round((settings.duration + DRAIN_SECONDS) / STEP_SECONDS);
        const series = [];
        let nextArrival = 0;
        let peakQueue = 0;
        for (let tick = 1; tick <= frames; tick++) {
            const now = tick * STEP_SECONDS;
            STATE.elapsedGameTime = now;
            STATE.services.forEach(s => s.update(STEP_SECONDS));
            STATE.requests.slice().forEach(r => r.update(STEP_SECONDS));
            while (nextArrival < schedule.length && schedule[nextArrival].at <= now) {
                const arrival = schedule[nextArrival++];
                const req = new Request(arrival.type);
                req.labArrival = arrival.index;
                req.genLength = arrival.genLength;
                STATE.requests.push(req);
                routeRequestToEntry(req, arrival.type);
            }
            STATE.reputation = Math.min(100, STATE.reputation);
            const queued = STATE.services.reduce((sum, s) => sum + s.queue.length +
                (s.parked?.length || 0) + (s.partitions || []).reduce((n, p) => n + p.length, 0), 0);
            peakQueue = Math.max(peakQueue, queued);
            if (tick % 60 === 0) series.push({ at: now, queued });
            if (tick % 180 === 0) yield { progress: tick / frames };
        }
        const outcomes = recorder.report();
        const expenses = STATE.finances.expenses;
        // Both boards pay for the same horizon, including the drain window.
        const operatingCost = ['upkeep', 'mitigation', 'breach', 'repairs', 'autoRepair', 'dlq']
            .reduce((sum, key) => sum + (expenses[key] || 0), 0);
        return { modelVersion: LAB_MODEL_VERSION, scenario: settings, architecture: board,
            ...outcomes, buildCost, operatingCost, totalCost: buildCost + operatingCost,
            costPer1000: outcomes.onTime ? (buildCost + operatingCost) * 1000 / outcomes.onTime : null,
            peakQueue, series, horizon: settings.duration + DRAIN_SECONDS };
    } finally {
        STATE.timeScale = 0;
        STATE.isRunning = false;
        setExperimentContext(null);
    }
}
