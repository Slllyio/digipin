/**
 * FootprintGrid — samples the precomputed building-footprint density grid
 * (data/buildings/footprint_grid_<region>.json, produced by
 * pipeline/buildings/footprint_grid.py from complete ML footprints) so the app
 * can correct OSM's building undercount in Tier-2 India.
 *
 * The grid is a small per-cell { count, coveragePct, meanAreaM2 } raster over
 * the region bbox. It's loaded once (best-effort) and sampled by lat/lng; when
 * the file isn't present the API returns null and callers fall back to OSM —
 * so this is purely additive. indexFor/sample are pure and unit-tested.
 */
const FootprintGrid = (() => {
    const DEFAULT_URL = './data/buildings/footprint_grid_indore.json';
    let _grid = null;
    let _loaded = false;
    let _loading = null;

    /** Row-major cell index for a lat/lng, or -1 when outside the grid bounds. */
    function indexFor(grid, lat, lng) {
        if (!grid || !grid.bounds) return -1;
        const b = grid.bounds;
        if (lng < b.west || lng >= b.east || lat < b.south || lat >= b.north) return -1;
        const x = Math.min(grid.nx - 1, Math.floor((lng - b.west) / (b.east - b.west) * grid.nx));
        const y = Math.min(grid.ny - 1, Math.floor((b.north - lat) / (b.north - b.south) * grid.ny)); // row 0 = north
        return y * grid.nx + x;
    }

    /** { count, coveragePct, meanAreaM2, res_m, source } for a cell, or null. */
    function sample(grid, lat, lng) {
        const i = indexFor(grid, lat, lng);
        if (i < 0) return null;
        return {
            count: grid.count[i],
            coveragePct: grid.coveragePct ? grid.coveragePct[i] : null,
            meanAreaM2: grid.meanAreaM2 ? grid.meanAreaM2[i] : null,
            res_m: grid.res_m,
            source: grid.source || 'ml_footprints',
        };
    }

    /** Load the grid JSON once (best-effort). Resolves to the grid or null. */
    function load(url = DEFAULT_URL) {
        if (_loaded) return Promise.resolve(_grid);
        if (_loading) return _loading;
        _loading = (async () => {
            try {
                if (typeof fetch === 'undefined') { _loaded = true; return null; }
                const r = await fetch(url, { cache: 'force-cache' });
                if (!r.ok) { _loaded = true; return null; }
                _grid = await r.json();
            } catch { _grid = null; }
            _loaded = true;
            return _grid;
        })();
        return _loading;
    }

    /** Load (if needed) then sample the grid at a lat/lng; null when unavailable. */
    async function sampleAt(lat, lng, url) {
        const g = await load(url);
        return g ? sample(g, lat, lng) : null;
    }

    return { load, sample, sampleAt, indexFor };
})();

if (typeof window !== 'undefined') window.FootprintGrid = FootprintGrid;
