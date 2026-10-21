/**
 * OvertureRelease — where the current Overture Maps PMTiles live.
 *
 * Overture keeps only the latest couple of releases in its public tile bucket
 * and deletes older ones, so any hard-coded release URL eventually 403s (the
 * old 2024-08-20 beta path did, leaving the 3D buildings blank). This module
 * lists the bucket's `tiles/` prefix (public S3 ListObjectsV2, CORS-enabled),
 * picks the newest release, and caches it for a day. Until that resolves —
 * or when the listing fails — callers get FALLBACK_RELEASE.
 *
 *   OvertureRelease.url('buildings')   // sync: best-known URL right now
 *   await OvertureRelease.resolve()    // newest release id
 */

const OvertureRelease = (() => {
    const BUCKET = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com';
    // Newest release verified in the bucket when this was written.
    const FALLBACK_RELEASE = '2026-09-23.1';
    const CACHE_KEY = 'overture-release';
    const CACHE_TTL = 24 * 60 * 60 * 1000;

    let _release = _readCache() || FALLBACK_RELEASE;
    let _pending = null;

    /**
     * Newest release id (e.g. "2026-09-23.1") from a ListObjectsV2 XML body
     * listing `tiles/<release>/` common prefixes, or null if none. Pure.
     */
    function latestFromListing(xml) {
        const re = /<Prefix>tiles\/(\d{4}-\d{2}-\d{2}(?:\.\d+)?)\/<\/Prefix>/g;
        const ids = [];
        let m;
        while ((m = re.exec(String(xml || ''))) !== null) ids.push(m[1]);
        if (!ids.length) return null;
        // Date first, then the minor patch number (".1" beats ".0").
        ids.sort((a, b) => {
            const [da, pa = '0'] = a.split('.');
            const [db, pb = '0'] = b.split('.');
            return da === db ? (+pa) - (+pb) : (da < db ? -1 : 1);
        });
        return ids[ids.length - 1];
    }

    function _readCache() {
        try {
            const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (c && c.release && Date.now() - c.at < CACHE_TTL) return c.release;
        } catch { /* storage blocked or corrupt */ }
        return null;
    }

    function _writeCache(release) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ release, at: Date.now() })); }
        catch { /* storage blocked */ }
    }

    /** Discover the newest release once per page load; resolves to its id. */
    function resolve() {
        if (_pending) return _pending;
        _pending = fetch(`${BUCKET}/?list-type=2&prefix=tiles/&delimiter=/`)
            .then(res => (res.ok ? res.text() : ''))
            .then(xml => {
                const latest = latestFromListing(xml);
                if (latest) { _release = latest; _writeCache(latest); }
                return _release;
            })
            .catch(() => _release);
        return _pending;
    }

    /** Base URL of the current release's tile folder (no trailing slash). */
    function base() { return `${BUCKET}/tiles/${_release}`; }

    /** PMTiles URL for an Overture theme: buildings, transportation, places, base, divisions. */
    function url(theme) { return `${base()}/${theme}.pmtiles`; }

    /** Release id currently in use. */
    function current() { return _release; }

    // ---- Range-read guard -------------------------------------------------
    // A PMTiles archive is read by HTTP range requests, and the pmtiles
    // library shares one promise per directory read between every tile that
    // needs it. A read whose headers arrive but whose body never finishes (a
    // stalled connection; seen on CI runners) therefore hangs every later
    // tile of the archive silently: no error, no retry, the source never
    // reports loaded and the 3D city stays empty. The guard caps each read
    // and retries it once past the HTTP cache; a second failure is an error
    // MapLibre reports like any other tile failure.
    const RANGE_TIMEOUT_MS = 30000;
    const _rangeStats = { reads: 0, timeouts: 0, retried: 0, recovered: 0, failed: 0 };

    /**
     * Wrap `lib.FetchSource.prototype.getBytes` (the pmtiles library's HTTP
     * reader) with a per-read timeout and one retry. Idempotent; returns
     * true when the guard was installed.
     */
    function guardRangeReads(lib, { timeoutMs = RANGE_TIMEOUT_MS } = {}) {
        const Src = lib && lib.FetchSource;
        if (!Src || !Src.prototype || typeof Src.prototype.getBytes !== 'function') return false;
        if (Src.prototype._rangeGuard) return true;
        const orig = Src.prototype.getBytes;
        Src.prototype.getBytes = function (offset, length, signal, etag) {
            const once = () => {
                _rangeStats.reads++;
                const ctrl = new AbortController();
                let timedOut = false;
                const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
                const onAbort = () => ctrl.abort();
                if (signal) {
                    if (signal.aborted) ctrl.abort();
                    else signal.addEventListener('abort', onAbort, { once: true });
                }
                let p;
                try { p = Promise.resolve(orig.call(this, offset, length, ctrl.signal, etag)); }
                catch (e) { p = Promise.reject(e); }
                return p
                    .finally(() => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); })
                    .catch((e) => {
                        if (!timedOut) throw e;
                        _rangeStats.timeouts++;
                        const err = new Error(`PMTiles range read timed out after ${timeoutMs} ms`);
                        err.timedOut = true;
                        throw err;
                    });
            };
            return once().catch((e) => {
                if ((signal && signal.aborted) || !e || !e.timedOut) throw e;
                _rangeStats.retried++;
                // The retry bypasses the HTTP cache (pmtiles' own reload flag),
                // in case a half-cached body is what stalled.
                this.mustReload = true;
                return once().then(
                    (r) => { _rangeStats.recovered++; return r; },
                    (e2) => { _rangeStats.failed++; throw e2; });
            });
        };
        Src.prototype._rangeGuard = true;
        return true;
    }

    /** Counts of guarded reads, timeouts, retries, recoveries and failures. */
    function rangeStats() { return { ..._rangeStats }; }

    return { resolve, base, url, current, latestFromListing, FALLBACK_RELEASE, guardRangeReads, rangeStats, RANGE_TIMEOUT_MS };
})();

if (typeof window !== 'undefined') window.OvertureRelease = OvertureRelease;
