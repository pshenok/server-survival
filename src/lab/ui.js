import { STATE } from '../state.js';
import { CONFIG } from '../config.js';
import { i18n } from '../i18n.js';
import { LAB_MESSAGES } from './messages.js';
import { architectureCost, captureArchitecture, LAB_MODEL_VERSION, LAB_STORAGE_KEY,
    TYPES, validateArchitecture, validateScenario } from './scenario.js';
import { runInFrame } from './transport.js';

const t = key => (LAB_MESSAGES[i18n.currentLocale] || LAB_MESSAGES.en)[key];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const slots = { A: null, B: null };
let results = null;
let controller = null;
let hypothesis = '';
let scenario = { seed: 42, duration: 60, profile: 'bursts', rps: 5,
    mix: Object.fromEntries(TYPES.map(type => [type, type === 'READ' ? 100 : 0])) };
let storageUnavailable = false;
try {
    const raw = localStorage.getItem(LAB_STORAGE_KEY);
    if (raw && raw.length < 100000) {
        const saved = JSON.parse(raw);
        if (saved.version === 1) {
            for (const name of ['A', 'B']) if (saved.slots?.[name]) slots[name] = validateArchitecture(saved.slots[name]);
            if (saved.scenario) scenario = validateScenario(saved.scenario);
            hypothesis = typeof saved.hypothesis === 'string' ? saved.hypothesis.slice(0, 1000) : '';
        }
    }
} catch { /* unavailable or corrupt storage does not prevent experiments */ }

function persist() {
    try {
        localStorage.setItem(LAB_STORAGE_KEY, JSON.stringify({ version: 1, slots, scenario, hypothesis }));
        storageUnavailable = false;
    } catch { storageUnavailable = true; }
}

export function queueExample() {
    const node = (type, x) => ({ type, x, z: 0, tier: 1, asgEnabled: false, instances: 1 });
    return {
        A: { services: [node('waf', -24), node('alb', -12), node('compute', 0), node('db', 12)],
            connections: [[-1, 0], [0, 1], [1, 2], [2, 3]] },
        B: { services: [node('waf', -24), node('alb', -12), node('sqs', 0), node('compute', 12), node('db', 24)],
            connections: [[-1, 0], [0, 1], [1, 2], [2, 3], [3, 4]] },
    };
}

function diagram(board) {
    const all = [{ x: CONFIG.internetNodeStartPos.x, z: CONFIG.internetNodeStartPos.z }, ...board.services];
    const xs = all.map(s => s.x), zs = all.map(s => s.z);
    const minX = Math.min(...xs), minZ = Math.min(...zs);
    const spanX = Math.max(...xs) - minX || 1, spanZ = Math.max(...zs) - minZ;
    const positions = all.map(s => ({ x: 25 + (s.x - minX) / spanX * 350,
        y: spanZ ? 25 + (s.z - minZ) / spanZ * 65 : 58 }));
    const lines = board.connections.map(([a, b]) => {
        const p = positions[a + 1], q = positions[b + 1];
        return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#64748b" stroke-width="2"/>`;
    }).join('');
    const nodes = all.map((s, i) => {
        const p = positions[i];
        const label = i === 0 ? 'WWW' : s.type;
        const color = i === 0 ? '#67e8f9' : '#' + CONFIG.colors[s.type].toString(16).padStart(6, '0');
        return `<g><title>${escape(label)}${i ? ` · T${s.tier} · ×${s.instances}` : ''}</title><circle cx="${p.x}" cy="${p.y}" r="7" fill="${color}"/>${all.length <= 12 ? `<text x="${p.x}" y="${p.y + 22}" text-anchor="middle" fill="#cbd5e1" font-size="10">${escape(label)}</text>` : ''}</g>`;
    }).join('');
    return `<svg aria-hidden="true" viewBox="0 0 400 125">${lines}${nodes}</svg>`;
}

const dialog = document.createElement('dialog');
dialog.id = 'lab-dialog';
dialog.setAttribute('aria-labelledby', 'lab-title');
document.body.appendChild(dialog);
const openButton = $('open-lab');

function status(key) {
    $('lab-status').textContent = t(key);
}
function invalidate() {
    results = null;
    $('lab-results').replaceChildren();
    $('lab-export').disabled = true;
    $('lab-csv').disabled = true;
}

function paintSlots() {
    for (const name of ['A', 'B']) {
        const board = slots[name];
        const target = $(`lab-slot-${name}`);
        target.innerHTML = board ? `${diagram(board)}<p>${board.services.length} ${t('nodes')} · ${board.connections.length} ${t('links')} · $${architectureCost(board)}</p>` : `<p class="lab-empty">${t('empty')}</p>`;
    }
    $('lab-run').disabled = !slots.A || !slots.B;
    $('lab-sample').hidden = !!(slots.A || slots.B);
}

