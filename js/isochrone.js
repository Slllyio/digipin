/**
 * Isochrone / Walkability rings — "how far can I walk from here".
 *
 * Draws 5 / 10 / 15-minute walking zones around a point as soft concentric
 * rings (the 15-minute-city view). It is fully self-contained — no API key, no
 * network call — so it always works in the browser. The previous build relied
 * on a shared OpenRouteService key that has since been disabled (HTTP 403),
 * which is why the rings stopped appearing.
 *
 * The radius for each band is the crow-flies distance you can realistically
 * cover on foot in that time: walking speed ÷ a detour factor (streets are
 * never straight). This matches the detour model used by AccessibilityOverlay,
 * so the two tools tell a consistent story.
 */
const Isochrone = (() => {
    const WALK_SPEED_MPM = 80;   // ≈4.8 km/h, the 15-minute-city planning speed
    const DETOUR_FACTOR  = 1.3;  // real street path is longer than the straight line

    let _active = false;
    let _map = null;
    let _popup = null;

    const SOURCE_ID = 'isochrone-source';
    const FILL_LAYER = 'isochrone-fill';
    const LINE_LAYER = 'isochrone-line';
    const POINT_SOURCE = 'isochrone-point-source';
    const POINT_LAYER = 'isochrone-point';
    const LEGEND_ID = 'isochrone-legend';

    // Aino-style soft concentric bands (deep coral core → pale outer reach).
    const PRESETS = [
        { minutes: 5,  color: '#dd6b4a', label: '5 min walk'  },
        { minutes: 10, color: '#e8a06a', label: '10 min walk' },
        { minutes: 15, color: '#cbb8a8', label: '15 min walk' },
    ];

    /** Crow-flies radius (m) reachable on foot in `minutes`, after the detour penalty. */
    function radiusM(minutes) {
        return (WALK_SPEED_MPM * minutes) / DETOUR_FACTOR;
    }

    /** Geodesic circle polygon ([lng,lat] ring) of `rM` metres around (lat,lng). */
    function circle(lat, lng, rM, steps = 72) {
        const coords = [];
        const R = 6371000;
        const latR = lat * Math.PI / 180;
        for (let i = 0; i <= steps; i++) {
            const brng = (i / steps) * 2 * Math.PI;
            const dLat = (rM * Math.cos(brng)) / R;
            const dLng = (rM * Math.sin(brng)) / (R * Math.cos(latR));
            coords.push([lng + dLng * 180 / Math.PI, lat + dLat * 180 / Math.PI]);
        }
        return coords;
    }

    /**
     * Show walking-radius rings for a given lat/lng. Synchronous and offline —
     * no provider can fail it.
     */
    function show(lat, lng) {
        _active = true;
        _map = MapModule.getMap();
        clear(false);

        // Largest band first so the smaller, deeper bands paint on top.
        const features = PRESETS.slice().reverse().map((preset) => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [circle(lat, lng, radiusM(preset.minutes))] },
            properties: { color: preset.color, label: preset.label,
                radius: Math.round(radiusM(preset.minutes)) },
        }));

        const geojson = { type: 'FeatureCollection', features };
        const pointGeojson = {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] } }],
        };

        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
            _map.addLayer({
                id: FILL_LAYER, type: 'fill', source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 },
            });
            _map.addLayer({
                id: LINE_LAYER, type: 'line', source: SOURCE_ID,
                paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [3, 2] },
            });

            _map.on('click', FILL_LAYER, (e) => {
                const props = e.features[0].properties;
                // Props are app-generated, but escape anyway for setHTML safety.
                /** HTML-escape a value for safe interpolation into popup markup. */
                const esc = (v) => String(v == null ? '' : v)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                if (_popup) _popup.remove();
                _popup = new maplibregl.Popup()
                    .setLngLat(e.lngLat)
                    .setHTML(`<div style="font-family:Inter,sans-serif;font-weight:600;">${esc(props.label)}</div>`
                        + `<div style="font-size:11px;opacity:0.7;">~${esc(props.radius)} m reach</div>`)
                    .addTo(_map);
            });
            _map.on('mouseenter', FILL_LAYER, () => { _map.getCanvas().style.cursor = 'pointer'; });
            _map.on('mouseleave', FILL_LAYER, () => { _map.getCanvas().style.cursor = ''; });
        } else {
            _map.getSource(SOURCE_ID).setData(geojson);
        }

        if (!_map.getSource(POINT_SOURCE)) {
            _map.addSource(POINT_SOURCE, { type: 'geojson', data: pointGeojson });
            _map.addLayer({
                id: POINT_LAYER, type: 'circle', source: POINT_SOURCE,
                paint: { 'circle-radius': 5, 'circle-color': '#dd6b4a',
                    'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
            });
        } else {
            _map.getSource(POINT_SOURCE).setData(pointGeojson);
        }

        _renderLegend();
        if (typeof App !== 'undefined') {
            App.showToast('15-minute city', 'Showing 5 / 10 / 15-min walking zones', 'success');
        }
    }

    /** Aino-style legend card: coral serif title + the three walking-band chips. */
    function _renderLegend() {
        const pal = (typeof Theme !== 'undefined' && Theme.palette)
            ? Theme.palette()
            : { primary: '#dd6b4a', ink: '#26282b', sub: '#5c6166',
                surface: 'rgba(248,249,250,0.96)', border: 'rgba(40,44,48,0.12)' };
        const isLight = (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light');
        const titleFont = isLight ? "'Newsreader', Georgia, serif" : 'inherit';
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Walking-time rings legend');
            document.body.appendChild(el);
        }
        el.style.cssText = `position:absolute;bottom:24px;right:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:10px 12px;color:${pal.ink};`
            + 'font:12px/1.4 Inter,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.18);backdrop-filter:blur(8px);';
        const rows = PRESETS.map(p => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:14px;height:14px;border-radius:3px;background:${p.color};opacity:0.85;"></span>`
            + `<span>${p.label} <span style="color:${pal.sub};">~${Math.round(radiusM(p.minutes))} m</span></span></div>`).join('');
        el.innerHTML = `<div style="font-family:${titleFont};font-weight:600;font-size:15px;margin-bottom:6px;color:${pal.primary};">15-minute city</div>${rows}`;
    }

    /** Remove the legend card from the DOM if present. */
    function _removeLegend() {
        const el = document.getElementById(LEGEND_ID);
        if (el) el.remove();
    }

    /** Hide the rings (and legend/popup); deactivate fully unless `fullyDeactivate` is false. */
    function clear(fullyDeactivate = true) {
        if (fullyDeactivate) _active = false;
        if (_popup) { _popup.remove(); _popup = null; }
        _removeLegend();
        if (_map) {
            if (_map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
            }
            if (_map.getSource(POINT_SOURCE)) {
                _map.getSource(POINT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
            }
        }
    }

    /** True while the rings are active. */
    function isVisible() { return _active; }

    return { show, clear, isVisible, radiusM };
})();

if (typeof window !== 'undefined') window.Isochrone = Isochrone;
