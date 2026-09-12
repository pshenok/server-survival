import { runExperiment } from './engine.js';

// One message, one experiment, one disposable world. Source AND origin are
// checked; other tabs cannot start work in this frame.
let started = false;
window.addEventListener('message', event => {
    if (started || event.source !== window.parent || event.origin !== location.origin ||
        event.data?.kind !== 'lab-run' || typeof event.data.token !== 'string') return;
    started = true;
    const { token, architecture, scenario } = event.data;
    const send = value => window.parent.postMessage({ kind: 'lab-result', token, ...value }, location.origin);
    const iterator = runExperiment(architecture, scenario);
    function advance() {
        try {
            const next = iterator.next();
            if (next.done) send({ result: next.value });
            else {
                send(next.value);
                setTimeout(advance, 0);
            }
        } catch (error) {
            console.error('Lab experiment failed', error);
            send({ error: true });
        }
    }
    advance();
});
window.parent.postMessage({ kind: 'lab-ready' }, location.origin);
