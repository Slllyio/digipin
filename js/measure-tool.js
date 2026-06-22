/**
 * MeasureTool — interactive distance + area measurement on the map.
 *
 * A classic site-planning tool DigiPin lacked. Click to drop vertices: the
 * running path **distance** is shown live (with a rubber-band segment to the
 * cursor), and once there are ≥3 vertices the enclosed **area** is shown too.
 * Double-click finishes; Reset / toggling the tool off clears it.
 *
 * Reuses the AreaAggregate map-interaction conventions (js/area-aggregate.js):
 * one GeoJSON source with fill/line/circle layers, `source.setData`, crosshair
 * cursor, idempotent attach/detach, listener cleanup on the stored map.
 *
 * pathLengthM / polygonAreaM2 / formatLength / formatArea are pure and
 * unit-tested; the interaction + readout are DOM/map.
 */
const MeasureTool = (() => {
    const SRC = 'measure-src';
    const FILL = 'measure-fill';
    const LINE = 'measure-line';
    const DOTS = 'measure-dots';
    const BOX_ID = 'measure-box';
    const R = 6371008.8;                 // mean Earth radius (m)
    const RAD = Math.PI / 180;

    // ---------- pure helpers ----------
    // Shortest longitude delta in radians — normalised so a segment crossing the
    // ±180° anti-meridian (e.g. 179° → −179°) measures 2°, not 358°.
    function _deltaLngRad(lng1, lng2) {
        return (((lng2 - lng1 + 540) % 360) - 180) * RAD;
    }
    /** Geodesic length (m) of a single segment between two {lat,lng} points (haversine). */
    function _segM(a, b) {
        const dLat = (b.lat - a.lat) * RAD;
        const dLng = _deltaLngRad(a.lng, b.lng);
        const s = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }
    /** Total geodesic length of a polyline through {lat,lng} points (metres). */
    function pathLengthM(points) {
        if (!points || points.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < points.length; i++) total += _segM(points[i - 1], points[i]);
        return total;
    }
    /** Spherical-excess area of a closed ring of {lat,lng} points (m²). */
    function polygonAreaM2(ring) {
        if (!ring || ring.length < 3) return 0;
        let total = 0;
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const p1 = ring[i];
            const p2 = ring[(i + 1) % n];
            total += _deltaLngRad(p1.lng, p2.lng)
                * (2 + Math.sin(p1.lat * RAD) + Math.sin(p2.lat * RAD));
        }
        return Math.abs(total * R * R / 2);
    }
    /** Human label for a metre distance (m below 1 km, else km). */
    function formatLength(m) {
        if (!(m > 0)) return '0 m';
        return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
    }
    /** Human label for an area in m² (m²/ha/km² by magnitude). */
    function formatArea(m2) {
        if (!(m2 > 0)) return '0 m²';
        if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
        if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
        return `${Math.round(m2)} m²`;
    }

    // ---------- state + map interaction ----------
    let _active = false, _map = null, _pts = [], _cursor = null, _finished = false, _clickTimer = null, _restoreDblClick = false;

    /** An empty GeoJSON FeatureCollection. */
    function _empty() { return { type: 'FeatureCollection', features: [] }; }
    /** Build the FeatureCollection (line + optional polygon + vertex points) for the current measurement. */
    function _features() {
        const feats = [];
        const line = _pts.map(p => [p.lng, p.lat]);
        if (!_finished && _cursor && _pts.length) line.push([_cursor.lng, _cursor.lat]);
        if (line.length >= 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line } });
        if (_pts.length >= 3) {
            const ring = _pts.map(p => [p.lng, p.lat]);
            ring.push([_pts[0].lng, _pts[0].lat]);
            feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } });
        }
        for (const p of _pts) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
        return { type: 'FeatureCollection', features: feats };
    }
    /** Push the current features to the map source and refresh the readout box. */
    function _redraw() {
        const s = _map && _map.getSource(SRC);
        if (s) s.setData(_features());
        _renderBox();
    }
    /** Add the measurement source + fill/line/circle layers once. */
    function _ensureLayer() {
        if (_map.getSource(SRC)) return;
        const pal = _palette();
        _map.addSource(SRC, { type: 'geojson', data: _empty() });
        _map.addLayer({ id: FILL, type: 'fill', source: SRC,
            filter: ['==', '$type', 'Polygon'],
            paint: { 'fill-color': pal.primary, 'fill-opacity': 0.12 } });
        _map.addLayer({ id: LINE, type: 'line', source: SRC,
            filter: ['==', '$type', 'LineString'],
            paint: { 'line-color': pal.primary, 'line-width': 2 } });
        _map.addLayer({ id: DOTS, type: 'circle', source: SRC,
            filter: ['==', '$type', 'Point'],
            paint: { 'circle-radius': 4, 'circle-color': pal.primary,
                'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });
    }

    /** Map click → add a vertex (deferred so a double-click can cancel it). */
    function _onClick(e) {
        if (!_active) return;
        // Defer so a double-click (finish) can cancel the second vertex add.
        if (_clickTimer) clearTimeout(_clickTimer);
        const ll = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        _clickTimer = setTimeout(() => {
            if (_finished) { _pts = []; _finished = false; }   // start a fresh run
            _pts.push(ll);
            _redraw();
        }, 220);
    }
    /** Map move → rubber-band the in-progress segment to the cursor. */
    function _onMove(e) {
        if (!_active || _finished) return;
        _cursor = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        if (_pts.length) _redraw();
    }
    /** Double-click → finish the current measurement (stop rubber-banding). */
    function _onDbl() {
        if (!_active) return;
        if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
        _finished = true;
        _cursor = null;
        _redraw();
    }

    /** Active theme palette (with light-theme fallback for tests). */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#0099ff', ink: '#292929', sub: '#636363',
            surface: 'rgba(255,255,255,0.96)', border: 'rgba(0,0,0,0.08)' };
    }
    /** Render/update the floating readout (distance, area, reset). */
    function _renderBox() {
        let el = document.getElementById(BOX_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = BOX_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Measurement');
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = 'position:absolute;top:84px;right:16px;z-index:950;min-width:180px;'
            + `background:${pal.surface};border:1px solid ${pal.border};border-radius:10px;`
            + `padding:12px 14px;color:${pal.ink};font:12px/1.6 system-ui,sans-serif;`
            + 'box-shadow:0 4px 18px rgba(0,0,0,0.22);';
        const dist = pathLengthM(_pts);
        const area = _pts.length >= 3 ? polygonAreaM2(_pts) : 0;
        const rows = _pts.length < 2
            ? `<div style="color:${pal.sub};">Click points on the map to measure.</div>`
            : `<div style="display:flex;justify-content:space-between;gap:12px;">`
                + `<span style="color:${pal.sub};">Distance</span><b>${formatLength(dist)}</b></div>`
                + (area > 0 ? `<div style="display:flex;justify-content:space-between;gap:12px;">`
                    + `<span style="color:${pal.sub};">Area</span><b>${formatArea(area)}</b></div>` : '');
        el.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:8px;color:${pal.primary};">📏 Measure</div>`
            + rows
            + `<div style="margin-top:8px;color:${pal.sub};font-size:10px;">${_pts.length >= 2 ? 'Double-click to finish · ' : ''}<button id="measure-reset" style="background:none;border:none;color:${pal.primary};cursor:pointer;padding:0;font:inherit;text-decoration:underline;">Reset</button></div>`;
        const rb = document.getElementById('measure-reset');
        if (rb) rb.onclick = () => { _pts = []; _cursor = null; _finished = false; _redraw(); };
    }
    /** Remove the readout box from the DOM. */
    function _removeBox() { const el = document.getElementById(BOX_ID); if (el) el.remove(); }

    /** Escape clears the current measurement (the tool stays active). */
    function _onKey(ev) { if (ev.key === 'Escape' && _active) { _pts = []; _cursor = null; _finished = false; _redraw(); } }

    /** Activate the tool: add layers + listeners, set the crosshair cursor. */
    function attach() {
        _pts = []; _cursor = null; _finished = false;
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) { _active = false; return; }   // only "active" once truly attached
        _map = map;
        _active = true;
        _ensureLayer();
        _map.on('click', _onClick);
        _map.on('mousemove', _onMove);
        _map.on('dblclick', _onDbl);
        // Preserve the map's prior double-click-zoom state so detach() doesn't
        // re-enable it if the page had it off to begin with.
        _restoreDblClick = false;
        if (_map.doubleClickZoom && _map.doubleClickZoom.isEnabled && _map.doubleClickZoom.isEnabled()) {
            _map.doubleClickZoom.disable();
            _restoreDblClick = true;
        }
        if (_map.getCanvas) _map.getCanvas().style.cursor = 'crosshair';
        if (typeof document !== 'undefined') document.addEventListener('keydown', _onKey);
        if (typeof App !== 'undefined') App.showToast('Measure', 'Click points to measure distance; close 3+ points for area.', 'info');
        _renderBox();
    }
    /** Deactivate the tool: remove layers/listeners, restore cursor + dbl-click zoom. */
    function detach() {
        _active = false;
        if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
        if (_map) {
            _map.off('click', _onClick);
            _map.off('mousemove', _onMove);
            _map.off('dblclick', _onDbl);
            if (_restoreDblClick && _map.doubleClickZoom) _map.doubleClickZoom.enable();
            _restoreDblClick = false;
            if (_map.getCanvas) _map.getCanvas().style.cursor = '';
            if (_map.getLayer(FILL)) _map.removeLayer(FILL);
            if (_map.getLayer(LINE)) _map.removeLayer(LINE);
            if (_map.getLayer(DOTS)) _map.removeLayer(DOTS);
            if (_map.getSource(SRC)) _map.removeSource(SRC);
            _map = null;
        }
        if (typeof document !== 'undefined') document.removeEventListener('keydown', _onKey);
        _removeBox();
    }
    /** Toggle the tool on/off. */
    function toggle() { if (_active) detach(); else attach(); }
    /** True while the measure tool is active. */
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, pathLengthM, polygonAreaM2, formatLength, formatArea };
})();

if (typeof window !== 'undefined') window.MeasureTool = MeasureTool;
