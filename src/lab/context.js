// Optional experiment context. Ordinary gameplay retains native randomness.
// External arrivals use a separate precomputed stream (scenario.js).
export const isLabFrame = typeof window !== 'undefined' && window.parent !== window &&
    new URLSearchParams(location.search).has('lab-runner');
let context = null;
export function setExperimentContext(value) { context = value; }
export function inExperiment() { return context !== null; }
export function simulationRandom() { return context ? context.random() : Math.random(); }
export function observeExperiment(req, outcome) { context?.observe(req, outcome); }
