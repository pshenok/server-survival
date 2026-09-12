// Cancellation destroys the isolated world. No save-state restoration needed.
export function runInFrame(architecture, scenario, signal, onProgress) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.title = 'Architecture experiment';
        const url = new URL(location.pathname, location.origin);
        url.searchParams.set('lab-runner', '1');
        frame.src = url.href;
        const token = crypto.randomUUID();
        let timer;
        let started = false;
        let settled = false;
        function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            signal.removeEventListener('abort', abort);
            frame.remove();
            if (error) reject(error); else resolve(result);
        }
        function abort() { finish(new DOMException('Cancelled', 'AbortError')); }
        function armTimeout() {
            clearTimeout(timer);
            timer = setTimeout(() => finish(new Error('Experiment timed out')), 30000);
        }
        function receive(event) {
            if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
            const data = event.data;
            if (data?.kind === 'lab-ready' && !started) {
                started = true;
                frame.contentWindow.postMessage({ kind: 'lab-run', token, architecture, scenario }, location.origin);
                armTimeout();
            } else if (started && data?.kind === 'lab-result' && data.token === token) {
                if (data.error) finish(new Error('Experiment failed'));
                else if (data.result) finish(null, data.result);
                else if (Number.isFinite(data.progress)) {
                    armTimeout();
                    onProgress(data.progress);
                }
            }
        }
        window.addEventListener('message', receive);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        document.body.appendChild(frame);
        armTimeout();
    });
}
