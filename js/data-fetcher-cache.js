/**
 * DataFetcherCache — TTL-based LocalStorage cache for slow/expensive fetches.
 *
 * Designed as a drop-in `memoize(key, ttlMs, factory)` wrapper:
 *
 *     return DataFetcherCache.memoize(`weather:${lat},${lng}`, 60*60*1000, () =>
 *         fetchWithRetry(weatherUrl)
 *     );
 *
 *  - LocalStorage backing: synchronous, ~5-10MB quota across the origin.
 *  - Entries over MAX_ENTRY_BYTES (default 500KB) are NOT cached, returned
 *    fresh — this prevents a single huge Overpass response from filling
 *    quota and evicting smaller useful entries.
 *  - Quota errors are swallowed (cache becomes a no-op pass-through).
 *  - Null/undefined factory results are NOT cached, so transient API
 *    failures don't poison the cache with empty data.
 *
 * Side-file precedent: this codebase has js/disha-cache.js on other branches
 * for DISHA response caching. Once PR #1 lands, the two caches can share a
 * common backing layer.
 */

const DataFetcherCache = (() => {
    const PREFIX = 'digipin:df:';
    const MAX_ENTRY_BYTES = 500 * 1024;
    // key -> in-flight factory promise, for concurrent-miss coalescing.
    const _inflight = new Map();

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, value); return true; } catch { return false; }
    }
    function safeRemove(key) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    }

    /** Parse a slot without evicting: { value, expired } or null (corrupt/absent). */
    function _read(key) {
        const raw = safeGet(PREFIX + key);
        if (!raw) return null;
        try {
            const entry = JSON.parse(raw);
            // Guard against valid-JSON-but-non-object slots (e.g. a key
            // collision): without this, entry.value is undefined and memoize
            // would treat that undefined as a cache hit and skip the factory.
            if (!entry || typeof entry !== 'object') {
                safeRemove(PREFIX + key);
                return null;
            }
            const expired = typeof entry.expiresAt === 'number' && entry.expiresAt < Date.now();
            return { value: entry.value, expired };
        } catch {
            safeRemove(PREFIX + key);
            return null;
        }
    }

    function get(key) {
        const entry = _read(key);
        if (!entry) return null;
        if (entry.expired) {
            safeRemove(PREFIX + key);
            return null;
        }
        return entry.value;
    }

    /** The last cached value even if expired (does not evict). For SWR. */
    function peekStale(key) {
        const entry = _read(key);
        return entry ? entry.value : null;
    }

    function set(key, value, ttlMs) {
        if (value == null) return;
        const serialized = JSON.stringify({ value, expiresAt: Date.now() + ttlMs });
        if (serialized.length > MAX_ENTRY_BYTES) return;
        safeSet(PREFIX + key, serialized);
    }

    function clear() {
        try {
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(PREFIX)) toRemove.push(k);
            }
            toRemove.forEach(safeRemove);
        } catch { /* ignore */ }
    }

    /** Fetch via factory, store, and de-dup concurrent calls for the same key. */
    function _refresh(key, ttlMs, factory) {
        if (_inflight.has(key)) return _inflight.get(key);
        // Clean up inside the async body's finally — NOT via promise.finally(),
        // which would spawn a second, unhandled rejection branch on failure even
        // though callers handle the returned promise.
        const promise = (async () => {
            try {
                const value = await factory();
                set(key, value, ttlMs);
                return value;
            } finally {
                _inflight.delete(key);
            }
        })();
        _inflight.set(key, promise);
        return promise;
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.staleWhileRevalidate] return the expired value
     *   immediately (if any) and refresh in the background — instant repeat
     *   visits at the cost of one slightly-stale render.
     */
    async function memoize(key, ttlMs, factory, opts) {
        const entry = _read(key);   // read without evicting
        if (entry && !entry.expired) {
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[DataFetcherCache] HIT', key);
            }
            return entry.value;
        }

        // Stale-while-revalidate: serve the expired value now, refresh in the
        // background (deduped). A failed refresh keeps the stale value until the
        // next attempt; swallow its rejection so it isn't unhandled.
        if (opts && opts.staleWhileRevalidate && entry && entry.expired && entry.value != null) {
            _refresh(key, ttlMs, factory).catch(() => {});
            return entry.value;
        }

        if (entry && entry.expired) safeRemove(PREFIX + key);

        // In-flight de-duplication: rapid clicks across adjacent cells that
        // round to the same key share one request instead of each firing a
        // duplicate network call before the first resolves.
        if (_inflight.has(key)) return _inflight.get(key);
        return _refresh(key, ttlMs, factory);
    }

    function keyFor(name, lat, lng, extra) {
        const latS = typeof lat === 'number' ? lat.toFixed(4) : String(lat);
        const lngS = typeof lng === 'number' ? lng.toFixed(4) : String(lng);
        const base = `${name}:${latS},${lngS}`;
        return extra ? `${base}:${extra}` : base;
    }

    return { get, set, clear, memoize, keyFor, peekStale };
})();

if (typeof window !== 'undefined') {
    window.DataFetcherCache = DataFetcherCache;
}