function render() {
    dialog.innerHTML = `<header class="lab-header"><div><h2 id="lab-title">${t('title')}</h2><p>${t('intro')}</p></div><button id="lab-close">${t('close')}</button></header>
    <div class="lab-body"><p>${t('instruction')}</p>
    <fieldset id="lab-controls"><div class="lab-variants">${['A', 'B'].map(name => `<section class="lab-variant lab-${name}"><h3>${name}</h3><div id="lab-slot-${name}"></div><button id="lab-capture-${name}">${t('capture')} ${name}</button></section>`).join('')}</div>
    <button id="lab-sample" class="lab-secondary">${t('sample')}</button>
    <label class="lab-hypothesis" for="lab-hypothesis">${t('hypothesis')}</label><textarea id="lab-hypothesis" maxlength="1000" rows="2" placeholder="${escape(t('placeholder'))}">${escape(hypothesis)}</textarea>
    <h3>${t('setup')}</h3><div class="lab-settings">
    <label>${t('profile')}<select id="lab-profile"><option value="steady">${t('steady')}</option><option value="bursts">${t('bursts')}</option></select></label>
    <label>${t('duration')}<select id="lab-duration">${[30, 60, 120].map(n => `<option value="${n}">${n} ${t('seconds')}</option>`).join('')}</select></label>
    <label>${t('rate')}<input id="lab-rps" type="number" min="0.5" max="50" step="0.5" value="${scenario.rps}" required></label>
    <label>${t('seed')}<input id="lab-seed" type="number" min="0" max="4294967295" step="1" value="${scenario.seed}" required></label>
    </div><p class="lab-note">${t('burstHint')}</p>
    <h4>${t('mix')}</h4><div class="lab-mix">${TYPES.map(type => `<label>${type}<input id="lab-mix-${type}" type="number" min="0" max="100" step="1" value="${scenario.mix[type]}" required></label>`).join('')}</div>
    <p class="lab-note">${t('mixHint')}</p></fieldset>
    <div class="lab-actions"><button id="lab-run" class="lab-primary">${t('run')}</button><button id="lab-cancel" hidden>${t('cancel')}</button><button id="lab-export" disabled>${t('export')}</button><button id="lab-csv" disabled>${t('csv')}</button></div>
    <p id="lab-status" role="status" aria-live="polite"></p><progress id="lab-progress" max="100" value="0" hidden aria-label="${escape(t('run'))}"></progress>
    <section id="lab-results"></section>
    <details class="lab-method"><summary>${t('assumptions')}</summary><p>${t('rules')}</p><p>${t('counting')}</p><p>${t('limits')}</p><p>${t('model')}: ${LAB_MODEL_VERSION} · Δt = 1/60 s</p></details></div>`;
    $('lab-profile').value = scenario.profile;
    $('lab-duration').value = String(scenario.duration);
    $('lab-close').onclick = close;
    for (const name of ['A', 'B']) $(`lab-capture-${name}`).onclick = () => {
        try {
            slots[name] = captureArchitecture(STATE);
            invalidate(); persist(); paintSlots(); status(storageUnavailable ? 'storage' : 'saved');
        } catch { status('badBoard'); }
    };
    $('lab-sample').onclick = () => {
        Object.assign(slots, queueExample());
        hypothesis = t('sampleHypothesis');
        $('lab-hypothesis').value = hypothesis;
        persist(); paintSlots(); status(storageUnavailable ? 'storage' : 'prepared');
    };
    $('lab-controls').addEventListener('input', event => {
        if (event.target.id === 'lab-hypothesis') {
            hypothesis = event.target.value;
            persist();
        } else {
            invalidate(); status('changed');
            try { scenario = readScenario(); persist(); } catch { /* show validation on Run */ }
        }
    });
    $('lab-run').onclick = compare;
    $('lab-cancel').onclick = () => controller?.abort();
    $('lab-export').onclick = () => download('json');
    $('lab-csv').onclick = () => download('csv');
    paintSlots(); status(results ? 'done' : slots.A && slots.B ? 'prepared' : 'ready');
    if (results) paintResults();
}

function readScenario() {
    // Empty number inputs must be invalid, not silently coerced to zero.
    const number = id => $(id).value.trim() === '' ? NaN : Number($(id).value);
    return validateScenario({ seed: number('lab-seed'), duration: number('lab-duration'),
        profile: $('lab-profile').value, rps: number('lab-rps'),
        mix: Object.fromEntries(TYPES.map(type => [type, number(`lab-mix-${type}`)])) });
}

async function compare() {
    if (controller || !slots.A || !slots.B) return;
    try { scenario = readScenario(); } catch { status('invalid'); return; }
    persist(); invalidate();
    controller = new AbortController();
    const active = controller;
    $('lab-controls').disabled = true;
    $('lab-run').disabled = true;
    $('lab-cancel').hidden = false;
    $('lab-progress').hidden = false;
    $('lab-progress').value = 0;
    try {
        const pair = {};
        for (const [index, name] of ['A', 'B'].entries()) {
            $('lab-status').textContent = `${t('running')} ${name}…`;
            pair[name] = await runInFrame(slots[name], scenario, active.signal, progress => {
                $('lab-progress').value = index * 50 + progress * 50;
            });
        }
        results = pair;
        $('lab-progress').value = 100;
        paintResults(); status('done');
    } catch (error) {
        status(error.name === 'AbortError' ? 'cancelled' : 'error');
    } finally {
        controller = null;
        $('lab-controls').disabled = false;
        $('lab-run').disabled = false;
        $('lab-cancel').hidden = true;
        $('lab-progress').hidden = true;
    }
}

