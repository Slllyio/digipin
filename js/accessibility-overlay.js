/**
 * AccessibilityOverlay — "15-minute city" coverage map (map type #1).
 *
 * For a chosen amenity (hospitals, schools, …) it grid-samples the viewport,
 * finds that amenity's POIs around each cell (real coordinates from the OSM
 * feature items) and classifies each cell by how long it takes to WALK to the
 * nearest one — surfacing underserved "gaps", not just where amenities are
 * dense. This is the complement to the isochrone tool: isochrone shows reach
 * FROM a point; this shows coverage gaps ACROSS an area.
 *
 * Travel time is measured two ways, best-effort:
 *   1. A network-distance estimate (straight-line × detour factor ÷ walk speed)
 *      paints instantly so the user gets immediate feedback.
 *   2. A real foot-walking travel-time matrix from OpenRouteService then
 *      refines every cell. Straight-line buffers OVERESTIMATE real access
 *      because they ignore street connectivity, rivers and detours, so the
 *      network pass is the source of truth; the estimate is a labelled
 *      fallback used only when the network call is unavailable.
 *
 * haversineM / nearestDistanceM / accessClass (legacy distance bands) and the
 * network helpers detourEstimateS / nearestDurationS / accessClassTime are pure
 * and unit-tested. Sampling reuses the coalesced fetchAllFeatures + per-run
 * AbortController ownership.
 */
