/**
 * SunShadows — ground shadows and a time-of-day sky for the sun study.
 *
 * MapLibre's fill-extrusion lights the faces of the 3D buildings but casts no
 * shadow on the ground, so SunStudy's hour slider only shaded walls. This
 * module projects every building in view along the sun direction: the shadow
 * of a prism of height h is the convex hull of its footprint and the same
 * footprint moved h / tan(altitude) away from the sun. Those hulls draw as one
 * translucent, paper-thin extrusion under the buildings, and the sky (zenith, horizon, fog)
 * moves from day through golden hour and twilight to night with the altitude.
 *
 * offset()/hull()/shadowRing()/skyFor() are pure (unit-tested); apply()/clear()
 * touch the map. SunStudy calls apply() on every slider step and clear() when
 * its card closes; the sky goes back to the theme's (UIPolish.skySpec).
 */
const SunShadows = (() => {
    const RAD = Math.PI / 180;
    const SRC = 'sun-shadows-src';
    const LAYER = 'sun-shadows-layer';
    const MIN_ALT = 2;            // below this the shadows run to the horizon; hide them
    const MAX_LEN_M = 450;        // cap very low-sun shadows so they stay readable
    const MAX_BUILDINGS = 9000;     // nearest to the view centre win (Quality3D may lower it)
    const M_PER_DEG = 111320;

    /** Ground offset [dLng, dLat] in degrees of the shadow tip for height h (m). */
    function offset(altitude, azimuth, h, lat) {
        if (!(altitude > 0) || !(h > 0)) return [0, 0];
        const len = Math.min(MAX_LEN_M, h / Math.tan(altitude * RAD));
        const dir = (azimuth + 180) * RAD;                // shadows point away from the sun
        const north = len * Math.cos(dir), east = len * Math.sin(dir);
        return [east / (M_PER_DEG * Math.cos(lat * RAD)), north / M_PER_DEG];
    }

    /** Convex hull (monotone chain) of [x, y] points, closed ring, counter-clockwise. */
    function hull(points) {
        const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (pts.length < 3) return pts.length ? [...pts, pts[0]] : [];
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower = [], upper = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        const ring = lower.slice(0, -1).concat(upper.slice(0, -1));
        return ring.length ? [...ring, ring[0]] : [];
    }

    /** Shadow polygon ring for a footprint ring, or null when the sun is too low or the building flat. */
    function shadowRing(ring, h, altitude, azimuth) {
        if (!ring || ring.length < 3 || !(altitude >= MIN_ALT) || !(h > 0.5)) return null;
        const lat = ring[0][1];
        const [dx, dy] = offset(altitude, azimuth, h, lat);
        const pts = [];
        for (const [x, y] of ring) { pts.push([x, y], [x + dx, y + dy]); }
        const out = hull(pts);
        return out.length >= 4 ? out : null;
    }

    // Sky stops by solar altitude. Day uses the theme's own sky so nothing
    // changes at noon; the others are blended towards as the sun drops.
    const STOPS = {
        light: {
            golden: { 'sky-color': '#e9ddcb', 'horizon-color': '#f3d2b0', 'fog-color': '#f1e4d4' },
            twilight: { 'sky-color': '#b9b6c8', 'horizon-color': '#dcc3c4', 'fog-color': '#d8d3d8' },
            night: { 'sky-color': '#6d7384', 'horizon-color': '#9aa0ae', 'fog-color': '#a9adb7' },
        },
        dark: {
            golden: { 'sky-color': '#1b1d3a', 'horizon-color': '#8a4b3a', 'fog-color': '#2a1f2e' },
            twilight: { 'sky-color': '#0b1030', 'horizon-color': '#3c2c55', 'fog-color': '#121530' },
            night: { 'sky-color': '#02040c', 'horizon-color': '#0b1430', 'fog-color': '#050a18' },
        },
    };

    function _hex(c) {
        const m = /^#([0-9a-f]{6})$/i.exec(c);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function _mix(a, b, t) {
        const A = _hex(a), B = _hex(b);
        if (!A || !B) return t < 0.5 ? a : b;
        return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
    }

    /**
     * Sky spec for a solar altitude: the theme's day sky above 12°, golden
     * hour down to 0°, twilight to −6°, night below −12°. Pure.
     */
    function skyFor(altitude, theme, day) {
        const t = theme === 'dark' ? 'dark' : 'light';
        const s = STOPS[t];
        const base = { ...(day || {}) };
        const keys = ['sky-color', 'horizon-color', 'fog-color'];
        let from, to, k;
        if (altitude >= 12) return base;
        if (altitude >= 0) { from = s.golden; to = base; k = altitude / 12; }
        else if (altitude >= -6) { from = s.twilight; to = s.golden; k = (altitude + 6) / 6; }
        else if (altitude >= -12) { from = s.night; to = s.twilight; k = (altitude + 12) / 6; }
        else { from = s.night; to = s.night; k = 0; }
        const out = { ...base };
        for (const key of keys) out[key] = _mix(from[key], to[key] || from[key], k);
        return out;
    }

    // ── map side ───────────────────────────────────────────────────────────
    let _sun = null;          // { altitude, azimuth } last applied
    let _bound = null;        // map we listen to for moveend
    let _timer = 0;
    let _count = 0;           // shadows in the last draw (stats())
    let _retries = 0;         // empty draws retried while tiles load

    function _theme() {
        return (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
    }

    /** Footprints in view: the twin GeoJSON when harvested, else the Overture tiles. */
    function _buildings(map) {
        const out = [];
        const seen = new Set();
        const take = (f, h) => {
            const g = f.geometry;
            if (!g) return;
            const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
            // Tiles repeat buildings that cross their edges; key on id or first vertex.
            for (const r of rings) {
                if (!r || r.length < 3) continue;
                const key = f.id != null ? f.id + ':' + r.length : r[0][0].toFixed(6) + ',' + r[0][1].toFixed(6);
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ ring: r, h });
            }
        };
        try {
            if (map.getSource('overture-twin-source')) {
                for (const f of map.querySourceFeatures('overture-twin-source')) take(f, Number(f.properties && f.properties.h));
            }
        } catch { /* twin not built */ }
        if (!out.length) {
            try {
                if (map.getSource('overture-buildings-source')) {
                    for (const f of map.querySourceFeatures('overture-buildings-source', { sourceLayer: 'building' })) {
                        const p = f.properties || {};
                        const h = p.height != null ? Math.max(3, +p.height || 12) : p.num_floors != null ? (+p.num_floors || 3) * 3.6 : 12;
                        take(f, h);
                    }
                }
            } catch { /* tiles not loaded */ }
        }
        const cap = typeof Quality3D !== 'undefined' ? Quality3D.limits().shadows : MAX_BUILDINGS;
        if (out.length <= cap) return out;
        // Too many: keep the ones nearest the camera target, where the eye is.
        const c = map.getCenter();
        const k = Math.cos(c.lat * RAD);
        for (const b of out) { const dx = (b.ring[0][0] - c.lng) * k, dy = b.ring[0][1] - c.lat; b.d = dx * dx + dy * dy; }
        out.sort((a, b) => a.d - b.d);
        return out.slice(0, cap);
    }

    function _firstExtrusion(map) {
        const layers = (map.getStyle() && map.getStyle().layers) || [];
        const l = layers.find(x => x.type === 'fill-extrusion' && x.id !== LAYER);
        return l ? l.id : undefined;
    }

    function _draw() {
        _timer = 0;
        const map = _bound;
        if (!map || !_sun) return;
        const features = [];
        const allowed = typeof Quality3D === 'undefined' || Quality3D.limits().shadows > 0;
        if (allowed && _sun.altitude >= MIN_ALT && map.getZoom() >= 14) {
            for (const b of _buildings(map)) {
                const ring = shadowRing(b.ring, b.h, _sun.altitude, _sun.azimuth);
                if (ring) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
            }
        }
        _count = features.length;
        // Nothing to cast from yet (tiles still arriving after a fly-in or a
        // restored link, and a tilted camera may never go idle): look again.
        if (!features.length && allowed && _sun.altitude >= MIN_ALT && map.getZoom() >= 14 && _retries < 6) {
            _retries++;
            _schedule(1500);
        } else if (features.length) _retries = 0;
        const data = { type: 'FeatureCollection', features };
        try {
            const src = map.getSource(SRC);
            if (src) src.setData(data);
            else map.addSource(SRC, { type: 'geojson', data });
            // A paper-thin extrusion rather than a fill: extrusion opacity is
            // applied once for the whole layer, so overlapping shadows don't
            // stack into dark streaks, and it drapes over the terrain.
            const base = _theme() === 'light' ? 0.26 : 0.36;
            if (!map.getLayer(LAYER)) {
                map.addLayer({
                    id: LAYER, type: 'fill-extrusion', source: SRC,
                    paint: { 'fill-extrusion-color': _theme() === 'light' ? '#3a3a46' : '#000000', 'fill-extrusion-height': 0.3, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': base, 'fill-extrusion-vertical-gradient': false },
                }, _firstExtrusion(map));
            }
            // Low sun: shadows soften as well as lengthen.
            const k = Math.max(0.6, Math.min(1, _sun.altitude / 25));
            map.setPaintProperty(LAYER, 'fill-extrusion-opacity', base * k);
            map.setPaintProperty(LAYER, 'fill-extrusion-color', _theme() === 'light' ? '#3a3a46' : '#000000');
        } catch { /* style reloading */ }
    }

    function _schedule(delay) {
        if (_timer) return;
        _timer = setTimeout(_draw, delay);
    }
    const _onMove = () => { _retries = 0; _schedule(250); };

    /** Light the scene for a sun position: sky now, shadows on the next tick. */
    function apply(map, altitude, azimuth) {
        if (!map) return;
        _sun = { altitude, azimuth };
        if (_bound !== map) {
            if (_bound) _bound.off('moveend', _onMove);
            _bound = map;
            map.on('moveend', _onMove);
        }
        try {
            if (typeof map.setSky === 'function') {
                const day = (typeof UIPolish !== 'undefined' && UIPolish.skySpec) ? UIPolish.skySpec(_theme()) : {};
                map.setSky(skyFor(altitude, _theme(), day));
            }
        } catch { /* style not ready */ }
        _schedule(80);
        // Tiles still streaming in (just after a fly-to) → draw again once they settle.
        map.once('idle', _onMove);
    }

    /** Remove the shadows and give the sky back to the theme. */
    function clear(map) {
        map = map || _bound;
        if (_timer) { clearTimeout(_timer); _timer = 0; }
        _sun = null;
        if (!map) return;
        map.off('moveend', _onMove);
        _bound = null;
        try { if (map.getLayer(LAYER)) map.removeLayer(LAYER); } catch { /* gone */ }
        try { if (map.getSource(SRC)) map.removeSource(SRC); } catch { /* gone */ }
        try {
            if (typeof map.setSky === 'function' && typeof UIPolish !== 'undefined' && UIPolish.skySpec) map.setSky(UIPolish.skySpec(_theme()));
        } catch { /* style not ready */ }
    }

    if (typeof Quality3D !== 'undefined' && Quality3D.onChange) Quality3D.onChange(() => { if (_sun && _bound) _schedule(50); });

    function stats() { return { shadows: _count, active: !!_sun }; }

    return { apply, clear, stats, offset, hull, shadowRing, skyFor, LAYER, MIN_ALT, MAX_LEN_M };
})();

if (typeof window !== 'undefined') {
    window.SunShadows = SunShadows;
}
