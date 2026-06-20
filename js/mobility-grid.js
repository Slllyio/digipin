/**
 * MobilityGrid — samples the precomputed per-cell mobility-risk grid
 * (data/safety/<region>/mobility_grid.json, from pipeline/safety/mobility.py) so
 * the cell panel can show law-and-order access resilience without a network call.
 *
 * Same contract as traffic-grid.js / footprint-grid.js: a small row-major grid
 * loaded once (best-effort), sampled by lat/lng; null outside the network or when
 * the file is absent. indexFor/sample are pure and unit-tested.
 */
const MobilityGrid = (() => {
    const DEFAULT_URL = './data/safety/indore_pilot/mobility_grid.json';
    const _grids = new Map();    // url -> parsed grid (cached on success only)
    const _loading = new Map();  // url -> in-flight promise

    /** Row-major cell index for a lat/lng, or -1 when outside the grid bounds. */
    function indexFor(grid, lat, lng) {
        if (!grid || !grid.bounds) return -1;
        const b = grid.bounds;
        if (lng < b.west || lng >= b.east || lat < b.south || lat >= b.north) return -1;
        const x = Math.min(grid.nx - 1, Math.floor((lng - b.west) / (b.east - b.west) * grid.nx));
        const y = Math.min(grid.ny - 1, Math.floor((b.north - lat) / (b.north - b.south) * grid.ny));
        return y * grid.nx + x;
    }

    /** Per-cell mobility record, or null outside the scored network. */
    function sample(grid, lat, lng) {
        const i = indexFor(grid, lat, lng);
        if (i < 0) return null;
        const risk = grid.mobility_risk ? grid.mobility_risk[i] : null;
        const cls = grid.access_class ? grid.access_class[i] : null;
        if (risk == null && cls == null) return null;     // unscored (no road) cell
        return {
            mobility_risk: risk,
            access_class: cls,
            sealable: !!(grid.sealable && grid.sealable[i]),
            on_chokepoint: !!(grid.on_chokepoint && grid.on_chokepoint[i]),
            nearest_police_km: grid.nearest_police_km ? grid.nearest_police_km[i] : null,
            source: grid.source || 'osm_seal_pockets_chokepoints',
        };
    }

    /** Load the grid JSON once (best-effort). Resolves to the grid or null;
     *  a failed/empty load is left retryable. */
    function load(url = DEFAULT_URL) {
        if (_grids.has(url)) return Promise.resolve(_grids.get(url));
        if (_loading.has(url)) return _loading.get(url);
        const p = (async () => {
            try {
                if (typeof fetch === 'undefined') return null;
                const r = await fetch(url, { cache: 'force-cache' });
                if (!r.ok) return null;
                const grid = await r.json();
                _grids.set(url, grid);          // cache only on success
                return grid;
            } catch {
                return null;
            } finally {
                _loading.delete(url);           // let a failed/empty load be retried
            }
        })();
        _loading.set(url, p);
        return p;
    }

    /** Load (if needed) then sample the grid at a lat/lng; null when unavailable. */
    async function sampleAt(lat, lng, url) {
        const g = await load(url);
        return g ? sample(g, lat, lng) : null;
    }

    return { load, sample, sampleAt, indexFor };
})();

if (typeof window !== 'undefined') window.MobilityGrid = MobilityGrid;
