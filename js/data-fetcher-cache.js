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

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, value); return true; } catch { return false; }
    }
    function safeRemove(key) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    }

    function get(key) {
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
            if (typeof entry.expiresAt === 'number' && entry.expiresAt < Date.now()) {
                safeRemove(PREFIX + key);
                return null;
            }
            return entry.value;
        } catch {
            safeRemove(PREFIX + key);
            return null;
        }
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

    async function memoize(key, ttlMs, factory) {
        const hit = get(key);
        if (hit !== null) {
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[DataFetcherCache] HIT', key);
            }
            return hit;
        }
        const value = await factory();
        set(key, value, ttlMs);
        return value;
    }

    function keyFor(name, lat, lng, extra) {
        const latS = typeof lat === 'number' ? lat.toFixed(4) : String(lat);
        const lngS = typeof lng === 'number' ? lng.toFixed(4) : String(lng);
        const base = `${name}:${latS},${lngS}`;
        return extra ? `${base}:${extra}` : base;
    }

    return { get, set, clear, memoize, keyFor };
})();

if (typeof window !== 'undefined') {
    window.DataFetcherCache = DataFetcherCache;
}
