/**
 * TrafficGrid — samples the precomputed per-cell traffic grid
 * (data/traffic/<region>/traffic_grid.json, from pipeline/traffic/traffic_grid.py
 * + gtfs_transit.py) so the cell panel can show local congestion + transit access
 * without any per-click network call.
 *
 * Same shape/contract as js/footprint-grid.js: a small row-major grid loaded once
 * (best-effort) and sampled by lat/lng; when the file isn't present sampleAt
 * returns null and callers fall back gracefully. indexFor/sample are pure and
 * unit-tested.
 */
const TrafficGrid = (() => {
    const DEFAULT_URL = './data/traffic/indore_pilot/traffic_grid.json';
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

    /** Per-cell traffic record, or null when outside the grid. Transit fields are
     *  present only when the GTFS step ran. */
    function sample(grid, lat, lng) {
        const i = indexFor(grid, lat, lng);
        if (i < 0) return null;
        const at = (arr) => (arr && arr[i] != null) ? arr[i] : null;
        return {
            congestion_risk: at(grid.congestion_risk),
            los_grade: at(grid.worst_los),
            dominant_class: at(grid.dominant_class),
            road_density_m: at(grid.road_density_m),
            has_critical_link: !!at(grid.has_critical_link),
            betweenness_max: at(grid.betweenness_max),
            transit_stops: at(grid.transit_stops),
            transit_routes: at(grid.transit_routes),
            transit_headway_min: at(grid.transit_headway_min),
            transit_access: at(grid.transit_access),
            transit_source: grid.transit_source || null,
            res_m: grid.res_m,
            source: grid.source || 'osm_betweenness_los',
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

    async function sampleAt(lat, lng, url) {
        const g = await load(url);
        return g ? sample(g, lat, lng) : null;
    }

    return { load, sample, sampleAt, indexFor };
})();

if (typeof window !== 'undefined') window.TrafficGrid = TrafficGrid;
