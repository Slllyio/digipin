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
    function _segM(a, b) {
        const dLat = (b.lat - a.lat) * RAD;
        const dLng = (b.lng - a.lng) * RAD;
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
            total += (p2.lng - p1.lng) * RAD
                * (2 + Math.sin(p1.lat * RAD) + Math.sin(p2.lat * RAD));
        }
        return Math.abs(total * R * R / 2);
    }
    function formatLength(m) {
        if (!(m > 0)) return '0 m';
        return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
    }
    function formatArea(m2) {
        if (!(m2 > 0)) return '0 m²';
        if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
        if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
        return `${Math.round(m2)} m²`;
    }

    // ---------- state + map interaction ----------
    let _active = false, _map = null, _pts = [], _cursor = null, _finished = false, _clickTimer = null;

    function _empty() { return { type: 'FeatureCollection', features: [] }; }
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
    function _redraw() {
        const s = _map && _map.getSource(SRC);
        if (s) s.setData(_features());
        _renderBox();
    }
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
    function _onMove(e) {
        if (!_active || _finished) return;
        _cursor = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        if (_pts.length) _redraw();
    }
    function _onDbl() {
        if (!_active) return;
        if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
        _finished = true;
        _cursor = null;
        _redraw();
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#0099ff', ink: '#292929', sub: '#636363',
            surface: 'rgba(255,255,255,0.96)', border: 'rgba(0,0,0,0.08)' };
    }
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
    function _removeBox() { const el = document.getElementById(BOX_ID); if (el) el.remove(); }

    function _onKey(ev) { if (ev.key === 'Escape' && _active) { _pts = []; _cursor = null; _finished = false; _redraw(); } }

    function attach() {
        _active = true;
        _pts = []; _cursor = null; _finished = false;
        _map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!_map) return;
        _ensureLayer();
        _map.on('click', _onClick);
        _map.on('mousemove', _onMove);
        _map.on('dblclick', _onDbl);
        if (_map.doubleClickZoom) _map.doubleClickZoom.disable();
        if (_map.getCanvas) _map.getCanvas().style.cursor = 'crosshair';
        if (typeof document !== 'undefined') document.addEventListener('keydown', _onKey);
        if (typeof App !== 'undefined') App.showToast('Measure', 'Click points to measure distance; close 3+ points for area.', 'info');
        _renderBox();
    }
    function detach() {
        _active = false;
        if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
        if (_map) {
            _map.off('click', _onClick);
            _map.off('mousemove', _onMove);
            _map.off('dblclick', _onDbl);
            if (_map.doubleClickZoom) _map.doubleClickZoom.enable();
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
    function toggle() { if (_active) detach(); else attach(); }
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, pathLengthM, polygonAreaM2, formatLength, formatArea };
})();

if (typeof window !== 'undefined') window.MeasureTool = MeasureTool;