export const REPORT_METRICS = ['arrivals', 'goodput', 'completed', 'onTime', 'late', 'failed', 'throttled',
    'recovered', 'pending', 'p50', 'p95', 'p99', 'peakQueue', 'buildCost', 'operatingCost', 'totalCost',
    'costPer1000', 'attacks', 'blocked', 'breaches', 'pendingAttacks'];
function format(key, value) {
    if (value === null) return t('missing');
    if (key === 'goodput') return `${(value * 100).toFixed(1)}%`;
    if (['p50', 'p95', 'p99'].includes(key)) return `${value.toFixed(2)} ${t('seconds')}`;
    if (key.toLowerCase().includes('cost')) return `$${value.toFixed(2)}`;
    return String(value);
}

function queueChart() {
    const maximum = Math.max(1, ...results.A.series.map(s => s.queued), ...results.B.series.map(s => s.queued));
    const horizon = results.A.horizon;
    const x = at => 35 + at / horizon * 690;
    const y = count => 130 - count / maximum * 110;
    const lines = ['A', 'B'].map(name => {
        const points = [{ at: 0, queued: 0 }, ...results[name].series].map(s => `${x(s.at)},${y(s.queued)}`).join(' ');
        return `<polyline points="${points}" fill="none" stroke="${name === 'A' ? '#7dd3fc' : '#fdba74'}" stroke-width="2.5" ${name === 'B' ? 'stroke-dasharray="7 4"' : ''}/>`;
    }).join('');
    const end = x(results.A.scenario.duration);
    return `<svg role="img" aria-label="${escape(t('queueChart'))}" viewBox="0 0 760 165"><path d="M35 20V130H725" stroke="#64748b" fill="none"/><line x1="${end}" y1="20" x2="${end}" y2="130" stroke="#94a3b8" stroke-dasharray="3 5"/>${lines}<g fill="#cbd5e1" font-size="12"><text x="4" y="25">${maximum}</text><text x="14" y="135">0</text><text x="35" y="153">0</text><text x="${end - 8}" y="153">${results.A.scenario.duration}</text><text x="710" y="153">${horizon}s</text></g></svg>`;
}
function paintResults() {
    $('lab-results').innerHTML = `<h3>${t('results')}</h3><div class="lab-table-wrap"><table><thead><tr><th scope="col">${t('metric')}</th><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody>${REPORT_METRICS.map(key => `<tr><th scope="row">${t(key)}</th><td>${format(key, results.A[key])}</td><td>${format(key, results.B[key])}</td></tr>`).join('')}</tbody></table></div><h4>${t('queueChart')}</h4>${queueChart()}<p class="lab-note">${t('chartHint')}</p><p class="lab-reflect">${t('reflect')}</p>`;
    $('lab-export').disabled = false;
    $('lab-csv').disabled = false;
}
function download(kind) {
    if (!results) return;
    const data = kind === 'json' ? JSON.stringify({ schemaVersion: 1, modelVersion: LAB_MODEL_VERSION,
        hypothesis, conditions: { timestepSeconds: 1 / 60, drainSeconds: 30, mode: 'sandbox',
            upkeep: true, autoRepair: false, degradation: false, randomIncidents: false,
            responsePopulation: 'external legitimate requests; excludes scheduler jobs and fan-out copies',
            fanoutCompletion: 'original delivery only; not atomic success of all subscribers',
            latencyPopulation: 'completed external legitimate requests only',
            costBasis: 'purchase plus all operating costs over load and drain; game dollars',
            trafficSloSeconds: Object.fromEntries(TYPES.map(type => [type, CONFIG.trafficTypes[type].sloSec ?? null])),
            inferenceDeadline: 'enforced by Inference Gateway when present' }, results }, null, 2) :
        ['metric,A,B', ...REPORT_METRICS.map(key => `${key},${results.A[key] ?? ''},${results.B[key] ?? ''}`)].join('\r\n');
    const url = URL.createObjectURL(new Blob([data], { type: kind === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `server-survival-lab-${results.A.scenario.seed}.${kind}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function close() {
    controller?.abort();
    dialog.close();
    openButton?.focus();
}
function open() {
    if (STATE.gameMode !== 'sandbox' || controller) return;
    window.setTimeScale(0);
    render();
    dialog.showModal();
    $('lab-close').focus();
}
// Native modal provides focus containment; game shortcuts must not fire while typing.
dialog.addEventListener('keydown', event => event.stopPropagation());
dialog.addEventListener('keyup', event => event.stopPropagation());
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
if (openButton) {
    openButton.textContent = t('open');
    openButton.onclick = open;
}
window.addEventListener('localeChanged', () => {
    if (openButton) openButton.textContent = t('open');
    if (dialog.open && !controller) render();
});
