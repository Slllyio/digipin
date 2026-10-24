/**
 * LazyLibs — CDN libraries the app only needs after a user action, loaded on
 * first use instead of at boot.
 *
 * app.html used to load georaster (COG/GeoTIFF parsing) with the page, yet
 * nothing reads a COG until a realtime overlay or the hydrology tool asks
 * for one. On a slow link every boot-time script delays the first usable
 * frame (docs/QA_LOG.md, 2026-10-21), so such libraries live here: one
 * entry per library with the same pinned URL and integrity hash the page
 * used, and `load(name)` injects the tag once and resolves to the global.
 *
 * sw.js keeps these URLs in CDN_ASSETS so an installed app still has them
 * offline (the injected tag is served from the service-worker cache).
 * The table is exported for the test that checks the two stay in step.
 */
const LazyLibs = (() => {
    const LIBS = {
        georaster: {
            url: 'https://unpkg.com/georaster@1.6.0/dist/georaster.browser.bundle.min.js',
            integrity: 'sha384-k/E847ELHPuDVPWoArQHQe5LUD8YSFwxlUaH63fF618o/Y0Gnu4FQ1xjuL280spp',
            global: 'parseGeoraster',
            label: 'satellite-image reader',   // named in the status strip when the CDN fails
        },
    };
    const TIMEOUT_MS = 60000;   // a slow link downloads a few hundred KB in well under this
    const _pending = new Map();
    const _statusKey = (name) => `lib-${name}`;

    /** A failed download is a user-visible state, not a console line: the
     *  realtime overlays and the hydrology tool just show nothing without
     *  the library. The row offers Retry, which is the same load() call. */
    function _reportFailure(name, lib) {
        if (typeof DataStatus === 'undefined' || !DataStatus.set) return;
        DataStatus.set(_statusKey(name), {
            text: `The ${lib.label || name} library could not be downloaded — satellite overlays and hydrology are off until it loads`,
            kind: 'error',
            action: { label: 'Retry', busy: 'Loading…', run: () => load(name).then(() => true, () => false) },
        });
    }
    function _clearFailure(name) {
        if (typeof DataStatus !== 'undefined' && DataStatus.clear) DataStatus.clear(_statusKey(name));
    }

    function _present(lib) {
        return typeof globalThis !== 'undefined' && typeof globalThis[lib.global] !== 'undefined' ? globalThis[lib.global] : undefined;
    }

    /** Inject a script tag once; resolve when it ran, reject on error or after TIMEOUT_MS. */
    function _inject(lib) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = lib.url;
            el.setAttribute('integrity', lib.integrity);
            el.setAttribute('crossorigin', 'anonymous');
            el.async = true;
            const timer = setTimeout(() => { el.remove(); reject(new Error(`${lib.url} did not load in ${Math.round(TIMEOUT_MS / 1000)} s`)); }, TIMEOUT_MS);
            el.onload = () => {
                clearTimeout(timer);
                const g = _present(lib);
                if (g === undefined) reject(new Error(`${lib.url} loaded but did not define ${lib.global}`));
                else resolve(g);
            };
            el.onerror = () => { clearTimeout(timer); el.remove(); reject(new Error(`${lib.url} failed to load`)); };
            document.head.appendChild(el);
        });
    }

    /**
     * Resolve to the library's global (`parseGeoraster` for 'georaster'),
     * loading it on first call. Concurrent callers share one download; a
     * failed load is forgotten so the next call tries again.
     */
    function load(name) {
        const lib = LIBS[name];
        if (!lib) return Promise.reject(new Error(`LazyLibs: unknown library "${name}"`));
        const have = _present(lib);
        if (have !== undefined) return Promise.resolve(have);
        if (_pending.has(name)) return _pending.get(name);
        const p = _inject(lib).finally(() => _pending.delete(name));
        _pending.set(name, p);
        p.then(() => _clearFailure(name), () => _reportFailure(name, lib));
        return p;
    }

    /** True once the library's global exists (loaded by us or anyone else). */
    function isLoaded(name) {
        const lib = LIBS[name];
        return !!lib && _present(lib) !== undefined;
    }

    return { load, isLoaded, LIBS };
})();

if (typeof window !== 'undefined') window.LazyLibs = LazyLibs;
