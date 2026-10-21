/**
 * CrashGuard — last-line error capture for the app shell.
 *
 * Catches uncaught exceptions and unhandled promise rejections that no module
 * handled, keeps a short ring buffer for diagnostics, and surfaces a persistent
 * notice (via DataStatus) with a Reload action instead of failing silently.
 *
 *   CrashGuard.init();                      // once, early in boot
 *   CrashGuard.report(err, 'buildings');    // modules can route caught errors here
 *   CrashGuard.recent();                    // [{ time, message, source }] newest last
 *
 * Benign noise is ignored: ResizeObserver loop warnings, opaque cross-origin
 * "Script error.", user-initiated AbortErrors, and plain network failures
 * (fetch rejections) which the data layers already turn into their own notices.
 */
const CrashGuard = (() => {
    'use strict';

    const MAX_RECENT = 20;
    const _recent = [];
    let _count = 0;
    let _installed = false;

    const BENIGN = [
        /ResizeObserver loop/i,
        /^Script error\.?$/i,
        /AbortError|The operation was aborted|signal is aborted/i,
        /Failed to fetch|NetworkError when attempting|Load failed|net::ERR_/i,
        /WebGL.*context lost/i, // handled by the map's own recovery
    ];

    function _message(err) {
        if (err == null) return 'Unknown error';
        if (typeof err === 'string') return err;
        if (err.message) return String(err.message);
        try { return JSON.stringify(err).slice(0, 200); } catch { return String(err); }
    }

    function isBenign(message) {
        return BENIGN.some(re => re.test(message || ''));
    }

    function _notify() {
        if (typeof DataStatus === 'undefined' || !DataStatus.set) return;
        const n = _count;
        DataStatus.set('crash', {
            text: n === 1
                ? 'Something went wrong. If the map stops responding, reload.'
                : `Something went wrong (${n} errors). If the map stops responding, reload.`,
            kind: n >= 3 ? 'error' : 'warning',
            action: { label: 'Reload', run: () => { try { window.location.reload(); } catch { /* ignore */ } } },
        });
    }

    /** Record an error; returns true when it was counted (not benign). */
    function report(err, source) {
        const message = _message(err);
        if (isBenign(message)) return false;
        _count += 1;
        _recent.push({ time: Date.now(), message: message.slice(0, 500), source: source || 'unknown' });
        if (_recent.length > MAX_RECENT) _recent.shift();
        _notify();
        return true;
    }

    function init() {
        if (_installed || typeof window === 'undefined') return;
        _installed = true;
        window.addEventListener('error', (ev) => {
            // Resource load failures (img/script 404) arrive here with no `error`
            // and a target element — the owning module handles those.
            if (!ev || (ev.target && ev.target !== window && !ev.error)) return;
            report(ev.error || ev.message, ev.filename ? ev.filename.replace(/^.*\//, '') : 'window');
        });
        window.addEventListener('unhandledrejection', (ev) => {
            report(ev && ev.reason, 'promise');
        });
    }

    function recent() { return _recent.slice(); }
    function count() { return _count; }
    function reset() {
        _recent.length = 0; _count = 0;
        if (typeof DataStatus !== 'undefined' && DataStatus.clear) DataStatus.clear('crash');
    }

    return { init, report, recent, count, reset, isBenign };
})();

if (typeof window !== 'undefined') window.CrashGuard = CrashGuard;