const AccessibilityOverlay = (() => {
    const SOURCE_ID = 'access-overlay-source';
    const LAYER_ID  = 'access-overlay-layer';
    const LEGEND_ID = 'access-legend';
    const SAMPLE_RADIUS_M = 1000;   // fetch POIs up to 1 km so "gap" means a long walk

    // OpenRouteService foot-walking travel-time matrix. The key is read from
    // window.DIGIPIN_CONFIG.orsKey at deploy time (so operators inject their own
    // rather than shipping a shared one); the bundled free-tier key is only a
    // fallback, and a 403/timeout degrades gracefully to the detour estimate.
    const MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/foot-walking';
    const ORS_KEY_FALLBACK = '5b3ce3597851110001cf62487c0ef84637174f6f9f20656e6c0d8d8a';
    /** OpenRouteService API key: operator-injected config key, else the bundled fallback. */
    function _orsKey() {
        return (typeof window !== 'undefined' && window.DIGIPIN_CONFIG && window.DIGIPIN_CONFIG.orsKey)
            || ORS_KEY_FALLBACK;
    }
    const MATRIX_TIMEOUT_MS = 15000;
    const WALK_SPEED_MPS = 1.4;     // ≈5 km/h, ORS foot-walking default
    const DETOUR_FACTOR  = 1.3;     // street circuity: real path > straight line
    const NEAREST_K = 4;            // candidate amenities kept per cell for the matrix
    const MAX_DESTINATIONS = 60;    // 36 sources × 60 dests = 2160 ≤ ORS 2500-route cap

    const AMENITY_OPTIONS = [
        { key: 'hospitals', label: 'Hospitals' },
        { key: 'clinics', label: 'Clinics & Doctors' },
        { key: 'schools', label: 'Schools' },
        { key: 'colleges', label: 'Colleges' },
        { key: 'parks', label: 'Parks' },
        { key: 'police', label: 'Police' },
        { key: 'fire', label: 'Fire Stations' },
    ];

    // Walking-time bands (RdYlGn). The legend carries text labels, so colour is
    // not the only channel (WCAG 1.4.1). Index order is shared with
    // Theme.scale('accessibility') (green → red, 4 entries).
    const BANDS = [
        { maxSec: 300,      level: 'Excellent', color: '#1a9850', hint: '≤5 min'  },
        { maxSec: 600,      level: 'Good',      color: '#91cf60', hint: '≤10 min' },
        { maxSec: 900,      level: 'Fair',      color: '#fee08b', hint: '≤15 min' },
        { maxSec: Infinity, level: 'Gap',       color: '#d73027', hint: '>15 min' },
    ];

    // Legacy straight-line distance bands — retained as a tested pure utility.
    const DIST_BANDS = [
        { max: 300,      level: 'Excellent', color: '#1a9850', hint: '<300 m' },
        { max: 600,      level: 'Good',      color: '#91cf60', hint: '<600 m' },
        { max: 1000,     level: 'Fair',      color: '#fee08b', hint: '<1 km'  },
        { max: Infinity, level: 'Gap',       color: '#d73027', hint: '>1 km'  },
    ];

    let _map = null;
    let _active = false;
    let _abort = null;
    let _amenity = 'hospitals';
    let _measured = false;   // true once the network matrix has refined the view

    // ---------- pure helpers ----------
    /** Great-circle distance in metres. */
    function haversineM(aLat, aLng, bLat, bLng) {
        const R = 6371000;
        /** Convert degrees to radians. */
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(bLat - aLat);
        const dLng = toRad(bLng - aLng);
        const s = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    /** Nearest distance (m) from (lat,lng) to any item with finite coords.
     *  Returns Infinity when there are no usable items. */
    function nearestDistanceM(lat, lng, items) {
        let best = Infinity;
        for (const it of (items || [])) {
            const ilat = it.lat, ilng = it.lng;
            if (!Number.isFinite(ilat) || !Number.isFinite(ilng)) continue;
            const d = haversineM(lat, lng, ilat, ilng);
            if (d < best) best = d;
        }
        return best;
    }

    /** Legacy: classify a straight-line distance (m) into a coverage band. */
    function accessClass(distM) {
        for (const b of DIST_BANDS) if (distM <= b.max) return b;
        return DIST_BANDS[DIST_BANDS.length - 1];
    }

    /** Estimated foot-walking time (s) from a straight-line distance, inflating
     *  by a detour factor because the real network path is longer than the
     *  crow-flies line. Infinity in → Infinity out. */
    function detourEstimateS(distM, speedMps = WALK_SPEED_MPS, factor = DETOUR_FACTOR) {
        if (!Number.isFinite(distM)) return Infinity;
        if (!(speedMps > 0)) return Infinity;
        return (distM * factor) / speedMps;
    }

    /** Smallest finite travel time (s) in a matrix duration row (the nearest
     *  reachable destination). Returns Infinity when none are reachable. */
    function nearestDurationS(durations) {
        let best = Infinity;
        for (const d of (durations || [])) {
            if (Number.isFinite(d) && d < best) best = d;
        }
        return best;
    }

    /** Classify a walking time (s) into a 5/10/15-minute coverage band. */
    function accessClassTime(sec) {
        for (const b of BANDS) if (sec <= b.maxSec) return b;
        return BANDS[BANDS.length - 1];
    }

    /** Per-theme band colour (light deepens the pale yellow/green for Positron). */
    function _bandColor(band) {
        const cols = (typeof Theme !== 'undefined' && Theme.scale && Theme.scale('accessibility'));
        return cols ? cols[BANDS.indexOf(band)] : band.color;
    }

    /** Pull a feature key's items from any category of a fetchAllFeatures result. */
    function _amenityItems(data, key) {
        const cats = data && data.categories;
        if (!cats) return [];
        for (const catKey of Object.keys(cats)) {
            const feat = cats[catKey].features && cats[catKey].features[key];
            if (feat && Array.isArray(feat.items)) return feat.items;
        }
        return [];
    }

    /** Human-readable label for an amenity key (falls back to the key itself). */
    function _labelFor(key) {
        return (AMENITY_OPTIONS.find(o => o.key === key) || {}).label || key;
    }

    /** Add the source + fill layer once (idempotent). */
    function _ensureLayer() {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            _map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'],
                    'fill-opacity': (typeof Theme !== 'undefined' && Theme.get() === 'light') ? 0.7 : 0.55,
                    'fill-outline-color': (typeof Theme !== 'undefined') ? Theme.fg(0.25) : 'rgba(255,255,255,0.25)' },
            });
        }
    }

    /** Build a square polygon ring centred on a sample point. */
    function _cellRing(pt) {
        return [[
            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
            [pt.lng + pt.lngStep / 2, pt.lat - pt.latStep / 2],
            [pt.lng + pt.lngStep / 2, pt.lat + pt.latStep / 2],
            [pt.lng - pt.lngStep / 2, pt.lat + pt.latStep / 2],
            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
        ]];
    }

    /** Feature for one sampled cell from a travel time (s) and whether it was
     *  network-measured (vs estimated). */
    function _cellFeature(pt, sec, measured) {
        const band = accessClassTime(sec);
        return {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: _cellRing(pt) },
            properties: {
                color: _bandColor(band),
                level: band.level,
                minutes: Number.isFinite(sec) ? Math.round(sec / 60) : null,
                measured: !!measured,
            },
        };
    }

    /** Deduplicate POIs by rounded coordinate and cap to MAX_DESTINATIONS,
     *  keeping those closest to any sampled cell. */
    function _candidateDestinations(cells) {
        const seen = new Map();   // "lat,lng" -> { lng, lat, best }
        for (const c of cells) {
            const items = (c.items || [])
                .filter(it => Number.isFinite(it.lat) && Number.isFinite(it.lng))
                .map(it => ({ it, d: haversineM(c.lat, c.lng, it.lat, it.lng) }))
                .sort((a, b) => a.d - b.d)
                .slice(0, NEAREST_K);
            for (const { it, d } of items) {
                const key = `${it.lat.toFixed(5)},${it.lng.toFixed(5)}`;
                const prev = seen.get(key);
                if (!prev) seen.set(key, { lng: it.lng, lat: it.lat, best: d });
                else if (d < prev.best) prev.best = d;
            }
        }
        return [...seen.values()]
            .sort((a, b) => a.best - b.best)
            .slice(0, MAX_DESTINATIONS)
            .map(p => [p.lng, p.lat]);
    }

    /** One foot-walking travel-time matrix call. Returns durations[srcIdx][destIdx]
     *  in seconds, or null on any failure (caller keeps the estimate). */
    async function _fetchMatrix(sources, destinations, signal) {
        const locations = [...sources, ...destinations];
        const srcIdx = sources.map((_, i) => i);
        const dstIdx = destinations.map((_, i) => sources.length + i);
        // Cap the wait so an unresponsive ORS can't hang the overlay; combine
        // with the caller's abort signal when AbortSignal.any is available.
        let fetchSignal = signal;
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            const timeout = AbortSignal.timeout(MATRIX_TIMEOUT_MS);
            fetchSignal = (signal && AbortSignal.any) ? AbortSignal.any([signal, timeout]) : timeout;
        }
        const resp = await fetch(MATRIX_URL, {
            method: 'POST',
            signal: fetchSignal,
            headers: { 'Content-Type': 'application/json', 'Authorization': _orsKey() },
            body: JSON.stringify({
                locations,
                sources: srcIdx,
                destinations: dstIdx,
                metrics: ['duration'],
            }),
        });
        if (!resp.ok) throw new Error(`ORS matrix ${resp.status}`);
        const data = await resp.json();
        return data && Array.isArray(data.durations) ? data.durations : null;
    }

    /** Grid-sample the viewport: paint instant straight-line estimates, then refine with the ORS walking matrix. */
    async function _sample() {
        if (_abort) _abort.abort();
        const myAbort = new AbortController();
        _abort = myAbort;
        _measured = false;
        const cells = [];        // { pt, lat, lng, items }
        const myFeatures = [];

        const bounds = _map.getBounds();
        const south = bounds.getSouth(), north = bounds.getNorth();
        const west = bounds.getWest(), east = bounds.getEast();
        const gridSize = 6;
        const latStep = (north - south) / gridSize;
        const lngStep = (east - west) / gridSize;

        const points = [];
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({ lat: south + latStep * (i + 0.5), lng: west + lngStep * (j + 0.5), latStep, lngStep });
            }
        }

        if (typeof App !== 'undefined') {
            App.showToast('15-minute city', `Mapping walking access to ${_labelFor(_amenity)}…`, 'info');
        }

        // Phase 1 — instant straight-line estimate (also the fallback).
        for (let batch = 0; batch < points.length; batch += 6) {
            if (myAbort.signal.aborted) return;
            const chunk = points.slice(batch, batch + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, SAMPLE_RADIUS_M))
            );
            let addedNew = false;
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || myAbort.signal.aborted) return;
                const pt = chunk[idx];
                const items = _amenityItems(r.value, _amenity);
                const dist = nearestDistanceM(pt.lat, pt.lng, items);
                cells.push({ pt, lat: pt.lat, lng: pt.lng, items });
                myFeatures.push(_cellFeature(pt, detourEstimateS(dist), false));
                addedNew = true;
            });
            if (addedNew && !myAbort.signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: myFeatures });
            }
            if (batch + 6 < points.length) await new Promise(r => setTimeout(r, 200));
        }

        if (myAbort.signal.aborted) return;

        // Phase 2 — refine with the real foot-walking network matrix.
        const destinations = _candidateDestinations(cells);
        if (destinations.length === 0) { _renderLegend(); return; }
        try {
            const sources = cells.map(c => [c.lng, c.lat]);
            const durations = await _fetchMatrix(sources, destinations, myAbort.signal);
            if (myAbort.signal.aborted || !durations) { _renderLegend(); return; }
            const refined = cells.map((c, i) => {
                const sec = nearestDurationS(durations[i]);
                // Keep the estimate for an unreachable row rather than flipping it to "Gap".
                if (!Number.isFinite(sec)) {
                    return _cellFeature(c.pt, detourEstimateS(nearestDistanceM(c.lat, c.lng, c.items)), false);
                }
                return _cellFeature(c.pt, sec, true);
            });
            if (!myAbort.signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: refined });
                _measured = true;
                _renderLegend();
                if (typeof App !== 'undefined') {
                    App.showToast('15-minute city', 'Refined with real walking routes', 'success');
                }
            }
        } catch (err) {
            // Network unavailable / rate-limited — keep the labelled estimate.
            if (!myAbort.signal.aborted) {
                _renderLegend();
                if (typeof App !== 'undefined') {
                    App.showToast('15-minute city', 'Showing walking-time estimate (routing unavailable)', 'info');
                }
            }
        }
    }

    /** Theme palette, with a dark-mode fallback when Theme is unavailable. */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', sub: '#9bd', ink: '#cfe', surface: 'rgba(10,14,39,0.92)', surfaceSolid: '#0a0e27', border: 'rgba(255,255,255,0.12)' };
    }
    /** Create or refresh the legend: amenity selector, walking-time bands, and data-source note. */
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', '15-minute city walking-access legend and amenity selector');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:10px 12px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const sel = `background:${pal.surfaceSolid};color:${pal.ink};border:1px solid ${pal.border};border-radius:4px;`;
        const opts = AMENITY_OPTIONS.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
        const rows = BANDS.map(b => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:14px;height:14px;border-radius:3px;background:${_bandColor(b)};"></span>`
            + `<span>${b.level} <span style="color:${pal.sub};">${b.hint} walk</span></span></div>`).join('');
        const mode = _measured
            ? 'Real foot-walking routes (OpenRouteService)'
            : 'Straight-line estimate (×1.3 detour)';
        // Aino editorial serif for the title on the paper-light theme.
        const titleFont = (typeof Theme !== 'undefined' && Theme.get() === 'light')
            ? "'Newsreader', Georgia, serif" : 'inherit';
        el.innerHTML = `
            <div style="font-family:${titleFont};font-weight:600;font-size:15px;margin-bottom:6px;color:${pal.primary};">15-minute city</div>
            <label style="display:block;margin-bottom:8px;">Amenity
                <select id="access-sel" style="${sel}">${opts}</select>
            </label>
            ${rows}
            <div style="margin-top:6px;color:${pal.sub};font-size:11px;">${mode}</div>`;
        el.querySelector('#access-sel').value = _amenity;
        el.querySelector('#access-sel').onchange = (e) => {
            _amenity = e.target.value;
            if (_map.getSource(SOURCE_ID)) _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
            _renderLegend();
            _sample();
        };
    }
    /** Remove the legend element if present. */
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    /** Activate the overlay: bind the map, ensure the layer, render the legend, and sample the viewport. */
    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _ensureLayer();
        _renderLegend();
        _sample();
    }

    /** Deactivate the overlay: abort fetches, drop the legend, and remove the layer/source. */
    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        _removeLegend();
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
    }

    /** Toggle the overlay on/off. */
    function toggle() { if (_active) detach(); else attach(); }

    return {
        attach, detach, toggle,
        haversineM, nearestDistanceM, accessClass,
        detourEstimateS, nearestDurationS, accessClassTime,
        getAmenityOptions: () => AMENITY_OPTIONS.slice(),
    };
})();

if (typeof window !== 'undefined') window.AccessibilityOverlay = AccessibilityOverlay;
