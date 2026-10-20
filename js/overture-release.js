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

    return { resolve, base, url, current, latestFromListing, FALLBACK_RELEASE };
})();

if (typeof window !== 'undefined') window.OvertureRelease = OvertureRelease;
