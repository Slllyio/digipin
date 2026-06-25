/**
 * FloodBuildings — per-building flood-depth as 3D coloured extrusions.
 *
 * Renders the at-risk buildings from the precise flood model (DEM fill-spill ->
 * per-building flood depth, see guna-twin-city/analysis/build_flood_buildings.py)
 * as a MapLibre fill-extrusion layer coloured shallow-blue -> deep-red by flood
 * depth, taller where deeper. Shows the *extent* of building-level flood risk:
 * which buildings inundate, how deeply, and the aggregate count / area.
 *
 * Pitches the camera and fits to the data; detach() restores and removes the
 * layer + legend. Idempotent.
 */
const FloodBuildings = (() => {
    const SRC = 'flood-buildings-src';
    const LAYER = 'flood-buildings-layer';
    const URL = 'analysis/output/flood_buildings_guna.geojson';

    let _active = false;
    let _legend = null;
    let _prevPitch = 0;

    function _bounds(fc) {
        let minx = 180, miny = 90, maxx = -180, maxy = -90, has = false;
        for (const f of fc.features) {
            for (const ring of f.geometry.coordinates) {
                for (const [x, y] of ring) {
                    has = true;
                    if (x < minx) minx = x; if (x > maxx) maxx = x;
                    if (y < miny) miny = y; if (y > maxy) maxy = y;
                }
            }
        }
        return has ? [[minx, miny], [maxx, maxy]] : null;
    }

    function _showLegend(meta) {
        if (_legend) _legend.remove();
        const stops = ['#9ecae1', '#4292c6', '#fdae61', '#f46d43', '#a50f15'];
        // Coerce/sanitize everything interpolated into innerHTML below: numbers
        // become numbers, risk labels are stripped to [a-z0-9 _-]. The data is our
        // own committed GeoJSON, but this removes any injection vector regardless.
        const count = Number(meta.count) || 0;
        const ha = ((Number(meta.total_area_m2) || 0) / 1e4).toFixed(1);
        const maxD = Number(meta.max_depth_m) || 0;
        const byRisk = Object.entries(meta.by_risk || {})
            .map(([k, v]) => `${Number(v) || 0} ${String(k).replace(/[^a-z0-9 _-]/gi, '').replace(/_/g, ' ')}`)
            .join(' · ');
        const el = document.createElement('div');
        el.id = 'flood-buildings-legend';
        el.style.cssText = 'position:fixed;left:16px;bottom:84px;z-index:1500;background:#0b1730;' +
            'color:#e6f1ff;border:1px solid #1f6feb;border-radius:10px;padding:12px 14px;' +
            'font:12px/1.5 system-ui,Segoe UI,sans-serif;max-width:250px;box-shadow:0 8px 30px rgba(0,0,0,.55)';
        el.innerHTML =
            '<div style="font-weight:700;color:#5ad1ff;margin-bottom:6px">Building flood depth</div>' +
            '<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin-bottom:3px">' +
            stops.map((c) => `<span style="flex:1;background:${c}"></span>`).join('') + '</div>' +
            '<div style="display:flex;justify-content:space-between;color:#9fb3c8;font-size:10px">' +
            '<span>0 m</span><span>≥2 m (deep)</span></div>' +
            '<div style="margin-top:8px;border-top:1px solid #15233f;padding-top:8px">' +
            `<b>${count}</b> buildings at risk<br>` +
            `area <b>${ha} ha</b> · max depth <b>${maxD} m</b>` +
            (byRisk ? `<br>${byRisk}` : '') + '</div>' +
            '<div style="margin-top:6px;font-size:10px;color:#7f93a8">Screening-level — not validated design depth.</div>';
        document.body.appendChild(el);
        _legend = el;
    }

    async function toggle(map) {
        if (!map) return;
        if (_active) { detach(map); return; }

        let fc;
        try {
            const r = await fetch(URL);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            fc = await r.json();
        } catch (e) {
            if (typeof App !== 'undefined') {
                App.showToast('Flood-risk buildings', 'Building flood data unavailable.', 'warning');
            }
            return;
        }

        if (map.getSource(SRC)) map.getSource(SRC).setData(fc);
        else map.addSource(SRC, { type: 'geojson', data: fc });

        if (!map.getLayer(LAYER)) {
            map.addLayer({
                id: LAYER,
                type: 'fill-extrusion',
                source: SRC,
                paint: {
                    // shallow blue -> deep red by flood depth (m)
                    'fill-extrusion-color': [
                        'interpolate', ['linear'], ['get', 'flood_depth_m'],
                        0, '#9ecae1', 0.5, '#4292c6', 1.0, '#fdae61', 1.5, '#f46d43', 2.0, '#a50f15',
                    ],
                    // base height + exaggerated rise with depth so worse risk stands taller
                    'fill-extrusion-height': ['+', 6, ['*', ['coalesce', ['get', 'flood_depth_m'], 0], 10]],
                    'fill-extrusion-base': 0,
                    'fill-extrusion-opacity': 0.9,
                },
            });
        }

        _prevPitch = map.getPitch();
        const b = _bounds(fc);
        if (b) map.fitBounds(b, { padding: 70, pitch: 55, duration: 1100, maxZoom: 16.5 });
        else map.easeTo({ pitch: 55, duration: 900 });

        _showLegend(fc.metadata || { count: fc.features.length, total_area_m2: 0, max_depth_m: 0, by_risk: {} });
        _active = true;
    }

    function detach(map) {
        if (map) {
            if (map.getLayer(LAYER)) map.removeLayer(LAYER);
            if (map.getSource(SRC)) map.removeSource(SRC);
            map.easeTo({ pitch: _prevPitch || 0, duration: 600 });
        }
        if (_legend) { _legend.remove(); _legend = null; }
        _active = false;
    }

    function isActive() { return _active; }

    return { toggle, detach, isActive };
})();

if (typeof window !== 'undefined') window.FloodBuildings = FloodBuildings;
