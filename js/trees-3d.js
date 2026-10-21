/**
 * Trees3D — Aino-style 3D trees in parks, woods and gardens.
 *
 * aino.world's city model is white massing dotted with soft round trees. We
 * plant them procedurally: the basemap's green landuse polygons (wood, park,
 * grass, garden…) in view are sampled on a jittered ~20 m grid, and each
 * tree is a floating octagonal canopy (fill-extrusion with a base) over a
 * thin trunk. Placement is a deterministic hash of the position, so trees
 * don't jump as you pan. Shown while the 3D buildings are on and zoom ≥ 15.
 */
const Trees3D = (() => {
    const SRC = 'trees3d-src';
    const LAYER = 'trees3d-layer';
    const MIN_ZOOM = 15;
    const MAX_TREES = 6000;
    const SPACING_M = 17;
    const GREEN_KINDS = ['wood', 'forest', 'park', 'grass', 'garden', 'meadow', 'scrub',
        'recreation_ground', 'village_green', 'nature_reserve', 'national_park', 'golf_course', 'cemetery'];
    const M_PER_DEG = 111320;

    /** Deterministic 0..1 hash of two numbers. Pure. */
    function hash01(a, b) {
        let h = Math.imul((a * 73856093) | 0, 2654435761) ^ Math.imul((b * 19349663) | 0, 40503);
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        h ^= h >>> 13;
        return ((h >>> 0) % 100000) / 100000;
    }

    /** Ray-cast point in polygon (rings: outer + holes). Pure. */
    function inPolygon(x, y, rings) {
        let inside = false;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i], [xj, yj] = ring[j];
                if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
            }
        }
        return inside;
    }

    function _polys(geom) {
        if (!geom) return [];
        if (geom.type === 'Polygon') return [geom.coordinates];
        if (geom.type === 'MultiPolygon') return geom.coordinates;
        return [];
    }

    /**
     * Tree positions inside the green polygons, within bbox [w,s,e,n].
     * A global jittered grid (anchored at 0,0) keeps positions stable. Pure.
     */
    function treePoints(geoms, bbox, spacingM = SPACING_M, cap = MAX_TREES) {
        const [w, s, e, n] = bbox;
        const lat0 = (s + n) / 2;
        const dLat = spacingM / M_PER_DEG;
        const dLng = spacingM / (M_PER_DEG * Math.cos(lat0 * Math.PI / 180));
        const out = [];
        const seen = new Set();
        for (const g of geoms) {
            for (const rings of _polys(g)) {
                let pw = Infinity, ps = Infinity, pe = -Infinity, pn = -Infinity;
                for (const [x, y] of rings[0] || []) { if (x < pw) pw = x; if (x > pe) pe = x; if (y < ps) ps = y; if (y > pn) pn = y; }
                const x0 = Math.max(pw, w), x1 = Math.min(pe, e), y0 = Math.max(ps, s), y1 = Math.min(pn, n);
                if (x0 > x1 || y0 > y1) continue;
                for (let gy = Math.floor(y0 / dLat); gy * dLat <= y1; gy++) {
                    for (let gx = Math.floor(x0 / dLng); gx * dLng <= x1; gx++) {
                        const key = gx + ',' + gy;
                        if (seen.has(key)) continue;
                        const r = hash01(gx, gy);
                        if (r < 0.18) continue;                       // clearings
                        const x = (gx + 0.15 + 0.7 * hash01(gy, gx)) * dLng;
                        const y = (gy + 0.15 + 0.7 * r) * dLat;
                        if (x < w || x > e || y < s || y > n || !inPolygon(x, y, rings)) continue;
                        seen.add(key);
                        out.push({ lng: x, lat: y, r });
                        if (out.length >= cap) return out;
                    }
                }
            }
        }
        return out;
    }

    function _octagon(lng, lat, radiusM) {
        const kx = 1 / (M_PER_DEG * Math.cos(lat * Math.PI / 180)), ky = 1 / M_PER_DEG;
        const ring = [];
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            ring.push([lng + Math.cos(a) * radiusM * kx, lat + Math.sin(a) * radiusM * ky]);
        }
        ring.push(ring[0]);
        return ring;
    }

    /** Canopy + trunk extrusion features for tree points. Pure. */
    function treeFeatures(points) {
        const feats = [];
        for (const p of points) {
            const size = 0.75 + 0.5 * p.r;                     // 0.75–1.25
            const canopyR = 3.2 * size, top = 9 * size, base = 2.6 * size;
            feats.push({ type: 'Feature', properties: { part: 'canopy', b: +base.toFixed(1), h: +top.toFixed(1), t: +(p.r * 2 % 1).toFixed(2) },
                geometry: { type: 'Polygon', coordinates: [_octagon(p.lng, p.lat, canopyR)] } });
            feats.push({ type: 'Feature', properties: { part: 'trunk', b: 0, h: +(base + 0.6).toFixed(1), t: 0 },
                geometry: { type: 'Polygon', coordinates: [_octagon(p.lng, p.lat, 0.35)] } });
        }
        return { type: 'FeatureCollection', features: feats };
    }

    function paint(light) {
        const canopy = light
            ? ['interpolate', ['linear'], ['get', 't'], 0, '#b4c6a0', 0.5, '#a7bb93', 1, '#c1d0ae']
            : ['interpolate', ['linear'], ['get', 't'], 0, '#1c5446', 0.5, '#17463b', 1, '#236152'];
        return {
            'fill-extrusion-color': ['case', ['==', ['get', 'part'], 'trunk'], light ? '#9a8f80' : '#2b3a3a', canopy],
            'fill-extrusion-base': ['get', 'b'],
            'fill-extrusion-height': ['get', 'h'],
            'fill-extrusion-opacity': light ? 0.97 : 0.85,
            'fill-extrusion-vertical-gradient': true,
        };
    }

    let _map = null, _timer = null, _bound = false, _lastKey = '';

    function _light() { return typeof Theme === 'undefined' || !Theme.get || Theme.get() === 'light'; }

    function _wanted() {
        return !!_map && typeof OvertureBuildings !== 'undefined' && OvertureBuildings.isActive && OvertureBuildings.isActive()
            && _map.getZoom() >= MIN_ZOOM;
    }

    function _greenSource() {
        const style = _map.getStyle && _map.getStyle();
        const l = style && style.layers.find(x => x.id === 'landcover' || x.id === 'park_national_park');
        return l ? { source: l.source, sourceLayer: l['source-layer'] } : null;
    }

    function _ensureLayer() {
        if (_map.getSource(SRC)) return;
        _map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        _map.addLayer({ id: LAYER, type: 'fill-extrusion', source: SRC, minzoom: MIN_ZOOM - 0.5, paint: paint(_light()) });
    }

    function refresh() {
        if (!_map) return;
        if (!_wanted()) {
            if (_map.getLayer && _map.getLayer(LAYER)) _map.setLayoutProperty(LAYER, 'visibility', 'none');
            _lastKey = '';
            return;
        }
        const gs = _greenSource();
        if (!gs) return;
        try { _ensureLayer(); } catch { return; }
        const b = _map.getBounds();
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        let feats = [];
        try { feats = _map.querySourceFeatures(gs.source, { sourceLayer: gs.sourceLayer }) || []; } catch { /* source gone */ }
        const green = feats.filter(f => GREEN_KINDS.includes(f.properties && (f.properties.kind || f.properties.class)));
        const key = bbox.map(v => v.toFixed(4)).join() + ':' + green.length;
        if (key === _lastKey) return;
        _lastKey = key;
        const pts = treePoints(green.map(f => f.geometry), bbox);
        _map.getSource(SRC).setData(treeFeatures(pts));
        _map.setLayoutProperty(LAYER, 'visibility', 'visible');
    }

    function _schedule() { clearTimeout(_timer); _timer = setTimeout(refresh, 250); }

    function attach(map) {
        if (!map || _bound) return;
        _map = map;
        _bound = true;
        map.on('moveend', _schedule);
        map.on('sourcedata', (e) => { if (e && e.isSourceLoaded && e.sourceId !== SRC) _schedule(); });
        map.on('style.load', () => { _lastKey = ''; _schedule(); });
        if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('#btn-3d, #btn-buildings, .co-btn')) setTimeout(_schedule, 600);
        }, true);
        _schedule();
    }

    function init() {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (map) attach(map);
    }

    return { init, attach, refresh, hash01, inPolygon, treePoints, treeFeatures, paint, GREEN_KINDS };
})();

if (typeof window !== 'undefined') {
    window.Trees3D = Trees3D;
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => Trees3D.init(), 0));
}
