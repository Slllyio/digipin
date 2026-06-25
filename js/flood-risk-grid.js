/**
 * FloodRiskGrid — per-cell flood-risk choropleth for planning flood-prone areas.
 *
 * Renders the ~500 m flood-risk cells from flood_risk_analysis.py
 * (guna-twin-city/analysis/build_flood_risk_cells.py -> flood_risk_cells_guna.geojson)
 * as a green -> red MapLibre fill, coloured by risk_score (0-40). Shows a
 * RAIN / WATER LEVEL / FLOOD RISK legend with the event context, so a planner can
 * see at a glance which cells are flood-prone.
 *
 * Pitches + fits to the data; detach() removes the layers + legend. Idempotent.
 */
const FloodRiskGrid = (() => {
    const SRC = 'flood-risk-grid-src';
    const FILL = 'flood-risk-grid-fill';
    const LINE = 'flood-risk-grid-line';
    const URL = 'analysis/output/flood_risk_cells_guna.geojson';

    let _active = false;
    let _legend = null;
    let _prevPitch = 0;

    // risk_score 0..40 -> green (safe) ... red (high), matching the legend bar.
    const COLOR = [
        'interpolate', ['linear'], ['coalesce', ['get', 'risk_score'], 0],
        0, '#1a9850', 10, '#a6d96a', 18, '#fee08b', 26, '#fc8d59', 34, '#f46d43', 40, '#d73027',
    ];

    function _bounds(fc) {
        let minx = 180, miny = 90, maxx = -180, maxy = -90, has = false;
        for (const f of fc.features) for (const ring of f.geometry.coordinates) for (const [x, y] of ring) {
            has = true;
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
        return has ? [[minx, miny], [maxx, maxy]] : null;
    }

    function _showLegend(meta) {
        if (_legend) _legend.remove();
        const ev = meta.event || {};
        const st = meta.stats || {};
        // Coerce everything interpolated into innerHTML to numbers.
        const rain = Number(ev.rainfall_mm) || 0;
        const peak = Number(ev.peak_intensity_mmh) || 0;
        const water = Number(ev.water_level_m) || 0;
        const high = Number(st.high) || 0;
        const mod = Number(st.moderate) || 0;
        const low = Number(st.low) || 0;
        const crit = Number(st.critical) || 0;
        const el = document.createElement('div');
        el.id = 'flood-risk-legend';
        el.style.cssText = 'position:fixed;right:16px;top:84px;z-index:1500;background:#11161f;' +
            'color:#e6f1ff;border:1px solid #2a3a52;border-radius:12px;padding:14px 16px;' +
            'font:12px/1.5 system-ui,Segoe UI,sans-serif;min-width:210px;box-shadow:0 10px 34px rgba(0,0,0,.55)';
        el.innerHTML =
            '<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:8px">' +
            `<div><div style="color:#8aa0b8;font-size:10px;letter-spacing:.5px">RAIN</div>` +
            `<div style="font-size:20px;font-weight:800">${rain}<span style="font-size:11px;color:#8aa0b8"> mm/24h</span></div></div>` +
            `<div><div style="color:#8aa0b8;font-size:10px;letter-spacing:.5px">WATER LEVEL</div>` +
            `<div style="font-size:20px;font-weight:800">${water}<span style="font-size:11px;color:#8aa0b8"> m</span></div></div></div>` +
            `<div style="color:#8aa0b8;font-size:10px;letter-spacing:.5px;margin-bottom:4px">FLOOD RISK · peak ${peak} mm/h</div>` +
            '<div style="display:flex;height:12px;border-radius:6px;overflow:hidden">' +
            '<span style="flex:1;background:#1a9850"></span><span style="flex:1;background:#a6d96a"></span>' +
            '<span style="flex:1;background:#fee08b"></span><span style="flex:1;background:#fc8d59"></span>' +
            '<span style="flex:1;background:#d73027"></span></div>' +
            '<div style="display:flex;justify-content:space-between;color:#8aa0b8;font-size:10px;margin-top:3px">' +
            '<span>low</span><span>high</span></div>' +
            '<div style="margin-top:8px;border-top:1px solid #223247;padding-top:8px;font-size:11px">' +
            (crit ? `<b style="color:#d73027">${crit}</b> critical · ` : '') +
            `<b style="color:#f46d43">${high}</b> high · <b style="color:#fee08b">${mod}</b> moderate · ` +
            `<b style="color:#a6d96a">${low}</b> low cells</div>` +
            '<div style="margin-top:6px;font-size:10px;color:#7f93a8">~555 m cells · 328 mm/24h event · screening-level</div>';
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
            if (typeof App !== 'undefined') App.showToast('Flood risk', 'Flood-risk cells unavailable.', 'warning');
            return;
        }

        if (map.getSource(SRC)) map.getSource(SRC).setData(fc);
        else map.addSource(SRC, { type: 'geojson', data: fc });

        if (!map.getLayer(FILL)) {
            map.addLayer({
                id: FILL, type: 'fill', source: SRC,
                paint: { 'fill-color': COLOR, 'fill-opacity': 0.62 },
            });
            map.addLayer({
                id: LINE, type: 'line', source: SRC,
                paint: { 'line-color': '#0b1320', 'line-width': 0.4, 'line-opacity': 0.35 },
            });
        }

        _prevPitch = map.getPitch();
        const b = _bounds(fc);
        if (b) map.fitBounds(b, { padding: 50, pitch: 45, duration: 1100 });
        else map.easeTo({ pitch: 45, duration: 900 });

        _showLegend(fc.metadata || {});
        _active = true;
    }

    function detach(map) {
        if (map) {
            if (map.getLayer(LINE)) map.removeLayer(LINE);
            if (map.getLayer(FILL)) map.removeLayer(FILL);
            if (map.getSource(SRC)) map.removeSource(SRC);
            map.easeTo({ pitch: _prevPitch || 0, duration: 600 });
        }
        if (_legend) { _legend.remove(); _legend = null; }
        _active = false;
    }

    function isActive() { return _active; }

    return { toggle, detach, isActive };
})();

if (typeof window !== 'undefined') window.FloodRiskGrid = FloodRiskGrid;
