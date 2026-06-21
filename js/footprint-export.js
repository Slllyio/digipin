/**
 * FootprintExport — Aino-style CAD export of building footprints.
 *
 * Aino exports site geometry (footprints, boundaries) as geo-referenced GeoJSON
 * and DXF for Rhino / AutoCAD / QGIS. This module collects the *visible* Overture
 * building footprints from the map (with their heights) plus the selected DIGIPIN
 * cell polygon and serialises them to:
 *   - GeoJSON — a FeatureCollection (footprints + cell), heights as properties.
 *   - DXF     — a minimal ASCII drawing (LWPOLYLINE entities, DXF R13+): one
 *               closed LWPOLYLINE per footprint on layer BUILDINGS (thickness =
 *               height for a 3D extrude in CAD), the cell polygon on layer DIGIPIN.
 *
 * Coordinates are written in lng/lat degrees (WGS84) — geo-referenced and
 * directly importable; users reproject to local metres in their CAD/GIS tool.
 *
 * toGeoJSON()/toDXF() are pure (unit-tested); collect() queries the live map.
 */
const FootprintExport = (() => {
    // Must match the layer id used by js/overture-buildings.js.
    const OVERTURE_LAYER = 'overture-buildings-layer';

    /** Normalise a raw map feature → { geometry, height, num_floors, class }. */
    function _normalize(f) {
        const p = f.properties || {};
        const height = (typeof p.height === 'number' && p.height > 0) ? p.height
            : (typeof p.num_floors === 'number' && p.num_floors > 0) ? p.num_floors * 3.2
                : 0;
        return {
            geometry: f.geometry,
            height: Math.round(height * 10) / 10,
            num_floors: p.num_floors || null,
            class: p.class || null,
        };
    }

    /**
     * Collect deduped, normalised footprints currently rendered on the map.
     * Returns [] when the buildings overlay isn't on / nothing is visible.
     */
    function collect(map) {
        if (!map || typeof map.queryRenderedFeatures !== 'function') return [];
        if (typeof map.getLayer === 'function' && !map.getLayer(OVERTURE_LAYER)) return [];
        let feats;
        try { feats = map.queryRenderedFeatures({ layers: [OVERTURE_LAYER] }); }
        catch { return []; }
        if (!feats || !feats.length) return [];

        // Overture PMTiles features lack stable ids; dedupe on first-vertex key
        // (same heuristic as overture-buildings.js getVisibleStats).
        const seen = new Set();
        const out = [];
        for (const f of feats) {
            if (!f.geometry || f.geometry.type !== 'Polygon') continue;
            const key = f.geometry.coordinates?.[0]?.[0]?.join(',');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(_normalize(f));
        }
        return out;
    }

    /** Closed lng/lat ring for the DIGIPIN cell, from its {south,north,west,east}
     *  bounds. Returns null when bounds are absent/malformed. */
    function _cellRing(cell) {
        const b = cell && cell.bounds;
        if (!b || typeof b.south !== 'number' || typeof b.west !== 'number'
            || typeof b.north !== 'number' || typeof b.east !== 'number') return null;
        return [[b.west, b.south], [b.east, b.south], [b.east, b.north],
            [b.west, b.north], [b.west, b.south]];
    }

    /** Footprints + the DIGIPIN cell as a GeoJSON FeatureCollection. */
    function toGeoJSON(features, cell) {
        const fc = { type: 'FeatureCollection', features: [] };
        for (const f of (features || [])) {
            if (!f.geometry) continue;
            fc.features.push({
                type: 'Feature',
                geometry: f.geometry,
                properties: {
                    layer: 'buildings',
                    height_m: f.height || 0,
                    num_floors: f.num_floors || null,
                    class: f.class || null,
                },
            });
        }
        const ring = _cellRing(cell);
        if (ring) {
            fc.features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [ring] },
                properties: { layer: 'digipin', code: cell.code || null },
            });
        }
        return fc;
    }

    // ---- DXF (ASCII, LWPOLYLINE — DXF R13+) --------------------------------
    // DXF is a list of group-code/value line pairs. We emit a minimal but valid
    // ENTITIES section of LWPOLYLINEs (introduced in R13) — broadly importable by
    // modern CAD/GIS tools (AutoCAD R13+, Rhino, QGIS).
    function _poly(lines, ring, layer, thickness) {
        if (!Array.isArray(ring) || ring.length < 2) return;
        lines.push('0', 'LWPOLYLINE', '8', layer, '90', String(ring.length), '70', '1');
        if (thickness > 0) lines.push('39', String(thickness));   // extrusion thickness
        for (const pt of ring) {
            lines.push('10', String(pt[0]), '20', String(pt[1]));
        }
    }

    function toDXF(features, cell) {
        const lines = ['0', 'SECTION', '2', 'ENTITIES'];
        for (const f of (features || [])) {
            const ring = f.geometry?.coordinates?.[0];
            if (ring) _poly(lines, ring, 'BUILDINGS', f.height || 0);
        }
        const ring = _cellRing(cell);
        if (ring) _poly(lines, ring, 'DIGIPIN', 0);
        lines.push('0', 'ENDSEC', '0', 'EOF');
        return lines.join('\n') + '\n';
    }

    function filename(format, code) {
        const clean = (code || 'cell').replace(/-/g, '');
        return `digipin_footprints_${clean}.${format === 'dxf' ? 'dxf' : 'geojson'}`;
    }

    /** Trigger a client-side download of a text blob. */
    function _download(text, name, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Collect + serialise + download for the given format ('geojson'|'dxf'). */
    function exportFormat(format, cell) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        const features = collect(map);
        if (!features.length) {
            if (typeof App !== 'undefined') {
                App.showToast('Footprint export', 'No buildings visible — enable the Buildings overlay and zoom in first.', 'warning');
            }
            return 0;
        }
        const name = filename(format, cell && cell.code);
        if (format === 'dxf') {
            _download(toDXF(features, cell), name, 'application/dxf');
        } else {
            _download(JSON.stringify(toGeoJSON(features, cell), null, 2), name, 'application/geo+json');
        }
        if (typeof App !== 'undefined') {
            App.showToast('Footprint export', `${features.length.toLocaleString()} building footprints exported.`, 'success');
        }
        return features.length;
    }

    /** Count of currently-exportable footprints (for the dialog summary). */
    function count() {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        return collect(map).length;
    }

    return { collect, toGeoJSON, toDXF, filename, exportFormat, count };
})();

if (typeof window !== 'undefined') {
    window.FootprintExport = FootprintExport;
}
