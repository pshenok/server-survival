import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE, resetWorld } from '../helpers/sim-world.mjs';
import { i18n } from '../../src/i18n.js';
import { LOCALES } from '../helpers/load-globals.mjs';
import { runInFrame } from '../../src/lab/transport.js';
import { REPORT_METRICS, queueExample } from '../../src/lab/ui.js';
import { createReport } from '../../src/lab/report.js';
import { LAB_MODEL_VERSION, LAB_STORAGE_KEY, validateScenario } from '../../src/lab/scenario.js';

vi.mock('../../src/lab/transport.js', () => ({ runInFrame: vi.fn() }));
const get = id => document.getElementById(id);
function input(id, value) {
    get(id).value = value;
    get(id).dispatchEvent(new Event('input', { bubbles: true }));
}
function result(architecture, scenario) {
    return { ...Object.fromEntries(REPORT_METRICS.map(key => [key, 0])), modelVersion: LAB_MODEL_VERSION,
        architecture, scenario, goodput: 0.95, p95: 1234.5, totalCost: 45.65,
        horizon: scenario.duration + 30, series: [{ at: 1, queued: 2 }] };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resetWorld();
    STATE.animationId = -1;
    i18n.setLocale('en');
    get('open-lab').click();
    get('lab-capture-A').click();
    get('lab-capture-B').click();
    input('lab-hypothesis', 'My hypothesis stays in the language I wrote it.');
    input('lab-seed', '123');
    runInFrame.mockImplementation((board, scenario) => Promise.resolve(result(board, scenario)));
});
afterEach(() => {
    get('lab-close').click();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('lab localization through the game language selector', () => {
    it('uses English by default and switches every language without losing snapshots or inputs', () => {
        expect(get('lab-title').textContent).toBe('Compare architectures');
        for (const { code } of LOCALES) {
            i18n.setLocale(code);
            expect(get('lab-dialog').lang).toBe(code);
            expect(get('lab-title').textContent).toBe(i18n.t('lab_title'));
            expect(get('open-lab').textContent).toBe(i18n.t('lab_open'));
            expect(get('lab-run').textContent).toBe(i18n.t('lab_run'));
            expect(get('lab-hypothesis').value).toBe('My hypothesis stays in the language I wrote it.');
            expect(get('lab-seed').value).toBe('123');
            expect(get('lab-run').disabled).toBe(false);
            input('lab-rps', '0');
            get('lab-run').click();
            expect(get('lab-status').textContent).toBe(i18n.t('lab_invalid'));
            input('lab-rps', '5');
        }
        expect(runInFrame).not.toHaveBeenCalled();
    });
    it('retains results when switching languages and formats numbers, currency and time units', async () => {
        get('lab-run').click();
        await vi.waitFor(() => expect(get('lab-export').disabled).toBe(false));
        for (const { code } of LOCALES) {
            i18n.setLocale(code);
            const report = get('lab-results');
            expect(report.textContent).toContain(i18n.t('lab_results'));
            expect(report.textContent).toContain(i18n.t('lab_p95'));
            expect(report.textContent).toContain(new Intl.NumberFormat(code, {
                minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5));
            expect(report.textContent).toContain(new Intl.NumberFormat(code, {
                style: 'currency', currency: 'USD' }).format(45.65));
            expect(report.querySelector('svg').textContent).toContain(i18n.t('lab_seconds'));
            expect(get('lab-export').disabled).toBe(false);
        }
        expect(runInFrame).toHaveBeenCalledTimes(2);
    });
    it('finishes with a fully translated interface if the locale changes during a run', async () => {
        let finishA;
        runInFrame.mockImplementationOnce((board, scenario) => new Promise(resolve => {
            finishA = () => resolve(result(board, scenario));
        }));
        get('lab-run').click();
        i18n.setLocale('fr');
        finishA();
        await vi.waitFor(() => expect(get('lab-export').disabled).toBe(false));
        expect(get('lab-dialog').lang).toBe('fr');
        expect(get('lab-run').textContent).toBe(i18n.t('lab_run'));
        expect(get('lab-status').textContent).toBe(i18n.t('lab_done'));
        expect(get('lab-results').textContent).toContain(i18n.t('lab_results'));
    });
});


function chooseReport(file) {
    const field = get('lab-import-file');
    Object.defineProperty(field, 'files', { configurable: true, value: [file] });
    field.dispatchEvent(new Event('change', { bubbles: true }));
}
function importedReport() {
    const boards = queueExample();
    const scenario = validateScenario({ seed: 77, rps: 3, duration: 30, profile: 'steady', mix: { READ: 100 } });
    return createReport({ A: result(boards.A, scenario), B: result(boards.B, scenario) }, '<img src=x> My hypothesis');
}

describe('loading a laboratory report', () => {
    it('restores both variants atomically and reruns their inputs without using the file scores', async () => {
        const source = importedReport();
        const gameBoard = STATE.services;
        chooseReport(new File([JSON.stringify(source)], 'experiment.json', { type: 'application/json' }));
        await vi.waitFor(() => expect(get('lab-status').textContent).toBe(i18n.t('lab_imported')));
        expect(get('lab-hypothesis').value).toBe(source.hypothesis);
        expect(get('lab-dialog').querySelector('img')).toBeNull();
        expect(get('lab-seed').value).toBe('77');
        expect(get('lab-profile').value).toBe('steady');
        expect(get('lab-results').textContent).toBe('');
        expect(get('lab-export').disabled).toBe(true);
        expect(runInFrame).not.toHaveBeenCalled();
        expect(STATE.services).toBe(gameBoard);
        const saved = JSON.parse(localStorage.getItem(LAB_STORAGE_KEY));
        expect(saved.slots.B).toEqual(source.results.B.architecture);
        get('lab-run').click();
        await vi.waitFor(() => expect(get('lab-export').disabled).toBe(false));
        expect(runInFrame.mock.calls[0][0]).toEqual(source.results.A.architecture);
        expect(runInFrame.mock.calls[1][0]).toEqual(source.results.B.architecture);
        expect(runInFrame.mock.calls[0][1]).toEqual(source.results.A.scenario);
    });
    it('keeps snapshots, hypothesis and existing results when either imported variant is invalid', async () => {
        get('lab-run').click();
        await vi.waitFor(() => expect(get('lab-export').disabled).toBe(false));
        const previous = { stored: localStorage.getItem(LAB_STORAGE_KEY), results: get('lab-results').innerHTML,
            hypothesis: get('lab-hypothesis').value };
        const source = importedReport();
        source.results.B.architecture.connections = [[0, 99]];
        chooseReport(new File([JSON.stringify(source)], 'invalid.json'));
        await vi.waitFor(() => expect(get('lab-status').textContent).toBe(i18n.t('lab_importInvalid')));
        expect(localStorage.getItem(LAB_STORAGE_KEY)).toBe(previous.stored);
        expect(get('lab-results').innerHTML).toBe(previous.results);
        expect(get('lab-hypothesis').value).toBe(previous.hypothesis);
        expect(get('lab-export').disabled).toBe(false);
    });
    it('ignores a pending file read after closing and reopening the laboratory', async () => {
        let finishRead;
        chooseReport({ size: 100, text: () => new Promise(resolve => { finishRead = resolve; }) });
        expect(get('lab-run').disabled).toBe(true);
        get('lab-close').click();
        get('open-lab').click();
        const previous = get('lab-hypothesis').value;
        finishRead(JSON.stringify(importedReport()));
        await Promise.resolve();
        await Promise.resolve();
        expect(get('lab-hypothesis').value).toBe(previous);
        expect(get('lab-run').disabled).toBe(false);
    });
    it('translates import controls and rejection messages in every supported language', async () => {
        for (const { code } of LOCALES) {
            i18n.setLocale(code);
            expect(get('lab-import').textContent).toBe(i18n.t('lab_import'));
            chooseReport(new File(['broken JSON'], 'bad.json'));
            await vi.waitFor(() => expect(get('lab-status').textContent).toBe(i18n.t('lab_importInvalid')));
            expect(get('lab-import-file').value).toBe('');
        }
    });
});
