/**
 * AccessibilityOverlay — service-area / accessibility coverage (map type #1).
 *
 * For a chosen amenity (hospitals, schools, …) it grid-samples the viewport,
 * finds that amenity's POIs around each cell (real coordinates from the OSM
 * feature items), measures the straight-line distance to the NEAREST one, and
 * classifies each cell into coverage bands — surfacing underserved "gaps", not
 * just where amenities are dense. This is the complement to the isochrone tool:
 * isochrone shows reach FROM a point; this shows coverage gaps ACROSS an area.
 *
 * haversineM / nearestDistanceM / accessClass are pure and unit-tested. Sampling
 * reuses the coalesced fetchAllFeatures + per-run AbortController ownership.
 */
const AccessibilityOverlay = (() => {
    const SOURCE_ID = 'access-overlay-source';
    const LAYER_ID  = 'access-overlay-layer';
    const LEGEND_ID = 'access-legend';
    const SAMPLE_RADIUS_M = 1000;   // fetch POIs up to 1 km so "gap" means >1 km

    const AMENITY_OPTIONS = [
        { key: 'hospitals', label: 'Hospitals' },
        { key: 'clinics', label: 'Clinics & Doctors' },
        { key: 'schools', label: 'Schools' },
        { key: 'colleges', label: 'Colleges' },
        { key: 'parks', label: 'Parks' },
        { key: 'police', label: 'Police' },
        { key: 'fire', label: 'Fire Stations' },
    ];

    // RdYlGn coverage bands. The legend carries text labels, so colour is not
    // the only channel (WCAG 1.4.1).
    const BANDS = [
        { max: 300,      level: 'Excellent', color: '#1a9850', hint: '<300 m' },
        { max: 600,      level: 'Good',      color: '#91cf60', hint: '<600 m' },
        { max: 1000,     level: 'Fair',      color: '#fee08b', hint: '<1 km'  },
        { max: Infinity, level: 'Gap',       color: '#d73027', hint: '>1 km'  },
    ];

    let _map = null;
    let _active = false;
    let _abort = null;
    let _amenity = 'hospitals';

    // ---------- pure helpers ----------
    /** Great-circle distance in metres. */
    function haversineM(aLat, aLng, bLat, bLng) {
        const R = 6371000;
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

    /** Classify a nearest-facility distance into a coverage band. */
    function accessClass(distM) {
        for (const b of BANDS) if (distM <= b.max) return b;
        return BANDS[BANDS.length - 1];
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

    function _labelFor(key) {
        return (AMENITY_OPTIONS.find(o => o.key === key) || {}).label || key;
    }

    function _ensureLayer() {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            _map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55, 'fill-outline-color': 'rgba(255,255,255,0.25)' },
            });
        }
    }

    async function _sample() {
        if (_abort) _abort.abort();
        const myAbort = new AbortController();
        _abort = myAbort;
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
            App.showToast('Accessibility', `Mapping coverage of ${_labelFor(_amenity)}…`, 'info');
        }

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
                const band = accessClass(dist);
                myFeatures.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
                            [pt.lng + pt.lngStep / 2, pt.lat - pt.latStep / 2],
                            [pt.lng + pt.lngStep / 2, pt.lat + pt.latStep / 2],
                            [pt.lng - pt.lngStep / 2, pt.lat + pt.latStep / 2],
                            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
                        ]],
                    },
                    properties: { color: band.color, level: band.level, dist: Number.isFinite(dist) ? Math.round(dist) : null },
                });
                addedNew = true;
            });
            if (addedNew && !myAbort.signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: myFeatures });
            }
            if (batch + 6 < points.length) await new Promise(r => setTimeout(r, 200));
        }
    }

    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Accessibility coverage legend and amenity selector');
            el.style.cssText = 'position:absolute;bottom:24px;left:24px;z-index:5;background:rgba(10,14,39,0.92);'
                + 'border:1px solid rgba(0,245,255,0.25);border-radius:10px;padding:10px 12px;color:#cfe;'
                + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.4);';
            document.body.appendChild(el);
        }
        const opts = AMENITY_OPTIONS.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
        const rows = BANDS.map(b => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:14px;height:14px;border-radius:3px;background:${b.color};"></span>`
            + `<span>${b.level} <span style="color:#9bd;">${b.hint}</span></span></div>`).join('');
        el.innerHTML = `
            <div style="font-weight:600;margin-bottom:6px;color:#00f5ff;">Accessibility</div>
            <label style="display:block;margin-bottom:8px;">Amenity
                <select id="access-sel" style="background:#0a0e27;color:#cfe;border:1px solid #245;border-radius:4px;">${opts}</select>
            </label>
            ${rows}`;
        el.querySelector('#access-sel').value = _amenity;
        el.querySelector('#access-sel').onchange = (e) => {
            _amenity = e.target.value;
            if (_map.getSource(SOURCE_ID)) _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
            _renderLegend();
            _sample();
        };
    }
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _ensureLayer();
        _renderLegend();
        _sample();
    }

    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        _removeLegend();
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
    }

    function toggle() { if (_active) detach(); else attach(); }

    return {
        attach, detach, toggle,
        haversineM, nearestDistanceM, accessClass,
        getAmenityOptions: () => AMENITY_OPTIONS.slice(),
    };
})();

if (typeof window !== 'undefined') window.AccessibilityOverlay = AccessibilityOverlay;
