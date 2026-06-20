/**
 * Utilities — per-cell utility & infrastructure readings for the cell panel.
 *
 * Seven honestly-sourced layers, each badged with its provenance:
 *   1. Sound (noise) pollution   — modeled, from the quietness score
 *   2. Ground water level        — regional reference (CGWB), pilot only
 *   3. Sewer lines               — OSM man_made=pipeline[substance=sewage] + manholes
 *   4. Water pipelines           — OSM man_made=pipeline[substance=water] + works/towers
 *   5. Gas connection (PNG)      — regional reference (PNGRB CGD) + OSM gas pipelines
 *   6. Ground water quality      — regional reference (CGWB)
 *   7. Electricity connection    — OSM power=cable (underground) vs line/minor_line (overhead)
 *
 * Infrastructure (3,4,5-pipes,7) is derived from the OSM elements the cell
 * already fetches (data-fetcher's Overpass call queries `power` + pipelines),
 * so there is no extra network round-trip. The regional items (2,5,6) come from
 * a small bundled reference because no per-cell open API exists for them.
 *
 * `assess()` is pure and unit-tested; `loadReference()` is best-effort (null on
 * failure). See docs/UTILITIES_MODEL.md.
 */
const Utilities = (() => {
    const REF_URL = './data/utilities/indore_pilot/reference.json';
    let _ref = null;
    let _refLoaded = false;
    let _refLoading = null;

    /** Best-effort load of the bundled regional reference; null when absent.
     *  A failed/empty load is left retryable (mirrors the grid loaders). */
    function loadReference(url = REF_URL) {
        if (_refLoaded) return Promise.resolve(_ref);
        if (_refLoading) return _refLoading;
        _refLoading = (async () => {
            try {
                if (typeof fetch === 'undefined') return null;
                const r = await fetch(url, { cache: 'force-cache' });
                if (!r.ok) return null;
                _ref = await r.json();
                _refLoaded = true;
                return _ref;
            } catch {
                return null;
            } finally {
                _refLoading = null;
            }
        })();
        return _refLoading;
    }

    /** Great-circle distance in metres between two lat/lng points. Pure. */
    function _haversineM(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Best-effort [lat, lng] for an Overpass element (node coords or way/relation center). */
    function _coords(el) {
        if (typeof el.lat === 'number' && typeof el.lon === 'number') return [el.lat, el.lon];
        if (el.center && typeof el.center.lat === 'number') return [el.center.lat, el.center.lon];
        return null;
    }

    /** True if (lat,lng) sits inside the reference region's bounds. Pure. */
    function regionHas(ref, lat, lng) {
        const b = ref && ref.bounds;
        if (!b) return false;
        return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
    }

    /** Map a 0–100 quietness score to a noise reading (higher quietness = quieter). Pure. */
    function noiseFromQuietness(quietness) {
        if (quietness == null || Number.isNaN(quietness)) return null;
        const noise = Math.max(0, Math.min(100, 100 - quietness));
        let band, status;
        if (noise <= 25) { band = '~<50 dB'; status = 'good'; }
        else if (noise <= 50) { band = '~50–60 dB'; status = 'moderate'; }
        else if (noise <= 70) { band = '~60–70 dB'; status = 'elevated'; }
        else { band = '>70 dB'; status = 'high'; }
        return { value: Math.round(noise), band, status, source: 'modeled (road/land-use)' };
    }

    /** Collect count + nearest-distance for OSM elements passing `pred`. Pure. */
    function _gather(elements, lat, lng, pred) {
        let count = 0;
        let nearest = null;
        for (const el of elements) {
            const tags = el.tags || {};
            if (!pred(tags)) continue;
            count++;
            const c = _coords(el);
            if (c) {
                const d = _haversineM(lat, lng, c[0], c[1]);
                if (nearest == null || d < nearest) nearest = Math.round(d);
            }
        }
        return { count, nearest_m: nearest };
    }

    const _sub = (tags) => (tags.substance || tags.content || '').toLowerCase();

    /** Derive the electricity-connection reading from OSM power elements. Pure. */
    function _electricity(elements, lat, lng, ref) {
        let overhead = 0, underground = 0, substations = 0, transformers = 0;
        let nearestSub = null;
        for (const el of elements) {
            const p = (el.tags || {}).power;
            if (!p) continue;
            if (p === 'line' || p === 'minor_line') overhead++;
            else if (p === 'cable') underground++;
            else if (p === 'substation') {
                substations++;
                const c = _coords(el);
                if (c) {
                    const d = _haversineM(lat, lng, c[0], c[1]);
                    if (nearestSub == null || d < nearestSub) nearestSub = Math.round(d);
                }
            } else if (p === 'transformer') transformers++;
        }
        let type;
        if (underground > 0 && overhead > 0) type = 'mixed';
        else if (underground > 0) type = 'underground';
        else if (overhead > 0) type = 'overhead';
        else if (substations > 0 || transformers > 0) type = 'overhead';
        else type = 'unknown';
        const operator = ref && ref.electricity ? ref.electricity.operator : null;
        return {
            type, overhead, underground, substations, transformers,
            nearest_substation_m: nearestSub,
            operator,
            source: type === 'unknown' && ref && ref.electricity
                ? (ref.electricity.source || 'regional')
                : 'OSM power network',
        };
    }

    /**
     * Build the per-cell utilities object. Pure — combines already-fetched OSM
     * `elements`, the regional `ref` (or null), and an optional quietness score.
     */
    function assess(elements, ref, opts = {}) {
        const els = Array.isArray(elements) ? elements : [];
        const { lat, lng, quietnessScore } = opts;
        const inRegion = ref ? regionHas(ref, lat, lng) : false;

        const sewer = _gather(els, lat, lng, (t) =>
            (t.man_made === 'pipeline' && /sewage|sewerage|wastewater/.test(_sub(t)))
            || t.man_made === 'manhole' || t.man_made === 'wastewater_plant');
        const water = _gather(els, lat, lng, (t) =>
            (t.man_made === 'pipeline' && /water/.test(_sub(t)))
            || ['water_works', 'water_well', 'reservoir_covered', 'water_tower'].includes(t.man_made)
            || t.amenity === 'drinking_water');
        const gasPipes = _gather(els, lat, lng, (t) =>
            (t.man_made === 'pipeline' && /gas|cng|lpg/.test(_sub(t))) || t.man_made === 'gasometer');

        const gas = inRegion && ref.gas_png
            ? { ...ref.gas_png, mapped_pipelines: gasPipes.count }
            : (gasPipes.count > 0
                ? { available: true, operator: null, mapped_pipelines: gasPipes.count,
                    note: 'Gas pipeline infrastructure mapped nearby.', source: 'OSM' }
                : null);

        return {
            noise: noiseFromQuietness(quietnessScore),
            groundwater_level: inRegion ? ref.groundwater_level : null,
            groundwater_quality: inRegion ? ref.groundwater_quality : null,
            sewer: { ...sewer, source: 'OSM (sparse coverage)' },
            water: { ...water, source: 'OSM (sparse coverage)' },
            gas_png: gas,
            electricity: _electricity(els, lat, lng, ref),
            region: inRegion ? (ref.region || null) : null,
        };
    }

    return { loadReference, assess, regionHas, noiseFromQuietness, _haversineM };
})();

if (typeof window !== 'undefined') window.Utilities = Utilities;
