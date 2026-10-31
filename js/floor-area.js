/**
 * FloorArea — floor-area ratio (FAR, called FSI in Indian planning) for a plot
 * from building footprints and heights.
 *
 *   gross floor area = Σ footprint area × storeys
 *   FAR              = gross floor area ÷ plot area
 *   coverage         = Σ footprint area ÷ plot area
 *
 * Storeys come from the building's own floor count when it has one, else its
 * height ÷ 3.2 m (the same rule the 3D model and CAD export use). Buildings
 * with no height or floors at all count as one storey and are reported, so
 * the number is an honest lower bound rather than a silent guess.
 * A building belongs to the plot its centroid falls in, so neighbouring
 * plots never double-count a building that straddles the border.
 *
 * analyse()/areaM2()/centroid()/band() are pure (unit-tested);
 * analyseSelection() reads the selected DIGIPIN cell and the rendered map.
 */
const FloorArea = (() => {
    const RAD = Math.PI / 180;
    const M_PER_DEG_LAT = 111320;
    const STOREY_M = 3.2;

    function _mLng(lat) { return M_PER_DEG_LAT * Math.cos(lat * RAD); }

    /** Shoelace area (m²) of a lng/lat ring, projected locally at its own latitude. */
    function areaM2(ring) {
        if (!ring || ring.length < 4) return 0;
        const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        const kx = _mLng(lat0), ky = M_PER_DEG_LAT;
        let a = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
        }
        return Math.abs(a) / 2;
    }

    /** Vertex-mean centroid [lng, lat] (good enough for "which plot is it in"). */
    function centroid(ring) {
        const pts = ring.slice(0, -1);
        const n = pts.length || 1;
        return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
    }

    function _inside(c, b) {
        return c[0] >= b.west && c[0] <= b.east && c[1] >= b.south && c[1] <= b.north;
    }

    /** Storeys for one building: explicit floors, else height ÷ 3.2, else 1 (unknown). */
    function storeys(b) {
        if (b.floors > 0) return { n: Math.round(b.floors), known: true };
        if (b.height > 0) return { n: Math.max(1, Math.round(b.height / STOREY_M)), known: true };
        return { n: 1, known: false };
    }

    /**
     * FAR for `bounds` {south,north,west,east} from
     * buildings = [{ polygon:[[lng,lat]…], height, floors }].
     */
    function analyse(buildings, bounds) {
        const lat0 = (bounds.north + bounds.south) / 2;
        const plot = (bounds.north - bounds.south) * M_PER_DEG_LAT * (bounds.east - bounds.west) * _mLng(lat0);
        let footprint = 0, gfa = 0, count = 0, unknown = 0, maxStoreys = 0;
        (buildings || []).forEach(b => {
            if (!b || !b.polygon || b.polygon.length < 4) return;
            if (!_inside(centroid(b.polygon), bounds)) return;
            const a = areaM2(b.polygon);
            const s = storeys(b);
            footprint += a;
            gfa += a * s.n;
            count++;
            if (!s.known) unknown++;
            if (s.n > maxStoreys) maxStoreys = s.n;
        });
        const r1 = (x) => Math.round(x * 10) / 10;
        return {
            buildings: count,
            unknownHeight: unknown,
            plotAreaM2: Math.round(plot),
            footprintM2: Math.round(footprint),
            gfaM2: Math.round(gfa),
            far: plot > 0 ? Math.round((gfa / plot) * 100) / 100 : 0,
            coverage: plot > 0 ? Math.round((footprint / plot) * 1000) / 10 : 0,   // percent
            avgStoreys: footprint > 0 ? r1(gfa / footprint) : 0,
            maxStoreys,
        };
    }

    /** Plain-language density band for a FAR value. */
    function band(far) {
        if (far < 0.5) return 'low';
        if (far < 1.5) return 'medium';
        if (far < 3) return 'high';
        return 'very high';
    }

    /** One-line summary for the UI. */
    function summary(r) {
        if (!r.buildings) return 'No buildings found in this plot.';
        const parts = [
            `FAR ${r.far.toFixed(2)} (${band(r.far)} density)`,
            `${r.coverage}% built over`,
            `${r.gfaM2.toLocaleString()} m² floor area on ${r.plotAreaM2.toLocaleString()} m²`,
            `${r.buildings} buildings, avg ${r.avgStoreys} storeys`,
        ];
        if (r.unknownHeight) parts.push(`${r.unknownHeight} without height counted as 1 storey`);
        return parts.join(' · ');
    }

    // ── Live app ──────────────────────────────────────────────────

    /**
     * FAR for the selected DIGIPIN cell using the buildings drawn on the map.
     * Returns { error } when there is nothing to analyse yet.
     */
    function analyseSelection() {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        const code = (typeof MapModule !== 'undefined' && MapModule.getSelectedCode) ? MapModule.getSelectedCode() : null;
        if (!map || !code || typeof DigiPin === 'undefined') return { error: 'Select a DIGIPIN cell on the map first.' };
        let b;
        try { b = DigiPin.decode(code).bounds; } catch { return { error: 'Could not read the selected cell.' }; }
        const v = map.getBounds && map.getBounds();
        if (v && (v.getSouth() > b.south || v.getNorth() < b.north || v.getWest() > b.west || v.getEast() < b.east)) {
            return { error: 'Zoom so the whole selected cell is in view, with the Buildings overlay on.' };
        }
        if (typeof FootprintExport === 'undefined') return { error: 'Building footprints are unavailable.' };
        const buildings = FootprintExport.collect(map)
            .filter(f => f.geometry && f.geometry.type === 'Polygon')
            .map(f => ({ polygon: f.geometry.coordinates[0], height: f.height, floors: f.num_floors }));
        if (!buildings.length) return { error: 'Turn on the Buildings overlay and zoom in so footprints are drawn.' };
        return { code, ...analyse(buildings, b) };
    }

    return { areaM2, centroid, storeys, analyse, band, summary, analyseSelection };
})();

if (typeof window !== 'undefined') {
    window.FloorArea = FloorArea;
}
